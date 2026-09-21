import type { MainSidebarView } from "../sidebarView";
import { EASE_PRESETS, EASE_MIN, EASE_MAX } from "../../constants";
import { t, setLanguage } from "../../i18n/index";
import { SETTING_SECTIONS, itemsFor, parseSettingValue, asStr, type SettingItem } from "../settingsSchema";
import { clampEase } from "../../utils/sm2";

/** 设置页（侧边栏内自绘），从 settingsSchema 单一来源渲染。 */
export function renderSettingsTab(view: MainSidebarView): void {
	if (!view.innerContentEl) return;
	const el = view.innerContentEl;
	const savedScrollTop = el.scrollTop;
	el.empty();
	const s = view.plugin.settings;
	const save = () => { void view.plugin.saveSettings(); };
	const setVal = (key: keyof typeof s, value: unknown) => { (s as unknown as Record<string, unknown>)[key] = value; };

	const checkboxRow = (parent: HTMLElement, label: string, checked: boolean, onChange: (v: boolean) => void) => {
		const row = parent.createDiv({ cls: "qg-field-row" });
		const cb = row.createEl("input", { attr: { type: "checkbox" } });
		cb.checked = checked;
		cb.addEventListener("change", () => { onChange(cb.checked); save(); });
		row.createSpan({ text: t(label), cls: "qg-field-check-label" });
	};
	const numberItem = (row: HTMLElement, item: SettingItem) => {
		row.createSpan({ text: t(item.label), cls: "qg-field-label" });
		const inp = row.createEl("input", { attr: { type: "number", value: asStr(s[item.key]), min: item.min || "", max: item.max || "", step: item.step || "" } });
		inp.addClass("qg-field-input");
		inp.addClass("qg-num-input");
		inp.addEventListener("change", () => { setVal(item.key, parseSettingValue(item, inp.value)); save(); });
		if (item.suffix) row.createSpan({ text: t(item.suffix), cls: "qg-field-suffix" });
	};

	const renderItem = (parent: HTMLElement, item: SettingItem) => {
		const key = item.key;
		if (item.type === "zoom") {
			const row = parent.createDiv({ cls: "qg-field-row" });
			row.createSpan({ text: t(item.label), cls: "qg-field-label" });
			const val = row.createSpan({ text: Math.round((s.sidebarZoom || 1) * 100) + "%", cls: "qg-zoom-val" });
			row.createDiv({ attr: { style: "flex:1;" } });
			const mk = (txt: string, delta: number, lbl: string) => {
				const b = row.createEl("button", { text: txt, cls: "qg-zoom-btn", attr: { title: t(lbl), "aria-label": t(lbl) } });
				b.addEventListener("click", () => { view.adjustZoom(delta); val.setText(Math.round((s.sidebarZoom || 1) * 100) + "%"); });
			};
			mk("A−", -0.05, "缩小字号");
			mk("A+", 0.05, "放大字号");
			row.createEl("button", { text: t("复位"), cls: "qg-zoom-btn", attr: { title: t("字号复位") } })
				.addEventListener("click", () => { view.adjustZoom(1 - (s.sidebarZoom || 1)); val.setText("100%"); });
			return;
		}
		if (item.type === "easePreset") {
			const row = parent.createDiv({ cls: "qg-field-row" });
			row.createSpan({ text: t(item.label), cls: "qg-field-label" });
			const inp = row.createEl("input", { attr: { type: "number", value: asStr(s[key]), min: String(EASE_MIN), max: String(EASE_MAX), step: "0.1" } });
			inp.addClass("qg-field-input");
			inp.addClass("qg-num-input");
			inp.addEventListener("change", () => { setVal(key, clampEase(parseFloat(inp.value))); save(); });
			const btnRow = parent.createDiv({ cls: "qg-preset-row" });
			for (const p of EASE_PRESETS) {
				const isActive = Number(s[key]) === p.factor;
				const b = btnRow.createEl("button", { text: t(p.label), cls: isActive ? "qg-preset-btn qg-interval-active" : "qg-preset-btn", attr: { title: t(p.hint) } });
				b.addEventListener("click", () => { setVal(key, p.factor); save(); void view.renderSettingsTab(); });
			}
			if (item.desc) parent.createDiv({ text: t(item.desc), cls: "qg-field-tip" });
			return;
		}
		if (item.type === "toggle") { checkboxRow(parent, item.label, s[key] as boolean, v => { setVal(key, v); }); return; }
		if (item.type === "select") {
			const row = parent.createDiv({ cls: "qg-field-row" });
			row.createSpan({ text: t(item.label), cls: "qg-field-label" });
			const sel = row.createEl("select", { cls: "qg-field-input" });
			for (const opt of item.options || []) sel.createEl("option", { value: opt.value, text: t(opt.label) });
			sel.value = asStr(s[key]);
			sel.addEventListener("change", () => {
				if (key === "language") { setVal("language", sel.value); setLanguage(s.language); save(); view.refreshChrome(); return; }
				setVal(key, sel.value); save();
			});
			if (item.desc) parent.createDiv({ text: t(item.desc), cls: "qg-field-tip" });
			return;
		}
		if (item.type === "number") { const row = parent.createDiv({ cls: "qg-field-row" }); numberItem(row, item); if (item.desc) parent.createDiv({ text: t(item.desc), cls: "qg-field-tip" }); return; }
		// text
		const row = parent.createDiv({ cls: "qg-field-row" });
		row.createSpan({ text: t(item.label), cls: "qg-field-label" });
		const inp = row.createEl("input", { attr: { type: "text", value: asStr(s[key]), placeholder: item.placeholder ? t(item.placeholder) : "" } });
		inp.addClass("qg-field-input");
		inp.addEventListener("change", () => { setVal(key, inp.value); save(); });
		if (item.desc) parent.createDiv({ text: t(item.desc), cls: "qg-field-tip" });
	};

	for (const section of SETTING_SECTIONS) {
		const items = itemsFor(section, "sidebar");
		if (items.length === 0) continue;
		const c = el.createDiv({ cls: "qg-settings-card" });
		c.createDiv({ text: t(section.title), cls: "qg-section-heading" });
		if (section.note) c.createDiv({ text: t(section.note), cls: "qg-callout" });
		if (section.grid) {
			const grid = c.createDiv({ cls: "qg-settings-grid" });
			for (const item of items) { const row = grid.createDiv({ cls: "qg-field-row" }); numberItem(row, item); }
		} else {
			for (const item of items) renderItem(c, item);
		}
		if (section.footerNote) {
			const f = c.createDiv({ cls: "qg-callout" });
			f.setAttr("style", "white-space:pre-wrap;");
			f.setText(t(section.footerNote));
		}
	}

	window.requestAnimationFrame(() => { el.scrollTop = savedScrollTop; });
}