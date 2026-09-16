import { Notice, TFile } from "obsidian";

import type { MainSidebarView } from "../sidebarView";
import { EXAM_SOURCE_EXTS, isImageFile, ensureFolder } from "../../utils/fs-utils";
import { MAX_EXAM_CHUNK_CHARS, EXAM_CHUNK_OVERLAP, SEARCH_DEBOUNCE_MS } from "../../constants";
import { debounce } from "../../utils/debounce";
import { buildFM, knowledgeTags } from "../../utils/frontmatter";
import { parseQuestions } from "../../utils/parse";
import { parseReviewIntervals, DEFAULT_QUESTION_INTERVALS } from "../../utils/review";
import { normalizeExamContent, fixSequentialNumbers } from "../../utils/layout";
import { buildExamExtractPrompt, parseAITagsFromResult, mergeExamChunks } from "../../services/questionService";
import { t, tf } from "../../i18n/index";

export async function renderExamBrowser(view: MainSidebarView) {
	if (!view.innerContentEl) return;
	if (view.homeView !== "examBrowser") return;
	const el = view.innerContentEl;
	el.empty();

	const backBtn = el.createEl("button", { text: "← 返回", attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:19px;margin-bottom:12px;" } });
	backBtn.addEventListener("click", () => { view.cancelAI(); view.examSelected.clear(); view.examStatusText = ""; view.homeView = "default"; void view.renderHomeTab(); });

	el.createDiv({ text: "AI 识别试卷", attr: { style: "font-size:21px;font-weight:bold;margin-bottom:4px;" } });
	el.createDiv({ text: "选择vault中的文档，AI自动识别并提取其中的题目，保存后进入答题模式", attr: { style: "color:var(--text-muted);font-size:17px;margin-bottom:12px;" } });

	if (view.examProcessing) {
		const statusEl = el.createDiv({ attr: { style: "text-align:center;padding:24px 0;" } });
		statusEl.createDiv({ text: "⏳", attr: { style: "font-size:28px;margin-bottom:8px;" } });
		statusEl.createDiv({ text: view.examStatusText || t("AI 正在识别题目..."), attr: { style: "color:var(--text-muted);font-size:19px;" } });
		const stopBtn = statusEl.createEl("button", { text: t("⏹ 停止"), attr: { style: "padding:6px 16px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--color-red);background:var(--background-secondary);color:var(--color-red);margin-top:12px;" } });
		stopBtn.addEventListener("click", () => view.cancelAI());
		return;
	}

	if (view.examFiles.length === 0) loadExamFiles(view);

	const modeRow = el.createDiv({ attr: { style: "display:flex;gap:4px;margin-bottom:12px;" } });
	const modes: { key: "current" | "folder"; label: string }[] = [
		{ key: "current", label: t("当前文件") },
		{ key: "folder", label: t("从文件夹选择") },
	];
	for (const m of modes) {
		const btn = modeRow.createEl("button", { text: m.label, attr: { style: "padding:4px 12px;border-radius:3px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:" + (view.examMode === m.key ? "var(--interactive-accent);color:var(--text-on-accent);" : "var(--background-secondary);color:var(--text-muted);") } });
		btn.addEventListener("click", () => { view.examMode = m.key; view.examSelected.clear(); void view.renderExamBrowser(); });
	}

	if (view.examMode === "current") {
		const activeFile = view.app.workspace.getActiveFile();
		const activeExt = activeFile ? activeFile.extension.toLowerCase() : "";
		if (!activeFile || (activeExt !== "md" && !EXAM_SOURCE_EXTS.includes(activeExt))) {
			el.createDiv({ text: t("请先打开一个试卷文件（md/txt/rtf/docx/pdf/图片）"), attr: { style: "color:var(--text-muted);text-align:center;padding:30px 0;font-size:19px;" } });
		} else {
			const info = el.createDiv({ attr: { style: "padding:8px 10px;border-radius:6px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);margin-bottom:12px;font-size:17px;" } });
			info.createSpan({ text: t("当前文件：") });
			info.createSpan({ text: activeFile.path, attr: { style: "color:var(--interactive-accent);" } });
			info.createDiv({ text: view.fileSizeInfo(activeFile), attr: { style: "color:var(--text-muted);margin-top:2px;" } });
			const processBtn = el.createEl("button", { text: t("📄 识别当前文件"), attr: { style: "padding:8px 20px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--interactive-accent);background:var(--interactive-accent);color:var(--text-on-accent);" } });
			processBtn.addEventListener("click", () => { void view.openCurrentFileExtract(); });
		}
	} else {
		const infoEl = el.createDiv({ attr: { style: "color:var(--text-muted);font-size:18px;margin-bottom:6px;" } });
		infoEl.setText(view.selectInfoText(view.examFiles, view.examSelected));

		const searchInput = el.createEl("input", { attr: { type: "text", placeholder: t("搜索文件名..."), style: "width:100%;padding:6px 8px;border-radius:4px;border:1px solid var(--background-modifier-border);margin-bottom:8px;" } });

		const toolBar = el.createDiv({ attr: { style: "margin-bottom:8px;display:flex;gap:6px;" } });
		const toolBtn = (label: string, cb: () => void) => {
			const b = toolBar.createEl("button", { text: label, attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
			b.addEventListener("click", cb);
		};

		const listEl = el.createDiv({ attr: { style: "max-height:420px;overflow-y:auto;" } });
		const btnRow = el.createDiv({ attr: { style: "margin-top:12px;display:flex;gap:8px;" } });
		const procBtn = btnRow.createEl("button", { text: tf("🔍 AI 识别题目（{n}个）", { n: 0 }), attr: { style: "flex:1;padding:8px 16px;border-radius:4px;font-size:19px;cursor:pointer;border:1px solid var(--interactive-accent);background:var(--interactive-accent);color:var(--text-on-accent);opacity:0.5;pointer-events:none;" } });
		procBtn.addEventListener("click", () => {
			if (view.examSelected.size === 0) { new Notice(t("请至少选择一个文件")); return; }
			void extractFromExamSelected(view);
		});
		const clearBtn = btnRow.createEl("button", { text: t("清空选择"), attr: { style: "padding:8px 16px;border-radius:4px;font-size:19px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
		clearBtn.addEventListener("click", () => { view.examSelected.clear(); rerender(); });
		const updateConfirm = () => {
			const size = view.examSelected.size;
			procBtn.setText(tf("🔍 AI 识别题目（{n}个）", { n: size }));
			procBtn.style.opacity = size === 0 ? "0.5" : "1";
			procBtn.style.pointerEvents = size === 0 ? "none" : "auto";
		};
		const rerender = () => { view.renderSelectTree(listEl, searchInput, infoEl, view.examFiles, view.examSelected, rerender, updateConfirm, view.examExpanded); updateConfirm(); };
		toolBtn(t("全选"), () => { view.examFiles.forEach(f => view.examSelected.add(f.path)); rerender(); });
		toolBtn(t("取消全选"), () => { view.examSelected.clear(); rerender(); });
		searchInput.addEventListener("input", debounce(() => rerender(), SEARCH_DEBOUNCE_MS));
		rerender();
	}

	if (view.examStatusText) {
		el.createDiv({ text: view.examStatusText, attr: { style: "margin-top:10px;padding:8px 10px;border-radius:6px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);font-size:17px;color:var(--text-muted);" } });
	}
}

function loadExamFiles(view: MainSidebarView) { view.examFiles = view.loadSourceFiles(); }

export async function extractFromExamSelected(view: MainSidebarView) {
	const files = view.examFiles.filter(f => view.examSelected.has(f.path));
	if (files.length === 0) return;

	view.examProcessing = true;
	view.resetAI();
	view.examStatusText = tf("准备识别 {n} 个文件...", { n: files.length });
	void view.renderExamBrowser();

	const cfg = view.plugin.settings;
	const saveFolder = view.plugin.rootPath(cfg.extractedExamFolder || "题目/识别试卷");
	await ensureFolder(view.app, saveFolder);
	const savedPaths: string[] = [];
	const savedSynced: { tags: string[]; label: string; path: string }[] = [];
	let totalQuestions = 0;

	for (let i = 0; i < files.length; i++) {
		if (view.aiCancelled) break;
		const file = files[i];
		if (!file) continue;
		view.examStatusText = tf("正在识别 ({cur}/{total}) {name}...", { cur: i + 1, total: files.length, name: file.name });
		void view.renderExamBrowser();

		try {
			const content = await view.examSourceToText(file);
			if (!content || content.trim().length === 0) continue;

			let allQuestionsText = "";
			if (isImageFile(file.name)) {
				allQuestionsText = content;
			} else {
				const chunks: string[] = [];
				if (content.length <= MAX_EXAM_CHUNK_CHARS) {
					chunks.push(content);
				} else {
					view.examStatusText = tf("正在识别 ({cur}/{total}) {name}（内容较长，分{n}段识别）...", { cur: i + 1, total: files.length, name: file.name, n: Math.ceil(content.length / MAX_EXAM_CHUNK_CHARS) });
					void view.renderExamBrowser();
					const overlap = EXAM_CHUNK_OVERLAP;
					for (let start = 0; start < content.length; start += MAX_EXAM_CHUNK_CHARS - overlap) {
						chunks.push(content.slice(start, start + MAX_EXAM_CHUNK_CHARS));
						if (start + MAX_EXAM_CHUNK_CHARS >= content.length) break;
					}
				}

			for (let ci = 0; ci < chunks.length; ci++) {
				if (view.aiCancelled) break;
				const chunk = chunks[ci]!;
				if (chunks.length > 1) {
					view.examStatusText = tf("正在识别 ({cur}/{total}) {name} - 第{s}/{e}段...", { cur: i + 1, total: files.length, name: file.name, s: ci + 1, e: chunks.length });
					void view.renderExamBrowser();
				}
				const prompt = buildExamExtractPrompt(chunk, ci + 1, chunks.length);
				const full = await view.callAIWithPrompt(prompt);
				if (full) allQuestionsText += "\n\n" + full;
			}
		}
		if (view.aiCancelled) break;
		if (!allQuestionsText.trim()) continue;

			const mergedText = mergeExamChunks(allQuestionsText);

			const questions = parseQuestions(mergedText);
			if (questions.length === 0) continue;
			totalQuestions += questions.length;

			const { cleanText } = parseAITagsFromResult(allQuestionsText);
			const aiTags = await view.aiSuggestTags(mergedText);
			const normalized = normalizeExamContent(fixSequentialNumbers(cleanText));
			const safeBase = file.basename.replace(/[<>:"/\\|?*]/g, "_");
			const savePath = saveFolder + "/" + safeBase + " - AI识别.md";
			const dateStr = new Date().toISOString().slice(0, 10);
			const allTags = ["试卷", "AI识别", ...aiTags.filter(t => t !== "试卷" && t !== "AI识别")];
			const sourceLink = "[[" + file.basename + "]]";
			const qIvls = parseReviewIntervals(view.plugin.settings.questionReviewIntervals, DEFAULT_QUESTION_INTERVALS);
			const nextReviewDate = new Date(); nextReviewDate.setDate(nextReviewDate.getDate() + qIvls[0]!);
			const fmB = buildFM({ source: sourceLink, sourcePath: file.path, date: dateStr, tags: allTags, nextReview: nextReviewDate.toISOString().slice(0, 10), interval: qIvls[0]!, correctCount: 0, wrongCount: 0 });
			const kTagsB = knowledgeTags(allTags.filter(t => t !== "试卷" && t !== "AI识别"));
			const knowledgeLinksB = kTagsB.length > 0 ? "\n\n---\n\n**知识点：** " + kTagsB.map(t => "[[" + t + "]]").join(" ") + "\n" : "";
			const saveContent = fmB + normalized + knowledgeLinksB;
			try { await view.app.vault.create(savePath, saveContent); }
			catch { await view.app.vault.create(saveFolder + "/" + safeBase + " - AI识别_" + Date.now() + ".md", saveContent); }
			savedPaths.push(savePath);
			savedSynced.push({ tags: allTags, label: safeBase, path: savePath });
		} catch (err) {
			if ((err as Error).name === "AbortError") {
				if (view.aiCancelled) break;
				view.examProcessing = false;
				view.examStatusText = t("识别超时（3分钟）");
				void view.renderExamBrowser();
				return;
			}
		}
	}

	view.examProcessing = false;
	if (view.aiCancelled) {
		view.examStatusText = t("已中止");
		void view.renderExamBrowser();
		return;
	}
	view.examStatusText = "";
	view.examSelected.clear();

	for (const item of savedSynced) view.syncToKnowledgeIndex(item.tags, item.label, item.path, "题目");
	view.plugin.emitDataChanged();

	if (savedPaths.length === 0) {
		view.examStatusText = t("所有文件均未能识别出题目");
		void view.renderExamBrowser();
		return;
	}

	if (savedPaths.length === 1 && savedPaths[0]) {
		const savedFile = view.app.vault.getAbstractFileByPath(savedPaths[0]);
		if (savedFile && savedFile instanceof TFile) {
			const content2 = await view.app.vault.read(savedFile);
			const clean2 = content2.replace(/^---[\s\S]*?---\s*/, "");
			new Notice(tf("识别完成，共 {n} 题，已保存至 {path}", { n: totalQuestions, path: savedPaths[0] }));
			view.startAnswer(clean2, savedFile.basename, savedFile.path);
			return;
		}
	}

	let combined = "";
	const paths: string[] = [];
	for (const p of savedPaths) {
		const f = view.app.vault.getAbstractFileByPath(p);
		if (f && f instanceof TFile) {
			const c = await view.app.vault.read(f);
			combined += "\n\n---\n\n" + c.replace(/^---[\s\S]*?---\s*/, "");
			paths.push(p);
		}
	}
	new Notice(tf("识别完成，共 {n} 题，已保存 {m} 个文件", { n: totalQuestions, m: savedPaths.length }));
	view.startGenerate(normalizeExamContent(combined.trim()), tf("{n}个识别试卷", { n: savedPaths.length }), paths.join(","));
}

export async function openCurrentFileExtract(view: MainSidebarView, file?: TFile) {
	const target = file ?? view.app.workspace.getActiveFile();
	const ext = target ? target.extension.toLowerCase() : "";
	if (!target || (ext !== "md" && !EXAM_SOURCE_EXTS.includes(ext))) { new Notice(t("请打开一个支持的试卷文件（md/txt/rtf/docx/pdf/图片）")); return; }

	const cfg = view.plugin.settings;
	const saveFolder = view.plugin.rootPath(cfg.extractedExamFolder || "题目/识别试卷");
	await ensureFolder(view.app, saveFolder);

	view.examProcessing = true;
	view.resetAI();
	view.examStatusText = tf("正在识别当前文件 {name}...", { name: target.name });
	view.homeView = "examBrowser";
	void view.renderHomeTab();

	try {
		const content = await view.examSourceToText(target);
		if (!content || content.trim().length === 0) { new Notice(t("未能读取文件内容")); return; }

		let allQuestionsText = "";
		if (isImageFile(target.name)) {
			allQuestionsText = content;
		} else if (content.length <= MAX_EXAM_CHUNK_CHARS) {
			const full = await view.callAIWithPrompt(buildExamExtractPrompt(content));
			if (full) allQuestionsText = full;
		} else {
			const chunks: string[] = [];
			for (let start = 0; start < content.length; start += MAX_EXAM_CHUNK_CHARS - EXAM_CHUNK_OVERLAP) {
				chunks.push(content.slice(start, start + MAX_EXAM_CHUNK_CHARS));
				if (start + MAX_EXAM_CHUNK_CHARS >= content.length) break;
			}
		for (let ci = 0; ci < chunks.length; ci++) {
			if (view.aiCancelled) break;
			view.examStatusText = tf("正在识别当前文件 {name} - 第{s}/{e}段...", { name: target.name, s: ci + 1, e: chunks.length });
			void view.renderHomeTab();
			const full = await view.callAIWithPrompt(buildExamExtractPrompt(chunks[ci]!, ci + 1, chunks.length));
			if (full) allQuestionsText += "\n\n" + full;
		}
		if (view.aiCancelled) return;
	}
	if (!allQuestionsText.trim()) { new Notice(t("未能识别出题目")); return; }

		const mergedText = mergeExamChunks(allQuestionsText);

		const questions = parseQuestions(mergedText);
		if (questions.length === 0) { new Notice(t("未能识别出题目")); return; }

		const { cleanText } = parseAITagsFromResult(allQuestionsText);
		const aiTags = await view.aiSuggestTags(mergedText);
		const normalized = normalizeExamContent(fixSequentialNumbers(cleanText));
		const safeBase = target.basename.replace(/[<>:"/\\|?*]/g, "_");
		const savePath = saveFolder + "/" + safeBase + " - AI识别.md";
		const dateStr = new Date().toISOString().slice(0, 10);
		const allTags = ["试卷", "AI识别", ...aiTags.filter(t => t !== "试卷" && t !== "AI识别")];
		const sourceLink = "[[" + target.basename + "]]";
		const qIvls = parseReviewIntervals(view.plugin.settings.questionReviewIntervals, DEFAULT_QUESTION_INTERVALS);
		const nextReviewDate = new Date(); nextReviewDate.setDate(nextReviewDate.getDate() + qIvls[0]!);
		const fm = buildFM({ source: sourceLink, sourcePath: target.path, date: dateStr, tags: allTags, nextReview: nextReviewDate.toISOString().slice(0, 10), interval: qIvls[0]!, correctCount: 0, wrongCount: 0 });
		const kTags = knowledgeTags(allTags.filter(t => t !== "试卷" && t !== "AI识别"));
		const knowledgeLinks = kTags.length > 0 ? "\n\n---\n\n**知识点：** " + kTags.map(t => "[[" + t + "]]").join(" ") + "\n" : "";
		const saveContent = fm + normalized + knowledgeLinks;
		try { await view.app.vault.create(savePath, saveContent); }
		catch { await view.app.vault.create(saveFolder + "/" + safeBase + " - AI识别_" + Date.now() + ".md", saveContent); }
		view.syncToKnowledgeIndex(aiTags, safeBase + " - AI识别", savePath, "题目");

		view.examSelected.clear();
		view.examStatusText = "";
		new Notice(tf("识别完成，共 {n} 题，已保存至 {path}", { n: questions.length, path: saveFolder }));
		view.startAnswer(normalized, target.basename + " - AI识别", savePath);
	} catch (err) {
		if ((err as Error).name === "AbortError") {
			if (view.aiCancelled) view.examStatusText = t("已中止");
		} else {
			new Notice(tf("识别失败：{msg}", { msg: (err as Error).message }));
		}
	} finally {
		view.examProcessing = false;
		if (view.homeView === "examBrowser") void view.renderHomeTab();
	}
}
