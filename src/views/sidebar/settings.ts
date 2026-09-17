import type { MainSidebarView } from "../sidebarView";
import { INTERVAL_PRESETS } from "../../constants";
import { t, setLanguage } from "../../i18n/index";

/** 设置页（侧边栏内自绘；从 MainSidebarView 抽出）。 */
export function renderSettingsTab(view: MainSidebarView): void {
	if (!view.innerContentEl) return;
	const el = view.innerContentEl;
	const savedScrollTop = el.scrollTop;
	el.empty();
	const s = view.plugin.settings;

	// ---- 构建助手 ----
	const card = (title?: string) => {
		const c = el.createDiv({ cls: "qg-settings-card" });
		if (title) c.createDiv({ text: title, cls: "qg-section-heading" });
		return c;
	};
	const field = (label: string) => {
		const row = el.createDiv({ cls: "qg-field-row" });
		if (label) row.createSpan({ text: label, cls: "qg-field-label" });
		return row;
	};
	const textInput = (row: HTMLElement, value: string, onChange: (v: string) => void, placeholder?: string) => {
		const inp = row.createEl("input", { attr: { type: "text", value, placeholder: placeholder || "" } });
		inp.addClass("qg-field-input");
		inp.addEventListener("change", () => { onChange(inp.value); void view.plugin.saveSettings(); });
		return inp;
	};
	const numberInput = (row: HTMLElement, value: string, onChange: (v: string) => void, attrs: Record<string, string> = {}) => {
		const inp = row.createEl("input", { attr: { type: "number", value: String(value), ...attrs } });
		inp.addClass("qg-field-input qg-num-input");
		inp.addEventListener("change", () => { onChange(inp.value); void view.plugin.saveSettings(); });
		return inp;
	};
	const selectInput = (row: HTMLElement, value: string, onChange: (v: string) => void) => {
		const sel = row.createEl("select", { cls: "qg-field-input" });
		sel.value = value;
		sel.addEventListener("change", () => { onChange(sel.value); void view.plugin.saveSettings(); });
		return sel;
	};
	const checkboxRow = (label: string, checked: boolean, onChange: (v: boolean) => void) => {
		const row = el.createDiv({ cls: "qg-field-row" });
		const cb = row.createEl("input", { attr: { type: "checkbox" } });
		cb.checked = checked;
		cb.addEventListener("change", () => { onChange(cb.checked); void view.plugin.saveSettings(); });
		row.createSpan({ text: label, cls: "qg-field-check-label" });
		return row;
	};
	const hint = (text: string) => el.createDiv({ text, cls: "qg-callout" });

	// ---- 界面语言 ----
	let c = card(t("界面语言"));
	{
		const row = field(t("语言"));
		const sel = selectInput(row, s.language || "zh", v => {
			s.language = v as "zh" | "en";
			setLanguage(s.language);
			void view.renderSettingsTab();
		});
		sel.createEl("option", { value: "zh", text: "中文" });
		sel.createEl("option", { value: "en", text: "English" });
	}

	// ---- 显示（字号） ----
	c = card(t("显示"));
	{
		const row = field(t("侧边栏字号"));
		const z = s.sidebarZoom || 1;
		const val = row.createSpan({ text: Math.round(z * 100) + "%", cls: "qg-zoom-val" });
		row.createDiv({ attr: { style: "flex:1;" } });
		const mk = (txt: string, delta: number, lbl: string) => {
			const b = row.createEl("button", { text: txt, cls: "qg-zoom-btn", attr: { title: lbl, "aria-label": lbl } });
			b.addEventListener("click", () => { view.adjustZoom(delta); val.setText(Math.round((s.sidebarZoom || 1) * 100) + "%"); });
			return b;
		};
		mk("A−", -0.05, t("缩小字号"));
		mk("A+", 0.05, t("放大字号"));
		row.createEl("button", { text: t("复位"), cls: "qg-zoom-btn", attr: { title: t("字号复位") } })
			.addEventListener("click", () => { view.adjustZoom(1 - (s.sidebarZoom || 1)); val.setText("100%"); });
	}

	// ---- 文件夹 ----
	c = card(t("文件夹"));
	{
		textInput(field(t("根文件夹")), s.rootFolder, v => { s.rootFolder = v; }, "智学助手");
		textInput(field(t("题目文件夹")), s.questionFolder, v => { s.questionFolder = v; });
		textInput(field(t("错题文件夹")), s.wrongBookFolder, v => { s.wrongBookFolder = v; });
		textInput(field(t("笔记文件夹")), s.noteViewFolder, v => { s.noteViewFolder = v; }, "笔记");
		textInput(field(t("知识点文件夹")), s.knowledgeFolder, v => { s.knowledgeFolder = v; }, "知识点");
		textInput(field(t("转换md文件夹")), s.convertedMdFolder, v => { s.convertedMdFolder = v; }, "md文件");
		textInput(field(t("AI识别文件夹")), s.extractedExamFolder, v => { s.extractedExamFolder = v; }, "题目/识别试卷");
		textInput(field(t("排除文件夹")), s.excludeFolders, v => { s.excludeFolders = v; });
		checkboxRow(t("生成后自动保存到题库"), s.autoSave, v => { s.autoSave = v; });
		hint(t("预期目录结构：\n根文件夹/\n├─ 题目/（含 识别试卷/）\n├─ 错题/\n├─ 笔记/\n├─ 知识点/（统一索引，含相关题目/相关笔记/相关错题三段）\n└─ md文件/"));
	}

	// ---- 默认题目数量 ----
	c = card(t("默认题目数量"));
	{
		const grid = c.createDiv({ cls: "qg-settings-grid" });
		const counts: { label: string; key: "countSingle" | "countMulti" | "countJudge" | "countBlank" | "countEssay" }[] = [
			{ label: t("单选题"), key: "countSingle" },
			{ label: t("多选题"), key: "countMulti" },
			{ label: t("判断题"), key: "countJudge" },
			{ label: t("填空题"), key: "countBlank" },
			{ label: t("简答题"), key: "countEssay" },
		];
		for (const item of counts) {
			const row = grid.createDiv({ cls: "qg-field-row" });
			row.createSpan({ text: item.label, cls: "qg-field-label" });
			numberInput(row, String(s[item.key]), v => { s[item.key] = parseInt(v) || 0; }, { min: "0", max: "50" });
			row.createSpan({ text: t("题"), cls: "qg-field-suffix" });
		}
	}

	// ---- API 配置 ----
	c = card(t("API 配置"));
	{
		const row = field(t("接口类型"));
		const sel = selectInput(row, s.apiType, v => { s.apiType = v as "ollama" | "openai"; });
		sel.createEl("option", { value: "ollama", text: "Ollama" });
		sel.createEl("option", { value: "openai", text: t("OpenAI兼容") });
		textInput(field(t("接口地址")), s.baseUrl, v => { s.baseUrl = v; });
		textInput(field(t("模型名称")), s.modelName, v => { s.modelName = v; });
		textInput(field(t("API Key")), s.apiKey || "", v => { s.apiKey = v; });
		const tempRow = field("Temperature");
		numberInput(tempRow, String(s.temperature), v => { s.temperature = parseFloat(v) || 0.1; }, { min: "0", max: "2", step: "0.1" });
		tempRow.createSpan({ text: String(s.temperature), cls: "qg-field-suffix" });
	}

	// ---- 复习间隔设置 ----
	c = card(t("复习间隔设置"));
	{
		hint(t("参数越大复习间隔越长，记忆越牢固但可能遗忘。推荐使用默认值。"));
		const intervalConfigs: { label: string; key: "wrongReviewIntervals" | "questionReviewIntervals" | "noteReviewIntervals"; presetKey: string }[] = [
			{ label: t("错题复习间隔（天）"), key: "wrongReviewIntervals", presetKey: "wrong" },
			{ label: t("题目复习间隔（天）"), key: "questionReviewIntervals", presetKey: "question" },
			{ label: t("笔记复习间隔（天）"), key: "noteReviewIntervals", presetKey: "note" },
		];
		for (const cfg of intervalConfigs) {
			const presets = INTERVAL_PRESETS[cfg.presetKey]!;
			const currentVal = s[cfg.key];
			const currentPreset = presets.find(p => p.values === currentVal) || presets[1]!;
			const sub = c.createDiv({ cls: "qg-settings-sub-card" });
			sub.createDiv({ text: cfg.label, cls: "qg-settings-sub-title" });
			const btnRow = sub.createDiv({ cls: "qg-preset-row" });
			for (const p of presets) {
				const isActive = p.values === currentVal;
				const b = btnRow.createEl("button", { text: t(p.label), cls: isActive ? "qg-preset-btn qg-interval-active" : "qg-preset-btn" });
				b.addEventListener("click", () => { s[cfg.key] = p.values; void view.plugin.saveSettings(); void view.renderSettingsTab(); });
			}
			const tip = sub.createDiv({ cls: "qg-field-tip" });
			tip.createSpan({ text: "💡" });
			tip.createSpan({ text: t(currentPreset.hint) });
			const customRow = sub.createDiv({ cls: "qg-field-row" });
			customRow.createSpan({ text: t("自定义："), cls: "qg-field-label" });
			textInput(customRow, currentVal, v => { s[cfg.key] = v; }, t("如 1,2,4,7,15,30"));
		}
	}

	// ---- 学习设置 ----
	c = card(t("学习设置"));
	{
		const wpRow = field(t("薄弱点阈值"));
		numberInput(wpRow, String(s.weakPointThreshold), v => { s.weakPointThreshold = parseInt(v) || 2; }, { min: "1", max: "20" });
		wpRow.createSpan({ text: t("次以上错题标记为薄弱"), cls: "qg-field-suffix" });
		checkboxRow(t("启动时提醒复习"), s.autoReviewReminder, v => { s.autoReviewReminder = v; });
	}

	// ---- AI 助手 ----
	c = card(t("AI 助手"));
	{
		textInput(field(t("引用总预算(字)")), String(s.chatRefBudget), v => { s.chatRefBudget = Math.max(0, parseInt(v) || 0); });
		const row = field(t("聊天检索范围"));
		const sel = selectInput(row, s.chatSearchScope, v => { s.chatSearchScope = v === "vault" ? "vault" : "plugin"; });
		sel.createEl("option", { text: t("仅插件知识库"), value: "plugin" });
		sel.createEl("option", { text: t("整个 vault"), value: "vault" });
		hint(t("「整个 vault」会把任意文件夹中命中的笔记内容发送给已配置的 AI 接口，请注意隐私"));
	}

	window.requestAnimationFrame(() => { el.scrollTop = savedScrollTop; });
}