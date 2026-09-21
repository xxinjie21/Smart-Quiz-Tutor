import { t } from "../../../i18n/index";

// ---- 分段切换条（排序/筛选） ----
export interface SegOption { key: string; label: string; }
export function segBar(el: HTMLElement, opts: SegOption[], isActive: (key: string) => boolean, onSelect: (key: string) => void): HTMLElement {
	const bar = el.createDiv({ cls: "qg-seg-bar" });
	for (const opt of opts) {
		const b = bar.createEl("button", { text: opt.label, cls: isActive(opt.key) ? "qg-seg-item qg-seg-item-active" : "qg-seg-item" });
		b.addEventListener("click", () => onSelect(opt.key));
	}
	return bar;
}

// ---- 统计徽章 ----
export type StatTone = "accent" | "success" | "info" | "warn" | "danger";
const STAT_TONES: Record<StatTone, string> = {
	accent: "var(--interactive-accent)",
	success: "var(--qg-success)",
	info: "var(--qg-info)",
	warn: "var(--qg-warn)",
	danger: "var(--qg-danger)",
};
export function statsBadges(el: HTMLElement, items: { text: string; tone?: StatTone }[]): void {
	const row = el.createDiv({ cls: "qg-stat-row" });
	for (const it of items) {
		const c = STAT_TONES[it.tone || "accent"];
		row.createSpan({ text: it.text, cls: "qg-stat-badge", attr: { style: "background:color-mix(in srgb, " + c + " 15%, transparent);color:" + c + ";" } });
	}
}

// ---- 空态 ----
export function emptyState(el: HTMLElement, text: string): HTMLElement {
	return el.createDiv({ text, cls: "qg-empty" });
}

// ---- 返回按钮 ----
export function backButton(el: HTMLElement, onClick: () => void, label?: string): HTMLElement {
	const b = el.createEl("button", { text: label || t("← 返回"), cls: "qg-back-btn" });
	b.addEventListener("click", onClick);
	return b;
}

// ---- 搜索框 ----
export function searchField(el: HTMLElement, placeholder: string, initial: string, onInput: (v: string) => void): HTMLElement {
	const inp = el.createEl("input", { attr: { type: "text", placeholder } });
	inp.addClass("qg-search-field");
	inp.value = initial;
	inp.addEventListener("input", () => onInput(inp.value));
	return inp;
}

// ---- 分组折叠（点标题展开/收起） ----
export interface CollapseOpts { title: string; countText?: string; open?: boolean; }
export function collapseGroup(parent: HTMLElement, opts: CollapseOpts, renderBody: (body: HTMLElement) => void): void {
	const group = parent.createDiv({ cls: "qg-collapse-group" + (opts.open ? " qg-open" : "") });
	const head = group.createDiv({ cls: "qg-collapse-head" });
	head.createSpan({ text: opts.open ? "▾" : "▸", cls: "qg-collapse-arrow" });
	head.createSpan({ text: opts.title, cls: "qg-collapse-title" });
	if (opts.countText) head.createSpan({ text: opts.countText, cls: "qg-collapse-count" });
	const body = group.createDiv({ cls: "qg-collapse-body" });
	renderBody(body);
	head.addEventListener("click", () => {
		const expanded = group.hasClass("qg-open");
		group.toggleClass("qg-open", !expanded);
		head.querySelector(".qg-collapse-arrow")?.setText(expanded ? "▸" : "▾");
	});
}