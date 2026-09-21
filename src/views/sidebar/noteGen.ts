import { Notice } from "obsidian";

import type { MainSidebarView } from "../sidebarView";
import type { WrongAnswerNote, FileMeta } from "../../types";
import { EXAM_SOURCE_EXTS, isImageFile, isAbs, ensureFolder, joinPath, writeFileStr } from "../../utils/fs-utils";
import { SEARCH_DEBOUNCE_MS } from "../../constants";
import { debounce } from "../../utils/debounce";
import { safeName } from "../../utils/text";
import { buildKnowledgeLinks } from "../../utils/frontmatter";
import { buildNotePrompt, parseNoteResult, buildNoteFrontmatter, type NoteGenSourceType } from "../../services/noteService";
import { getLanguage, t, tf } from "../../i18n/index";
import { localDateStr } from "../../utils/date";
import { clampEase } from "../../utils/sm2";
import { backButton, emptyState } from "./shared/ui";

export async function renderNoteGenView(view: MainSidebarView) {
	if (!view.innerContentEl) return;
	if (view.homeView !== "noteGen") return;
	const el = view.innerContentEl;
	el.empty();

	backButton(el, () => {
		view.cancelAI();
		if (view.noteGenMode === "preview" && view.noteGenResultText) {
			view.noteGenMode = "picker";
			void view.renderNoteGenView();
			return;
		}
		view.noteGenSelected.clear();
		view.noteGenResultText = "";
		view.noteGenIsGenerating = false;
		view.noteGenMode = "picker";
		view.homeView = "default";
		void view.renderHomeTab();
	});

	if (view.noteGenIsGenerating && view.noteGenMode === "picker") {
		const status = el.createDiv({ attr: { style: "text-align:center;padding:40px 0;font-size:18px;color:var(--text-muted);" } });
		status.createDiv({ text: t("🤖 正在批量生成笔记...") });
		status.createDiv({ text: t("点击停止可中断，已完成的笔记会被保留"), attr: { style: "font-size:15px;margin-top:8px;color:var(--text-faint);" } });
		const stopBtn = status.createEl("button", { text: t("⏹ 停止"), attr: { style: "margin-top:14px;padding:6px 18px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--qg-danger);background:var(--background-secondary);color:var(--qg-danger);" } });
		stopBtn.addEventListener("click", () => view.cancelAI());
		return;
	}

	el.createDiv({ text: t("🤖 AI生成笔记"), attr: { style: "font-size:21px;font-weight:bold;margin-bottom:4px;" } });
	el.createDiv({ text: t("AI按原文结构浓缩生成知识点笔记（标题序号原样保留、正文精华缩写），自动识别标签并存入笔记库"), attr: { style: "color:var(--text-muted);font-size:17px;margin-bottom:12px;" } });

	if (view.noteGenMode === "preview") {
		renderNoteGenPreview(view, el);
		return;
	}

	const typeRow = el.createDiv({ attr: { style: "display:flex;gap:4px;margin-bottom:12px;" } });
	const types: { key: NoteGenSourceType; label: string }[] = [
		{ key: "current", label: t("当前文件") },
		{ key: "doc", label: t("文件/文档") },
		{ key: "question", label: t("题目") },
		{ key: "wrong", label: t("错题") },
		{ key: "note", label: t("现有笔记") },
	];
	for (const tp of types) {
		const btn = typeRow.createEl("button", { text: tp.label, attr: { style: "padding:4px 10px;border-radius:3px;cursor:pointer;font-size:16px;border:1px solid var(--background-modifier-border);background:" + (view.noteGenSourceType === tp.key ? "var(--interactive-accent);color:var(--text-on-accent);" : "var(--background-secondary);color:var(--text-muted);") } });
		btn.addEventListener("click", () => { view.noteGenSourceType = tp.key; view.noteGenSelected.clear(); view.noteGenResultText = ""; void view.renderNoteGenView(); });
	}

	const listWrap = el.createDiv({});

	if (view.noteGenSourceType === "current") {
		view.noteGenFiles = [];
		const activeFile = view.app.workspace.getActiveFile();
		const activeExt = activeFile ? activeFile.extension.toLowerCase() : "";
		if (!activeFile || (activeExt !== "md" && !EXAM_SOURCE_EXTS.includes(activeExt))) {
			emptyState(listWrap, t("请先打开一个文档（md/txt/rtf/docx/pdf/图片）"));
		} else {
			const info = listWrap.createDiv({ attr: { style: "padding:8px 10px;border-radius:6px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);margin-bottom:12px;font-size:17px;" } });
			info.createSpan({ text: t("当前文件：") });
			info.createSpan({ text: activeFile.path, attr: { style: "color:var(--interactive-accent);" } });
			info.createDiv({ text: view.fileSizeInfo(activeFile), attr: { style: "color:var(--text-muted);margin-top:2px;" } });
			const genCurBtn = listWrap.createEl("button", { text: t("🤖 基于当前文件生成笔记"), attr: { style: "padding:8px 20px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--interactive-accent);background:var(--interactive-accent);color:var(--text-on-accent);" } });
			genCurBtn.addEventListener("click", () => {
				void (async () => {
					const f = view.app.workspace.getActiveFile();
					if (!f) return;
					const text = await noteSourceToText(view, f);
					if (!text || text.trim().length === 0) { new Notice(t("未能读取文件内容")); return; }
					await noteGenStartDirect(view, f.basename, text, f.path);
				})();
			});
		}
		return;
	}

	const btnRow = el.createDiv({ attr: { style: "margin-top:12px;display:flex;gap:8px;" } });
	const genBtn = btnRow.createEl("button", { text: tf("🤖 生成笔记（{n}篇）", { n: 0 }), attr: { style: "flex:1;padding:8px 16px;border-radius:4px;font-size:19px;cursor:pointer;border:1px solid var(--interactive-accent);background:var(--interactive-accent);color:var(--text-on-accent);opacity:0.5;pointer-events:none;" } });
	genBtn.addEventListener("click", () => {
		const keys = [...view.noteGenSelected];
		if (keys.length === 0) return;
		if (keys.length === 1) void noteGenGenerateOne(view, keys[0]!);
		else void noteGenGenerateBatch(view);
	});
	const clearBtn = btnRow.createEl("button", { text: t("清空选择"), attr: { style: "padding:8px 16px;border-radius:4px;font-size:19px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
	clearBtn.addEventListener("click", () => { view.noteGenSelected.clear(); void view.renderNoteGenView(); });
	const updateConfirm = () => {
		const size = view.noteGenSelected.size;
		genBtn.setText(tf("🤖 生成笔记（{n}篇）", { n: size }));
		const disabled = size === 0;
		genBtn.style.opacity = disabled ? "0.5" : "1";
		genBtn.style.pointerEvents = disabled ? "none" : "auto";
	};

	if (view.noteGenSourceType === "wrong") {
		view.noteGenWrongNotes = await view.plugin.loadAllWrongNotes();
		if (view.noteGenWrongNotes.length === 0) {
			emptyState(listWrap, t("暂无错题记录"));
		} else {
			const infoEl = listWrap.createDiv({ attr: { style: "color:var(--text-muted);font-size:18px;margin-bottom:6px;" } });
			const listEl = listWrap.createDiv({ attr: { style: "max-height:360px;overflow-y:auto;border:1px solid var(--background-modifier-border);border-radius:6px;padding:6px 8px;" } });
			for (const note of view.noteGenWrongNotes) {
				const key = note.filePath;
				const row = listEl.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;padding:4px 2px;cursor:pointer;border-radius:4px;font-size:19px;" } });
				const cb = row.createEl("input", { attr: { type: "checkbox" } });
				cb.checked = view.noteGenSelected.has(key);
				const sync = () => {
					cb.checked ? view.noteGenSelected.add(key) : view.noteGenSelected.delete(key);
					infoEl.setText(tf("共 {a} 条错题，已选 {b} 条", { a: view.noteGenWrongNotes.length, b: view.noteGenSelected.size }));
					updateConfirm();
				};
				row.createSpan({ text: (note.sourceFile || note.baseName).replace(/\[\[|\]\]/g, ""), attr: { style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" } });
				row.addEventListener("click", (e) => {
					if ((e.target as HTMLElement).tagName === "INPUT") return;
					cb.checked = !cb.checked;
					sync();
				});
				cb.addEventListener("change", sync);
			}
			infoEl.setText(tf("共 {a} 条错题，已选 {b} 条", { a: view.noteGenWrongNotes.length, b: view.noteGenSelected.size }));
		}
		view.noteGenFiles = [];
	} else {
		if (view.noteGenSourceType === "doc") view.noteGenFiles = view.loadSourceFiles();
		else if (view.noteGenSourceType === "question") view.noteGenFiles = await view.listQuestionFiles(view.plugin.rootPath(view.plugin.settings.questionFolder));
		else view.noteGenFiles = await view.listNoteViewFiles(view.plugin.rootPath(view.plugin.settings.noteViewFolder));

		const infoEl = listWrap.createDiv({ attr: { style: "color:var(--text-muted);font-size:18px;margin-bottom:6px;" } });
		const searchInput = listWrap.createEl("input", { attr: { type: "text", placeholder: t("搜索文件名..."), style: "width:100%;padding:6px 8px;border-radius:4px;border:1px solid var(--background-modifier-border);margin-bottom:8px;" } });

		const toolBar = listWrap.createDiv({ attr: { style: "margin-bottom:8px;display:flex;gap:6px;" } });
		const toolBtn = (label: string, cb: () => void) => {
			const b = toolBar.createEl("button", { text: label, attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
			b.addEventListener("click", cb);
		};

		const listEl = listWrap.createDiv({ attr: { style: "max-height:360px;overflow-y:auto;" } });
		const rerender = () => { view.renderSelectTree(listEl, searchInput, infoEl, view.noteGenFiles, view.noteGenSelected, rerender, updateConfirm, view.noteGenExpanded); updateConfirm(); };
		toolBtn(t("全选"), () => { view.noteGenFiles.forEach(f => view.noteGenSelected.add(f.path)); rerender(); });
		toolBtn(t("取消全选"), () => { view.noteGenSelected.clear(); rerender(); });
		searchInput.addEventListener("input", debounce(() => rerender(), SEARCH_DEBOUNCE_MS));
		rerender();
	}

	updateConfirm();
}

function renderNoteGenPreview(view: MainSidebarView, el: HTMLElement) {
	if (view.noteGenIsGenerating) {
		const status = el.createDiv({ attr: { style: "text-align:center;padding:40px 0;font-size:18px;color:var(--text-muted);" } });
		status.createSpan({ text: t("🤖 正在生成笔记...") });
		status.createDiv({ text: tf("根据「{name}」生成中，请稍候", { name: view.noteGenTargetName || "" }), attr: { style: "font-size:16px;margin-top:8px;color:var(--text-faint);" } });
		const stopBtn = status.createEl("button", { text: t("⏹ 停止"), attr: { style: "margin-top:14px;padding:6px 18px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--qg-danger);background:var(--background-secondary);color:var(--qg-danger);" } });
		stopBtn.addEventListener("click", () => view.cancelAI());
		return;
	}

	el.createDiv({ text: t("生成预览"), attr: { style: "font-size:20px;font-weight:bold;margin-bottom:4px;" } });
	el.createDiv({ text: tf("来源：{name}", { name: view.noteGenTargetName || "" }), attr: { style: "color:var(--text-muted);font-size:17px;margin-bottom:8px;" } });
	el.createDiv({ text: t("内容（可编辑）："), attr: { style: "font-size:18px;margin-bottom:4px;" } });
	const textArea = el.createEl("textarea", { attr: { style: "width:100%;height:300px;font-family:monospace;font-size:18px;line-height:1.5;resize:vertical;" } });
	textArea.value = view.noteGenResultText;
	textArea.addEventListener("input", () => { view.noteGenResultText = textArea.value; });

	el.createDiv({ text: t("知识点标签（可编辑）："), attr: { style: "font-size:18px;margin:8px 0 4px;" } });
	const tagsInput = el.createEl("input", { attr: { type: "text", value: view.noteGenResultTags.join(", "), placeholder: t("标签之间用逗号分隔"), style: "width:100%;padding:6px 8px;border-radius:4px;border:1px solid var(--background-modifier-border);font-size:18px;" } });
	tagsInput.addEventListener("input", () => { view.noteGenResultTags = tagsInput.value.split(/[,，、;；]/).map(s => s.trim().replace(/^#+/, "")).filter(Boolean); });

	el.createDiv({ text: t("保存后文件名：") + safeName(view.noteGenTargetName || "AI笔记") + "_笔记_日期.md", attr: { style: "color:var(--text-faint);font-size:15px;margin:8px 0;" } });

	const btnRow = el.createDiv({ attr: { style: "margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;" } });
	const cta = (label: string, cb: () => void) => {
		const b = btnRow.createEl("button", { text: label, attr: { class: "mod-cta", style: "padding:5px 14px;border-radius:4px;cursor:pointer;font-size:18px;" } });
		b.addEventListener("click", cb);
	};
	const plain = (label: string, cb: () => void) => {
		const b = btnRow.createEl("button", { text: label, attr: { style: "padding:5px 12px;border-radius:4px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
		b.addEventListener("click", cb);
	};
	cta(t("保存到笔记库"), () => { void noteGenSaveSingle(view); });
	plain(t("重新生成"), () => {
		if (view.noteGenTargetKey) void noteGenGenerateOne(view, view.noteGenTargetKey);
		else if (view.noteGenSourceText) void noteGenStartDirect(view, view.noteGenTargetName, view.noteGenSourceText, view.noteGenTargetPath);
	});
	plain(t("取消返回"), () => { view.noteGenResultText = ""; view.noteGenMode = "picker"; void view.renderNoteGenView(); });
}

function noteGenFindItem(view: MainSidebarView, key: string): { name: string; sourcePath: string; file?: FileMeta; wrongNote?: WrongAnswerNote } | null {
	if (view.noteGenSourceType === "wrong") {
		const n = view.noteGenWrongNotes.find(n => n.filePath === key);
		if (n) return { name: (n.sourceFile || n.baseName).replace(/\[\[|\]\]/g, ""), sourcePath: n.sourcePath || n.filePath, wrongNote: n };
		return null;
	}
	const f = view.noteGenFiles.find(f => f.path === key);
	if (f) return { name: f.basename, sourcePath: f.path, file: f };
	return null;
}

async function noteGenItemContent(view: MainSidebarView, item: { name: string; sourcePath: string; file?: FileMeta; wrongNote?: WrongAnswerNote }): Promise<string> {
	if (item.wrongNote) return item.wrongNote.resultText;
	if (item.file) return await noteSourceToText(view, item.file);
	return "";
}

async function noteSourceToText(view: MainSidebarView, file: FileMeta): Promise<string> {
	if (isImageFile(file.name)) {
		const b64 = await view.readFileAsBase64(file);
		new Notice(t("图片识别：请确认当前模型支持多模态（视觉）能力"));
		const prompt = getLanguage() === "en"
			? "Identify and transcribe all text in the image, preserving the original structure and order. Output only the transcription with no extra commentary."
			: "请识别并转录图片中的全部文字内容，保持原有结构与顺序，直接输出转录结果，不要任何多余说明。";
		return await view.callAIWithPrompt(prompt, [b64]);
	}
	if (file.extension === "md") {
		const text = await view.readFileText(file);
		return text.replace(/^---[\s\S]*?---\s*/, "");
	}
	return await view.examSourceToText(file);
}

export async function noteGenStartDirect(view: MainSidebarView, name: string, content: string, sourcePath: string) {
	if (view.noteGenIsGenerating) return;
	if (!content || content.trim().length === 0) { new Notice(t("内容为空，无法生成笔记")); return; }
	view.activeSection = "home";
	view.homeView = "noteGen";
	view.noteGenMode = "preview";
	view.noteGenTargetName = name;
	view.noteGenTargetPath = sourcePath;
	view.noteGenTargetKey = "";
	view.noteGenSourceText = content;
	view.noteGenResultText = "";
	view.noteGenResultTags = [];
	view.resetAI();
	view.noteGenIsGenerating = true;
	void view.render();
	try {
		const full = await view.callAIWithPrompt(buildNotePrompt(content, name));
		const { tags, body } = parseNoteResult(full || "");
		if (body) {
			view.noteGenResultText = body;
			view.noteGenResultTags = tags;
		} else {
			new Notice(t("笔记生成失败：AI返回内容为空"));
		}
	} catch (err) {
		if ((err as Error).name === "AbortError") new Notice(t("已中止"));
		else new Notice(tf("笔记生成失败：{msg}", { msg: (err as Error).message }));
	} finally {
		view.noteGenIsGenerating = false;
		if (!view.noteGenResultText) view.noteGenMode = "picker";
		void view.renderHomeTab();
	}
}

async function noteGenGenerateOne(view: MainSidebarView, key: string) {
	if (view.noteGenIsGenerating) return;
	const item = noteGenFindItem(view, key);
	if (!item) { new Notice(t("找不到所选内容")); return; }
	const content = await noteGenItemContent(view, item);
	await noteGenStartDirect(view, item.name, content, item.sourcePath);
	view.noteGenTargetKey = key;
}

async function noteGenGenerateBatch(view: MainSidebarView) {
	const keys = [...view.noteGenSelected];
	if (keys.length === 0 || view.noteGenIsGenerating) return;
	view.noteGenIsGenerating = true;
	view.resetAI();
	void view.renderNoteGenView();
	let ok = 0;
	let fail = 0;
	try {
		for (let i = 0; i < keys.length; i++) {
			if (view.aiCancelled) break;
			const key = keys[i]!;
			try {
				const item = noteGenFindItem(view, key);
				if (!item) { fail++; continue; }
				const content = await noteGenItemContent(view, item);
				if (!content || content.trim().length === 0) { fail++; new Notice(tf("内容为空，已跳过：{name}", { name: item.name })); continue; }
				const full = await view.callAIWithPrompt(buildNotePrompt(content, item.name));
				const { tags, body } = parseNoteResult(full || "");
				if (!body) { fail++; new Notice(tf("生成失败：{name}", { name: item.name })); continue; }
				const saved = await noteGenWriteNote(view, body, tags, item.name, item.sourcePath);
				if (saved) ok++; else fail++;
			} catch (err) {
				if ((err as Error).name === "AbortError") {
					if (view.aiCancelled) break;
					fail++;
					continue;
				}
				console.error("[question-generator] 批量生成笔记失败:", err);
				fail++;
			}
			new Notice(tf("笔记生成中：{cur}/{total}（成功 {ok}，失败 {fail}）", { cur: i + 1, total: keys.length, ok, fail }));
		}
		new Notice(view.aiCancelled ? tf("已中止：成功 {ok}，失败 {fail}", { ok, fail }) : tf("笔记生成完成：成功 {ok}，失败 {fail}", { ok, fail }));
	} finally {
		view.noteGenIsGenerating = false;
		if (!view.aiCancelled) view.noteGenSelected.clear();
		void view.renderNoteGenView();
	}
}

async function noteGenSaveSingle(view: MainSidebarView) {
	const body = view.noteGenResultText;
	if (!body || body.trim().length === 0) { new Notice(t("内容为空，无法保存")); return; }
	const ok = await noteGenWriteNote(view, body, view.noteGenResultTags, view.noteGenTargetName, view.noteGenTargetPath);
	if (ok) {
		new Notice(t("笔记已保存"));
		view.noteGenResultText = "";
		view.noteGenResultTags = [];
		view.noteGenTargetKey = "";
		view.noteGenSourceText = "";
		view.noteGenMode = "picker";
		view.noteGenSelected.clear();
		void view.renderNoteGenView();
	}
}

async function noteGenWriteNote(view: MainSidebarView, body: string, tags: string[], sourceName: string, sourcePath: string): Promise<boolean> {
	const folder = view.plugin.rootPath(view.plugin.settings.noteViewFolder);
	if (!folder) { new Notice(t("请先在设置中配置笔记文件夹")); return false; }
	try {
		await ensureFolder(view.app, folder);
		const dateStr = localDateStr();
		const fm = buildNoteFrontmatter(sourceName, sourcePath, tags, undefined, clampEase(view.plugin.settings.noteEaseFactor));
		const knowledgeLinks = buildKnowledgeLinks(tags);
		const content = fm + body + knowledgeLinks;
		const baseName = safeName(sourceName || "AI笔记");
		const fileName = baseName + "_笔记_" + dateStr + ".md";
		if (isAbs(folder)) {
			const filePath = joinPath(folder, fileName);
			try { writeFileStr(filePath, content); }
			catch { writeFileStr(joinPath(folder, baseName + "_笔记_" + Date.now() + ".md"), content); }
		} else {
			const filePath = folder + "/" + fileName;
			try { await view.app.vault.create(filePath, content); }
			catch { await view.app.vault.create(folder + "/" + baseName + "_笔记_" + Date.now() + ".md", content); }
		}
		view.plugin.emitDataChanged();
		view.syncToKnowledgeIndex(tags, fileName.replace(/\.md$/, ""), joinPath(folder, fileName), "笔记");
		return true;
	} catch (err) { new Notice(tf("保存失败：{msg}", { msg: (err as Error).message })); console.error("[question-generator] 保存笔记失败:", err); return false; }
}
