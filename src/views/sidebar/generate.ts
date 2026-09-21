import { Notice } from "obsidian";
import { Document, Packer } from "docx";
import * as fs from "fs";

import type { MainSidebarView } from "../sidebarView";
import type { PluginSettings, HistoryEntry } from "../../types";
import { SEARCH_DEBOUNCE_MS, TOKEN_WARN_THRESHOLD, MAX_HISTORY_SNIPPET } from "../../constants";
import { EXAM_SOURCE_EXTS, isAbs, joinPath, writeFileStr, readFileStr, ensureFolder } from "../../utils/fs-utils";
import { safeName, cleanSourceText, estimateTokens, stripAnswersForExport, extractAnswersForExport } from "../../utils/text";
import { localDateStr, addDaysStr } from "../../utils/date";
import { clampEase } from "../../utils/sm2";
import { parseQuestions } from "../../utils/parse";
import { debounce } from "../../utils/debounce";
import { stripAnswerSummarySection, normalizeExamContent, fixSequentialNumbers } from "../../utils/layout";
import { buildWordParagraphs, exportPdfDirect } from "../../utils/exporter";
import { getElectronRemote } from "../../utils/electron";
import { buildGeneratePrompt, parseAITagsFromResult, validateGenerated } from "../../services/questionService";
import { buildFM, knowledgeTags } from "../../utils/frontmatter";
import { t, tf, getLanguage } from "../../i18n/index";
import { backButton, emptyState } from "./shared/ui";

export function renderFilePicker(view: MainSidebarView) {
		if (!view.innerContentEl) return;
		const el = view.innerContentEl;
		el.empty();

		backButton(el, () => { view.fpSelected.clear(); view.homeView = "default"; void view.renderHomeTab(); }, t("← 返回"));

		el.createDiv({ text: t("生成题目"), attr: { style: "font-size:21px;font-weight:bold;margin-bottom:4px;" } });
		el.createDiv({ text: t("选择vault中的文档，AI根据内容生成各类题目，生成后保存到题库"), attr: { style: "color:var(--text-muted);font-size:17px;margin-bottom:12px;" } });

		const modeRow = el.createDiv({ attr: { style: "display:flex;gap:4px;margin-bottom:12px;" } });
		const modes: { key: "current" | "folder"; label: string }[] = [
			{ key: "current", label: t("当前文件") },
			{ key: "folder", label: t("从文件夹选择") },
		];
		for (const m of modes) {
			const btn = modeRow.createEl("button", { text: m.label, attr: { style: "padding:4px 12px;border-radius:3px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:" + (view.genPickerMode === m.key ? "var(--interactive-accent);color:var(--text-on-accent);" : "var(--background-secondary);color:var(--text-muted);") } });
			btn.addEventListener("click", () => { view.genPickerMode = m.key; view.fpSelected.clear(); view.renderFilePicker(); });
		}

		if (view.genPickerMode === "current") {
			const activeFile = view.app.workspace.getActiveFile();
			const activeExt = activeFile ? activeFile.extension.toLowerCase() : "";
			if (!activeFile || (activeExt !== "md" && !EXAM_SOURCE_EXTS.includes(activeExt))) {
				emptyState(el, t("请先打开一个文档（md/txt/rtf/docx/pdf/图片）"));
			} else {
				const info = el.createDiv({ attr: { style: "padding:8px 10px;border-radius:6px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);margin-bottom:12px;font-size:17px;" } });
				info.createSpan({ text: t("当前文件：") });
				info.createSpan({ text: activeFile.path, attr: { style: "color:var(--interactive-accent);word-break:break-all;" } });
				info.createDiv({ text: view.fileSizeInfo(activeFile), attr: { style: "color:var(--text-muted);font-size:16px;margin-top:2px;line-height:1.5;" } });
				const processBtn = el.createEl("button", { text: t("📝 基于当前文件生成题目"), attr: { style: "padding:8px 20px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--interactive-accent);background:var(--interactive-accent);color:var(--text-on-accent);" } });
				processBtn.addEventListener("click", () => { void view.generateFromCurrentFile(); });
			}
		} else {
			view.loadPickerFiles();

			const infoEl = el.createDiv({ attr: { style: "color:var(--text-muted);font-size:18px;margin-bottom:6px;" } });
			infoEl.setText(view.selectInfoText(view.fpAllFiles, view.fpSelected));

			const searchInput = el.createEl("input", { attr: { type: "text", placeholder: t("搜索文件名..."), style: "width:100%;padding:6px 8px;border-radius:4px;border:1px solid var(--background-modifier-border);margin-bottom:8px;" } });

			const toolBar = el.createDiv({ attr: { style: "margin-bottom:8px;display:flex;gap:6px;" } });
			const toolBtn = (label: string, cb: () => void) => {
				const b = toolBar.createEl("button", { text: label, attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
				b.addEventListener("click", cb);
			};

			const listEl = el.createDiv({ attr: { style: "max-height:420px;overflow-y:auto;" } });
			const btnRow = el.createDiv({ attr: { style: "margin-top:12px;display:flex;gap:8px;" } });
			const confirmBtn = btnRow.createEl("button", { text: tf("📝 生成题目（{n}个）", { n: 0 }), attr: { style: "flex:1;padding:8px 16px;border-radius:4px;font-size:19px;cursor:pointer;border:1px solid var(--interactive-accent);background:var(--interactive-accent);color:var(--text-on-accent);opacity:0.5;pointer-events:none;" } });
			confirmBtn.addEventListener("click", () => {
				if (view.fpSelected.size === 0) { new Notice(t("请至少选择一个文件")); return; }
				void view.generateFromSelected();
			});
			const clearBtn = btnRow.createEl("button", { text: t("清空选择"), attr: { style: "padding:8px 16px;border-radius:4px;font-size:19px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
			clearBtn.addEventListener("click", () => { view.fpSelected.clear(); rerender(); });
			const updateConfirm = () => {
				const size = view.fpSelected.size;
				confirmBtn.setText(tf("📝 生成题目（{n}个）", { n: size }));
				confirmBtn.style.opacity = size === 0 ? "0.5" : "1";
				confirmBtn.style.pointerEvents = size === 0 ? "none" : "auto";
			};
			const rerender = () => { view.renderSelectTree(listEl, searchInput, infoEl, view.fpAllFiles, view.fpSelected, rerender, updateConfirm, view.fpExpanded); updateConfirm(); };
			toolBtn(t("全选"), () => { view.fpAllFiles.forEach(f => view.fpSelected.add(f.path)); rerender(); });
			toolBtn(t("取消全选"), () => { view.fpSelected.clear(); rerender(); });
			searchInput.addEventListener("input", debounce(() => rerender(), SEARCH_DEBOUNCE_MS));
			rerender();
		}
}

export async function generateFromCurrentFile(view: MainSidebarView) {
		const file = view.app.workspace.getActiveFile();
		const ext = file ? file.extension.toLowerCase() : "";
		if (!file || (ext !== "md" && !EXAM_SOURCE_EXTS.includes(ext))) { new Notice(t("请打开一个支持的文档（md/txt/rtf/docx/PDF/图片）")); return; }
		const text = await view.examSourceToText(file);
		if (!text || text.trim().length === 0) { new Notice(t("未能读取文件内容")); return; }
		view.startGenerate(text, file.name, file.path);
}

export async function generateFromSelected(view: MainSidebarView) {
		const chosen = view.fpAllFiles.filter(f => view.fpSelected.has(f.path));
		if (chosen.length === 0) return;
		let combined = "";
		const paths: string[] = [];
		for (const f of chosen) {
			const text = await view.examSourceToText(f);
			if (text && text.trim().length > 0) { combined += "\n\n---\n\n" + text; paths.push(f.path); }
		}
		if (paths.length === 0) { new Notice(t("所选文件均无法读取内容")); return; }
		view.startGenerate(combined.trim(), tf("{n}个文档", { n: paths.length }), paths.join(","));
}

export function loadPickerFiles(view: MainSidebarView) {
		view.fpAllFiles = view.loadSourceFiles();
		if (view.genPickerFolder) {
			const prefix = view.genPickerFolder.endsWith("/") ? view.genPickerFolder : view.genPickerFolder + "/";
			view.fpAllFiles = view.fpAllFiles.filter(f => f.path.startsWith(prefix));
		}
}

export function startGenerate(view: MainSidebarView, sourceText: string, name: string, sourcePath: string = "") {
		view.genSourceText = sourceText;
		view.genFileName = name.replace(".md", "");
		view.genSourcePath = sourcePath;
		view.genResultText = "";
		view.genCurrentTags = [];
		if (view.activeSection !== "home") view.activeSection = "home";
		view.homeView = "generate";
		void view.renderHomeTab();
}

export function renderGenerateView(view: MainSidebarView) {
		if (!view.innerContentEl) return;
		const el = view.innerContentEl;
		el.empty();

		backButton(el, () => { view.cancelAI(); view.genIsGenerating = false; view.homeView = "default"; void view.renderHomeTab(); }, t("← 返回"));

		if (view.genResultText) {
			view.genRenderResult();
			return;
		}

		el.createDiv({ text: t("题目设置"), attr: { style: "font-size:21px;font-weight:bold;margin-bottom:10px;" } });

		const cleanedText = cleanSourceText(view.genSourceText);
		const tokenEst = estimateTokens(cleanedText);
		const charCount = cleanedText.length;

		const infoEl = el.createDiv({ attr: { style: "padding:10px 14px;margin-bottom:14px;border-radius:8px;background:var(--background-secondary);font-size:18px;line-height:1.8;" } });
		infoEl.createDiv({ text: tf("当前文档：{name}", { name: view.genFileName }), attr: { style: "font-weight:600;" } });
		infoEl.createDiv({ text: tf("清洗后字符数：{n}", { n: charCount.toLocaleString() }) + tf("　预估Token：{t}", { t: tokenEst.toLocaleString() }), attr: { style: "color:var(--text-muted);" } });
		if (tokenEst > TOKEN_WARN_THRESHOLD) infoEl.createDiv({ text: t("⚠️ 内容较长，建议分段生成题目"), attr: { style: "color:var(--qg-warn);margin-top:4px;" } });

		const cfg = view.plugin.settings;
		const savedEnabled = cfg.lastEnabledTypes.split(",").filter(Boolean);
		const types: { label: string; key: keyof PluginSettings; count: number; enabled: boolean }[] = [
			{ label: t("单选题"), key: "countSingle", count: cfg.countSingle, enabled: savedEnabled.length === 0 || savedEnabled.includes("single") },
			{ label: t("多选题"), key: "countMulti", count: cfg.countMulti, enabled: savedEnabled.length === 0 || savedEnabled.includes("multi") },
			{ label: t("判断题"), key: "countJudge", count: cfg.countJudge, enabled: savedEnabled.length === 0 || savedEnabled.includes("judge") },
			{ label: t("填空题"), key: "countBlank", count: cfg.countBlank, enabled: savedEnabled.length === 0 || savedEnabled.includes("blank") },
			{ label: t("简答题"), key: "countEssay", count: cfg.countEssay, enabled: savedEnabled.length === 0 || savedEnabled.includes("essay") },
		];
		const activeTypes = types.filter(t => t.count > 0);

		if (activeTypes.length === 1) {
			const only = activeTypes[0]!;
			el.createDiv({ text: tf("题型：{label} {n} 题", { label: only.label, n: only.count }), attr: { style: "font-size:18px;margin-bottom:14px;padding:8px 12px;border-radius:6px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);" } });
		} else {
			const toggleArea = el.createDiv({ attr: { style: "display:flex;flex-direction:column;gap:6px;margin-bottom:14px;" } });
			for (const tp of types) {
				const row = toggleArea.createDiv({ attr: { style: "display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:6px;border:1px solid var(--background-modifier-border);" } });
				const cb = row.createEl("input", { attr: { type: "checkbox" } });
				cb.checked = tp.enabled;
				row.createSpan({ text: tp.label, attr: { style: "min-width:60px;font-size:18px;" } });
				const countInput = row.createEl("input", { attr: { type: "number", min: "0", max: "50", value: String(tp.count), style: "width:50px;padding:4px 6px;border-radius:4px;border:1px solid var(--background-modifier-border);text-align:center;font-size:18px;" } });
				countInput.addEventListener("change", () => { tp.count = parseInt(countInput.value) || 0; (cfg[tp.key] as number) = tp.count; });
				row.createSpan({ text: t("题"), attr: { style: "font-size:17px;color:var(--text-muted);" } });
				cb.addEventListener("change", () => { tp.enabled = cb.checked; });
			}
		}

		el.createDiv({ text: t("知识点标签（逗号分隔）："), attr: { style: "margin-bottom:4px;font-size:18px;" } });
		const tagsInput = el.createEl("input", { attr: { type: "text", placeholder: t("例如：微积分, 导数"), value: cfg.lastTags, style: "width:100%;padding:6px;margin-bottom:14px;border-radius:4px;border:1px solid var(--background-modifier-border);font-size:18px;" } });

		const autoSaveRow = el.createDiv({ attr: { style: "display:flex;align-items:center;gap:8px;margin-bottom:14px;" } });
		const autoSaveCb = autoSaveRow.createEl("input", { attr: { type: "checkbox" } });
		autoSaveCb.checked = cfg.autoSave;
		autoSaveCb.addEventListener("change", () => { cfg.autoSave = autoSaveCb.checked; });
		autoSaveRow.createSpan({ text: t("生成后自动保存到题库"), attr: { style: "font-size:18px;" } });

		const startBtn = el.createDiv({ attr: { style: "text-align:center;" } });
		const sb = startBtn.createEl("button", { text: t("开始生成"), attr: { class: "mod-cta", style: "padding:8px 24px;border-radius:4px;cursor:pointer;font-size:20px;" } });
		sb.addEventListener("click", () => {
			const enabledTypes = types.filter(t => t.enabled && t.count > 0);
			if (enabledTypes.length === 0) { new Notice(t("请至少选择一种题型且数量大于0")); return; }
			view.genCurrentTags = tagsInput.value.split(",").map(s => s.trim()).filter(Boolean);
			cfg.lastTags = tagsInput.value;
			cfg.lastEnabledTypes = types.filter(t => t.enabled).map(t => t.key.replace("count", "").toLowerCase()).join(",");
			void view.plugin.saveSettings();
			const counts: string[] = [];
			for (const t of enabledTypes) { if (t.count > 0) counts.push(t.label + t.count); }
			view.genStartGenerate(counts.join("、"));
		});
}

export function genStartGenerate(view: MainSidebarView, typeStr: string) {
		const el = view.innerContentEl;
		if (!el) return;
		el.empty();

		backButton(el, () => { view.cancelAI(); view.genIsGenerating = false; view.genResultText = ""; view.renderGenerateView(); }, t("← 返回设置"));

		const progressEl = el.createDiv({ attr: { style: "text-align:center;padding:14px;margin-bottom:10px;border-radius:8px;background:var(--background-secondary);" } });
		const spinner = progressEl.createDiv({ text: t("⏳ 正在生成试题..."), attr: { style: "font-size:20px;font-weight:600;line-height:1.6;" } });
		const subText = progressEl.createDiv({ text: t("预计需要 10-60 秒"), attr: { style: "font-size:17px;color:var(--text-muted);margin-top:4px;" } });

		const textArea = el.createEl("textarea", { attr: { style: "width:100%;height:300px;font-family:monospace;font-size:18px;line-height:1.5;" } });
		const update = (txt: string) => { view.genResultText = txt; textArea.value = txt; textArea.scrollTop = textArea.scrollHeight; };

		const btnRow = el.createDiv({ attr: { style: "margin-top:8px;display:flex;gap:6px;" } });
		const cancelBtn = btnRow.createEl("button", { text: t("⏹ 中止"), attr: { style: "padding:5px 12px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--qg-danger);background:var(--background-secondary);color:var(--qg-danger);" } });
		cancelBtn.addEventListener("click", () => { view.cancelAI(); view.genIsGenerating = false; spinner.setText(t("已中止")); subText.setText(t("已获取的内容已保留")); });

		void view.genRunGenerate(update, typeStr, spinner, subText);
}

export async function genRunGenerate(view: MainSidebarView, onChunk: (s: string) => void, typeStr: string, spinner: HTMLElement, subText: HTMLElement) {
		if (view.genIsGenerating) { new Notice(t("正在生成中，请等待完成")); return; }
		const cfg = view.plugin.settings;
		const existingTags = await view.plugin.loadExistingKnowledgeTags();
		const prompt = buildGeneratePrompt(view.genSourceText, typeStr, existingTags);
		let full = "";
		view.resetAI();
		view.genIsGenerating = true;

		try {
			full = await view.callAIWithPrompt(prompt, undefined, { system: t("你是一个出题助手，严格按照指定格式输出题目。") });

			if (!full) { onChunk(t("接口返回内容为空，请检查模型名称和接口地址配置是否正确。")); return; }

			if (!validateGenerated(full).ok) {
				onChunk(t("⚠️ 输出格式不达标，正在重试一次...\n\n"));
				full = await view.callAIWithPrompt(
					prompt + "\n\n上次输出不符合格式要求。请严格按格式重新输出：题型用 ## 开头，每题用 **编号.** 开头，答案行以「答案：」开头，多要点用 (1)(2)(3)。",
					undefined,
					{ system: t("你是一个出题助手，严格按照指定格式输出题目。") },
				);
				if (!full) { onChunk(t("重试后接口仍返回空，请检查模型与接口配置。")); return; }
			}

			const { tags: aiTags, cleanText } = parseAITagsFromResult(full);
			full = fixSequentialNumbers(cleanText);
			onChunk(full);

			const questions = parseQuestions(full);
			const gradableCount = questions.filter(q => q.type !== "essay" && q.type !== "blank").length;
			spinner.setText(t("✅ 生成完成"));
			const tagInfo = aiTags.length > 0 ? " | " + tf("知识点：{tags}", { tags: aiTags.join(", ") }) : "";
			subText.setText(tf("共解析出 {n} 题（客观题 {m} 题）", { n: questions.length, m: gradableCount }) + tagInfo + (questions.length === 0 ? " " + t("⚠️ 请检查AI输出格式") : ""));

			const entry: HistoryEntry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), timestamp: Date.now(), fileName: view.genFileName, sourceSnippet: view.genSourceText.slice(0, MAX_HISTORY_SNIPPET), resultText: full, sourcePath: view.genSourcePath };
			await view.plugin.addHistory(entry);
			if (cfg.autoSave && full) await view.genSaveToVault();
		} catch (err) {
			if ((err as Error).name === "AbortError") {
				spinner.setText(t("⚠️ 已中止"));
				subText.setText(view.aiCancelled ? t("本次生成已停止，未保存任何内容") : t("请求超时（3分钟）"));
				return;
			}
			spinner.setText(t("❌ 生成失败"));
			onChunk(tf("接口调用失败：{msg}", { msg: (err as Error).message }) + t("\n\n请检查：\n1. 接口地址\n2. API服务是否运行\n3. 模型名称"));
		} finally {
			view.genIsGenerating = false;
		}
}

export function genRenderResult(view: MainSidebarView) {
		if (!view.innerContentEl) return;
		const el = view.innerContentEl;
		el.empty();

		backButton(el, () => { view.genResultText = ""; view.renderGenerateView(); }, t("← 返回设置"));

		el.createDiv({ text: t("生成结果"), attr: { style: "font-size:20px;font-weight:bold;margin-bottom:8px;" } });
		const textArea = el.createEl("textarea", { attr: { style: "width:100%;height:300px;font-family:monospace;font-size:18px;line-height:1.5;" } });
		textArea.value = view.genResultText;
		textArea.addEventListener("input", () => { view.genResultText = textArea.value; });

		const btnRow = el.createDiv({ attr: { style: "margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;" } });
		const actBtn = (label: string, cb: () => void) => {
			const b = btnRow.createEl("button", { text: label, attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
			b.addEventListener("click", cb);
		};
		actBtn(t("导出MD"), () => { void view.genExportMd(); });
		actBtn(t("导出Word"), () => { void view.genExportWord(); });
		actBtn(t("导出PDF"), () => { void view.genExportPdf(); });
		actBtn(t("无答案版"), () => { void view.genExportNoAnswer(); });
		actBtn(t("仅答案版"), () => { void view.genExportAnswerOnly(); });

		const btnRow2 = el.createDiv({ attr: { style: "margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;" } });
		const ctaBtn = (label: string, cb: () => void) => {
			const b = btnRow2.createEl("button", { text: label, attr: { class: "mod-cta", style: "padding:5px 14px;border-radius:4px;cursor:pointer;font-size:18px;" } });
			b.addEventListener("click", cb);
		};
		ctaBtn(t("保存到知识库"), () => { void (async () => { await view.genSaveToVault(); })(); });
		actBtn(t("开始答题"), () => { if (!view.genResultText) { new Notice(t("请先生成试题")); return; } view.startAnswer(view.genResultText, view.genFileName, view.genSourcePath); });
}

export async function genSaveToVault(view: MainSidebarView) {
		if (!view.genResultText) { new Notice(t("还没有生成试题内容")); return; }
		view.resetAI();
		try {
			await ensureFolder(view.app, view.plugin.rootPath(view.plugin.settings.questionFolder));
			const dateStr = localDateStr();
			const autoTags = await view.aiSuggestTags(view.genResultText);
			const allTags = ["题目", ...view.genCurrentTags, ...autoTags.filter(t => !view.genCurrentTags.includes(t))];
			const sourceLink = view.genFileName ? "[[" + view.genFileName + "]]" : "";
			const fm = buildFM({ source: sourceLink, sourcePath: view.genSourcePath, date: dateStr, tags: allTags, nextReview: addDaysStr(dateStr, 1), interval: 1, correctCount: 0, wrongCount: 0, easeFactor: clampEase(view.plugin.settings.questionEaseFactor), repetitions: 0, lapses: 0 });
			const kTags = knowledgeTags(allTags);
			const knowledgeLinks = kTags.length > 0 ? "\n\n---\n\n**知识点：** " + kTags.map(t => "[[" + t + "]]").join(" ") + "\n" : "";
			const content = fm + normalizeExamContent(view.genResultText) + knowledgeLinks;
			const fileName = safeName(view.genFileName) + "_试题_" + dateStr + ".md";
			if (isAbs(view.plugin.rootPath(view.plugin.settings.questionFolder))) {
				const filePath = joinPath(view.plugin.rootPath(view.plugin.settings.questionFolder), fileName);
				try { writeFileStr(filePath, content); }
				catch { writeFileStr(joinPath(view.plugin.rootPath(view.plugin.settings.questionFolder), safeName(view.genFileName) + "_试题_" + Date.now() + ".md"), content); }
			} else {
				const filePath = view.plugin.rootPath(view.plugin.settings.questionFolder) + "/" + fileName;
				try { await view.app.vault.create(filePath, content); }
				catch { await view.app.vault.create(view.plugin.rootPath(view.plugin.settings.questionFolder) + "/" + safeName(view.genFileName) + "_试题_" + Date.now() + ".md", content); }
			}
			new Notice(tf("已保存到 {path}", { path: view.plugin.rootPath(view.plugin.settings.questionFolder) }));
			view.plugin.emitDataChanged();
			view.syncToKnowledgeIndex(allTags, fileName.replace(/\.md$/, ""), joinPath(view.plugin.rootPath(view.plugin.settings.questionFolder), fileName), "题目");
		} catch (err) { new Notice(tf("保存失败：{msg}", { msg: (err as Error).message })); }
}

export async function genExportMd(view: MainSidebarView) {
		try {
			if (!view.genResultText) { new Notice(t("还没有生成试题内容")); return; }
			
			const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: view.genFileName + "_试题.md", filters: [{ name: "Markdown", extensions: ["md"] }] });
			if (r.canceled || !r.filePath) return;
			const dateStr = localDateStr();
			fs.writeFileSync(r.filePath, "# " + view.genFileName + t(" 配套试题") + "\n\n> 来源：" + view.genFileName + "　|　日期：" + dateStr + "\n\n" + stripAnswerSummarySection(view.genResultText), "utf-8");
			new Notice(t("Md已保存"));
		} catch (err) { new Notice(tf("导出失败：{msg}", { msg: (err as Error).message })); }
}

export async function genExportWord(view: MainSidebarView) {
		try {
			if (!view.genResultText) { new Notice(t("还没有生成试题内容")); return; }
			
			const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: view.genFileName + "_试题.docx", filters: [{ name: "Word", extensions: ["docx"] }] });
			if (r.canceled || !r.filePath) return;
			const dateStr = localDateStr();
			const children = buildWordParagraphs(view.genResultText, view.genFileName + t(" 配套试题"), view.genFileName + " " + dateStr);
			const doc = new Document({ sections: [{ properties: {}, children }] });
			const buffer = await Packer.toBuffer(doc);
			fs.writeFileSync(r.filePath, Buffer.from(buffer));
			new Notice(t("Word已保存"));
		} catch (err) { new Notice(tf("导出失败：{msg}", { msg: (err as Error).message })); }
}

export async function genExportPdf(view: MainSidebarView) {
		try {
			if (!view.genResultText) { new Notice(t("还没有生成试题内容")); return; }
			
			const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: view.genFileName + "_试题.pdf", filters: [{ name: "PDF", extensions: ["pdf"] }] });
			if (r.canceled || !r.filePath) return;
			await exportPdfDirect(r.filePath, view.genResultText, view.genFileName + t(" 配套试题"), view.genFileName);
			new Notice(t("PDF已保存"));
		} catch (err) { new Notice(tf("导出失败：{msg}", { msg: (err as Error).message })); }
}

export async function genExportNoAnswer(view: MainSidebarView) {
		try {
			if (!view.genResultText) { new Notice(t("还没有生成试题内容")); return; }
			const noAnswerText = stripAnswersForExport(view.genResultText);
			
			const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: view.genFileName + "_试题_无答案.md", filters: [{ name: "Markdown", extensions: ["md"] }] });
			if (r.canceled || !r.filePath) return;
			const dateStr = localDateStr();
			fs.writeFileSync(r.filePath, "# " + view.genFileName + t(" 配套试题（无答案版）") + "\n\n> 来源：" + view.genFileName + "　|　日期：" + dateStr + "\n\n" + noAnswerText, "utf-8");
			new Notice(t("无答案版已保存"));
		} catch (err) { new Notice(tf("导出失败：{msg}", { msg: (err as Error).message })); }
}

export async function genExportAnswerOnly(view: MainSidebarView) {
		try {
			if (!view.genResultText) { new Notice(t("还没有生成试题内容")); return; }
			const answerText = extractAnswersForExport(view.genResultText);
			if (!answerText) { new Notice(t("没有可提取的答案")); return; }
			
			const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: view.genFileName + "_试题_仅答案.md", filters: [{ name: "Markdown", extensions: ["md"] }] });
			if (r.canceled || !r.filePath) return;
			const dateStr = localDateStr();
			fs.writeFileSync(r.filePath, "# " + view.genFileName + t(" 配套试题（仅答案版）") + "\n\n> 来源：" + view.genFileName + "　|　日期：" + dateStr + "\n\n" + answerText, "utf-8");
			new Notice(t("仅答案版已保存"));
		} catch (err) { new Notice(tf("导出失败：{msg}", { msg: (err as Error).message })); }
}

export async function generateFromWeakPoints(view: MainSidebarView) {
		const wp = await view.plugin.getWeakPoints();
		if (wp.length === 0) { new Notice(t("暂无薄弱知识点数据")); return; }
		const notes = await view.plugin.loadAllWrongNotes();
		const sources: string[] = [];
		const paths: string[] = [];
		for (const note of notes) {
			const srcName = note.sourceFile.replace(/\[\[|\]\]/g, "");
			const src = view.app.vault.getFiles().find(f => f.basename === srcName || f.name === srcName);
			if (src) { sources.push(await view.app.vault.read(src)); paths.push(src.path); }
			else if (isAbs(view.plugin.rootPath(view.plugin.settings.questionFolder))) {
				const qDir = view.plugin.rootPath(view.plugin.settings.questionFolder);
				if (fs.existsSync(qDir)) { for (const f of fs.readdirSync(qDir)) { if (f.includes(srcName) && f.endsWith(".md")) { sources.push(readFileStr(joinPath(qDir, f))); paths.push(joinPath(qDir, f)); break; } } }
			}
		}
		if (sources.length === 0) { new Notice("没有可用的源文件"); return; }
		const isEn = getLanguage() === "en";
		const weakPrompt = isEn
			? "[Question requirements - focus on the following weak knowledge points]\n" + wp.map(w => "- " + w.tag + " (wrong " + w.count + " times)").join("\n") + "\n\nFor each weak point above, write at least 2-3 questions.\n\n"
			: "【出题要求 - 请重点关注以下薄弱知识点】\n" + wp.map(w => "- " + w.tag + "（错题" + w.count + "次）").join("\n") + "\n\n对于上述薄弱知识点，每类至少出2-3题。\n\n";
		view.startGenerate(weakPrompt + sources.join("\n\n---\n\n"), t("薄弱点定向生成"), paths.join(","));
}

export function openGeneratePicker(view: MainSidebarView, folder?: string) {
		view.genPickerMode = folder ? "folder" : "current";
		view.genPickerFolder = folder ? folder.replace(/\\/g, "/") : "";
		view.fpSelected.clear();
		view.fpAllFiles = [];
		view.homeView = "filePicker";
		void view.renderHomeTab();
}
