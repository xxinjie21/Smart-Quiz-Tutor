import type { MainSidebarView } from "../sidebarView";
import { INTERVAL_PRESETS } from "../../constants";
import { t, setLanguage } from "../../i18n/index";

/** 设置页（从 MainSidebarView 抽出；仅依赖 innerContentEl 与 plugin.settings）。 */
export function renderSettingsTab(view: MainSidebarView): void {
	if (!view.innerContentEl) return;
	const el = view.innerContentEl;
	const savedScrollTop = el.scrollTop;
	el.empty();
	const s = view.plugin.settings;

	const section = (title: string) => {
		el.createDiv({ text: title, attr: { style: "font-size:19px;font-weight:600;color:var(--text-muted);margin:14px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--background-modifier-border);" } });
	};
	const fieldRow = (label: string, minW = "70px") => {
		const row = el.createDiv({ attr: { style: "display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:18px;" } });
		row.createSpan({ text: label, attr: { style: "min-width:" + minW + ";color:var(--text-muted);" } });
		return row;
	};
	const textInput = (row: HTMLElement, value: string, onChange: (v: string) => void, placeholder?: string) => {
		const inp = row.createEl("input", { attr: { type: "text", value, style: "flex:1;padding:5px;border-radius:4px;border:1px solid var(--background-modifier-border);", placeholder: placeholder || "" } });
		inp.addEventListener("change", () => { onChange(inp.value); void view.plugin.saveSettings(); });
		return inp;
	};

	section(t("界面语言"));
	const langRow = fieldRow(t("语言"));
	const langSel = langRow.createEl("select", { attr: { style: "flex:1;padding:5px;border-radius:4px;border:1px solid var(--background-modifier-border);" } });
	langSel.createEl("option", { value: "zh", text: "中文" });
	langSel.createEl("option", { value: "en", text: "English" });
	langSel.value = s.language || "zh";
	langSel.addEventListener("change", () => {
		s.language = langSel.value as "zh" | "en";
		setLanguage(s.language);
		void view.plugin.saveSettings();
		void view.renderSettingsTab();
	});

	section(t("文件夹"));
	el.createDiv({ text: t("根文件夹下包含所有模块子文件夹，修改后需重启插件生效"), attr: { style: "color:var(--text-muted);font-size:17px;margin-bottom:8px;" } });
	textInput(fieldRow(t("根文件夹")), s.rootFolder, v => { s.rootFolder = v; }, "智学助手");
	textInput(fieldRow(t("题目文件夹")), s.questionFolder, v => { s.questionFolder = v; });
	textInput(fieldRow(t("错题文件夹")), s.wrongBookFolder, v => { s.wrongBookFolder = v; });
	textInput(fieldRow(t("笔记文件夹")), s.noteViewFolder, v => { s.noteViewFolder = v; }, "笔记");
	textInput(fieldRow(t("知识点文件夹")), s.knowledgeFolder, v => { s.knowledgeFolder = v; }, "知识点");
	textInput(fieldRow(t("转换md文件夹")), s.convertedMdFolder, v => { s.convertedMdFolder = v; }, "md文件");
	textInput(fieldRow(t("AI识别文件夹")), s.extractedExamFolder, v => { s.extractedExamFolder = v; }, "题目/识别试卷");
	textInput(fieldRow(t("排除文件夹")), s.excludeFolders, v => { s.excludeFolders = v; });
	const asRow = fieldRow("");
	const asCb = asRow.createEl("input", { attr: { type: "checkbox" } });
	asCb.checked = s.autoSave;
	asCb.addEventListener("change", () => { s.autoSave = asCb.checked; void view.plugin.saveSettings(); });
	asRow.createSpan({ text: t("生成后自动保存到题库") });
	el.createDiv({ text: t("预期目录结构：\n根文件夹/\n├─ 题目/（含 识别试卷/）\n├─ 错题/\n├─ 笔记/\n├─ 知识点/（统一索引，含相关题目/相关笔记/相关错题三段）\n└─ md文件/"), attr: { style: "color:var(--text-muted);font-size:16px;line-height:1.6;margin-top:10px;padding:10px 12px;border-radius:6px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);white-space:pre-wrap;" } });

	section(t("默认题目数量"));
	const counts = [
		{ label: t("单选题"), key: "countSingle" as const },
		{ label: t("多选题"), key: "countMulti" as const },
		{ label: t("判断题"), key: "countJudge" as const },
		{ label: t("填空题"), key: "countBlank" as const },
		{ label: t("简答题"), key: "countEssay" as const },
	];
	const countGrid = el.createDiv({ attr: { style: "display:grid;grid-template-columns:1fr 1fr;gap:6px;" } });
	for (const c of counts) {
		const row = countGrid.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;font-size:18px;" } });
		row.createSpan({ text: c.label, attr: { style: "min-width:50px;color:var(--text-muted);" } });
		const inp = row.createEl("input", { attr: { type: "number", min: "0", max: "50", value: String(s[c.key]), style: "width:50px;padding:4px;border-radius:4px;border:1px solid var(--background-modifier-border);text-align:center;" } });
		inp.addEventListener("change", () => { s[c.key] = parseInt(inp.value) || 0; void view.plugin.saveSettings(); });
		row.createSpan({ text: t("题"), attr: { style: "color:var(--text-muted);" } });
	}

	section(t("API 配置"));
	const apiTypeRow = fieldRow(t("接口类型"));
	const apiTypeSel = apiTypeRow.createEl("select", { attr: { style: "flex:1;padding:5px;border-radius:4px;border:1px solid var(--background-modifier-border);" } });
	apiTypeSel.createEl("option", { value: "ollama", text: "Ollama" });
	apiTypeSel.createEl("option", { value: "openai", text: t("OpenAI兼容") });
	apiTypeSel.value = s.apiType;
	apiTypeSel.addEventListener("change", () => { s.apiType = apiTypeSel.value as "ollama" | "openai"; void view.plugin.saveSettings(); });
	textInput(fieldRow(t("接口地址")), s.baseUrl, v => { s.baseUrl = v; });
	textInput(fieldRow(t("模型名称")), s.modelName, v => { s.modelName = v; });
	textInput(fieldRow(t("API Key")), s.apiKey || "", v => { s.apiKey = v; });
	const tempRow = fieldRow("Temperature");
	const tempInput = tempRow.createEl("input", { attr: { type: "number", min: "0", max: "2", step: "0.1", value: String(s.temperature), style: "width:60px;padding:5px;border-radius:4px;border:1px solid var(--background-modifier-border);text-align:center;" } });
	tempInput.addEventListener("change", () => { s.temperature = parseFloat(tempInput.value) || 0.1; void view.plugin.saveSettings(); });
	tempRow.createSpan({ text: String(s.temperature), attr: { id: "pg-temp-val", style: "color:var(--text-muted);min-width:30px;" } });
	tempInput.addEventListener("input", () => { const v = tempRow.querySelector("#pg-temp-val"); if (v) v.textContent = tempInput.value; });

	section(t("复习间隔设置"));
	el.createDiv({ text: t("参数越大复习间隔越长，记忆越牢固但可能遗忘；参数越小复习越频繁，短期效果好但耗时多。推荐使用默认值。"), attr: { style: "color:var(--text-muted);font-size:17px;margin-bottom:10px;line-height:1.5;padding:8px 10px;border-radius:6px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);" } });

	const renderIntervalRow = (label: string, currentValue: string, presetKey: string, onChange: (v: string) => void) => {
		const row = el.createDiv({ attr: { style: "margin-bottom:14px;padding:10px;border-radius:6px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);" } });
		row.createDiv({ text: label, attr: { style: "font-size:18px;font-weight:600;margin-bottom:6px;" } });
		const presets = INTERVAL_PRESETS[presetKey]!;
		const btnRow = row.createDiv({ attr: { style: "display:flex;gap:4px;margin-bottom:6px;" } });
		const currentPreset = presets.find(p => p.values === currentValue);
		for (const p of presets) {
			const isActive = p.values === currentValue;
			const btn = btnRow.createEl("button", { text: t(p.label), cls: isActive ? "qg-interval-active" : undefined, attr: { style: "padding:3px 10px;border-radius:3px;cursor:pointer;font-size:16px;border:1px solid var(--background-modifier-border);" + (isActive ? "" : "background:var(--background-primary);color:var(--text-muted);") } });
			btn.addEventListener("click", () => { onChange(p.values); void view.plugin.saveSettings(); row.parentElement && view.renderSettingsTab(); });
		}
		const activePreset = currentPreset || presets[1]!;
		const tipRow = row.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:16px;color:var(--text-muted);" } });
		tipRow.createSpan({ text: "💡", attr: { style: "font-size:14px;" } });
		tipRow.createSpan({ text: t(activePreset.hint) });
		const customRow = row.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;" } });
		customRow.createSpan({ text: t("自定义："), attr: { style: "font-size:16px;color:var(--text-muted);flex-shrink:0;" } });
		const inp = customRow.createEl("input", { attr: { type: "text", value: currentValue, style: "flex:1;padding:4px 6px;border-radius:4px;border:1px solid var(--background-modifier-border);font-size:16px;font-family:monospace;", placeholder: t("如 1,2,4,7,15,30") } });
		inp.addEventListener("change", () => { onChange(inp.value); void view.plugin.saveSettings(); });
	};

	renderIntervalRow(t("错题复习间隔（天）"), s.wrongReviewIntervals, "wrong", v => { s.wrongReviewIntervals = v; });
	renderIntervalRow(t("题目复习间隔（天）"), s.questionReviewIntervals, "question", v => { s.questionReviewIntervals = v; });
	renderIntervalRow(t("笔记复习间隔（天）"), s.noteReviewIntervals, "note", v => { s.noteReviewIntervals = v; });
	section(t("学习设置"));
	const wpRow = fieldRow(t("薄弱点阈值"));
	const wpInput = wpRow.createEl("input", { attr: { type: "number", min: "1", max: "20", value: String(s.weakPointThreshold), style: "width:60px;padding:5px;border-radius:4px;border:1px solid var(--background-modifier-border);text-align:center;" } });
	wpInput.addEventListener("change", () => { s.weakPointThreshold = parseInt(wpInput.value) || 2; void view.plugin.saveSettings(); });
	wpRow.createSpan({ text: t("次以上错题标记为薄弱"), attr: { style: "color:var(--text-muted);" } });
	const rrRow = fieldRow("");
	const rrCb = rrRow.createEl("input", { attr: { type: "checkbox" } });
	rrCb.checked = s.autoReviewReminder;
	rrCb.addEventListener("change", () => { s.autoReviewReminder = rrCb.checked; void view.plugin.saveSettings(); });
	rrRow.createSpan({ text: t("启动时提醒复习") });

	window.requestAnimationFrame(() => { el.scrollTop = savedScrollTop; });
}
