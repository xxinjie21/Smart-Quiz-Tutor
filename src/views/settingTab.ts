import { App, PluginSettingTab, Setting, type SettingDefinitionItem, type SettingGroupItem } from "obsidian";

import type QuestionGeneratorPlugin from "../main";
import { EASE_PRESETS } from "../constants";
import { t, setLanguage } from "../i18n/index";
import { SETTING_SECTIONS, itemsFor, parseSettingValue, asStr, clampSettingValue, type SettingItem } from "./settingsSchema";

/** 文本类输入合并写入的防抖窗口（ms）。 */
const SAVE_DEBOUNCE_MS = 400;
/** 区块说明文案样式（与命令式渲染保持一致）。 */
const SECTION_NOTE_STYLE = "color:var(--text-muted);font-size:14px;margin-bottom:8px;";
const SECTION_FOOTER_STYLE = "color:var(--text-muted);font-size:14px;line-height:1.6;margin-top:8px;padding:8px 10px;border-radius:6px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);white-space:pre-wrap;";

type SettingsRecord = Record<string, unknown>;

export class QuestionGeneratorSettingTab extends PluginSettingTab {
	plugin: QuestionGeneratorPlugin;
	/** 待落盘的防抖定时器；null 表示没有待写入的改动。 */
	private saveTimer: number | null = null;

	constructor(app: App, plugin: QuestionGeneratorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// ===================== 读写与落盘 =====================

	private get record(): SettingsRecord {
		return this.plugin.settings as unknown as SettingsRecord;
	}

	private setValue(key: string, value: unknown): void {
		this.record[key] = value;
	}

	/** 连续输入时合并写入，避免每敲一个字符就写一次 data.json。 */
	private scheduleSave(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.plugin.saveSettings();
		}, SAVE_DEBOUNCE_MS);
	}

	/** 立即落盘（开关 / 下拉 / 预设按钮等离散操作）。 */
	private flushSave(): void {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		void this.plugin.saveSettings();
	}

	/** 关闭设置页时把尚未落盘的改动写回，避免防抖窗口内切页导致丢改动。 */
	hide(): void {
		this.flushSave();
		super.hide();
	}

	/**
	 * 1.13+ 用声明式刷新；1.12 运行时没有 `update()`，回退到命令式重绘。
	 * 不做这个判断会在旧版 Obsidian 上抛 "update is not a function"。
	 */
	private refreshSettingsUi(): void {
		const tab = this as unknown as { update?: () => void };
		if (typeof tab.update === "function") {
			tab.update();
			return;
		}
		this.renderImperative();
	}

	private findItem(key: string): SettingItem | undefined {
		for (const section of SETTING_SECTIONS) {
			for (const item of section.items) if (item.key === key) return item;
		}
		return undefined;
	}

	/** 写入一个设置项：夹紧范围 + 选择落盘时机 + 处理语言切换的副作用。 */
	private applyValue(item: SettingItem, raw: unknown): void {
		const coerced = typeof raw === "string" ? parseSettingValue(item, raw) : raw;
		this.setValue(item.key, clampSettingValue(item, coerced));
		if (item.key === "language") {
			setLanguage(this.plugin.settings.language);
			this.flushSave();
			this.plugin.refreshSidebarChrome();
			this.refreshSettingsUi();
			return;
		}
		if (item.type === "text" || item.type === "number") this.scheduleSave();
		else this.flushSave();
	}

	// ===================== 声明式定义（Obsidian 1.13+） =====================

	getControlValue(key: string): unknown {
		return this.record[key];
	}

	/**
	 * 必须覆写：基类默认实现直接写 `plugin.settings` 再落盘，
	 * 而本插件的 `saveSettings()` 需要额外带上 `history`，否则历史记录会被覆盖掉。
	 */
	setControlValue(key: string, value: unknown): void {
		const item = this.findItem(key);
		if (item) this.applyValue(item, value);
	}

	/**
	 * 声明式设置定义。与 `display()` 共用 SETTING_SECTIONS 这一份单一事实来源，
	 * 因此两个渲染路径不会分叉。
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		const out: SettingDefinitionItem[] = [];
		for (const section of SETTING_SECTIONS) {
			const items = itemsFor(section, "native");
			if (items.length === 0) continue;
			const groupItems: SettingGroupItem[] = [];
			if (section.note) groupItems.push(this.noteDefinition(section.note, SECTION_NOTE_STYLE));
			for (const item of items) groupItems.push(this.definitionFor(item));
			if (section.footerNote) groupItems.push(this.noteDefinition(section.footerNote, SECTION_FOOTER_STYLE));
			out.push({ type: "group", heading: t(section.title), items: groupItems });
		}
		return out;
	}

	/** 纯说明文案行（区块的 note / footerNote），不绑定任何值。 */
	private noteDefinition(text: string, style: string): SettingGroupItem {
		return {
			name: t(text),
			render: (setting: Setting) => {
				setting.settingEl.empty();
				setting.settingEl.createDiv({ text: t(text), attr: { style } });
			},
		};
	}

	private definitionFor(item: SettingItem): SettingGroupItem {
		const base = { name: t(item.label), desc: item.desc ? t(item.desc) : undefined };

		if (item.type === "toggle") {
			return { ...base, control: { type: "toggle", key: item.key } };
		}
		if (item.type === "select") {
			const options: Record<string, string> = {};
			for (const o of item.options || []) options[o.value] = t(o.label);
			return { ...base, control: { type: "dropdown", key: item.key, options } };
		}
		if (item.type === "number") {
			return {
				...base,
				control: {
					type: "number",
					key: item.key,
					placeholder: item.placeholder ? t(item.placeholder) : undefined,
					min: item.min !== undefined ? Number(item.min) : undefined,
					max: item.max !== undefined ? Number(item.max) : undefined,
					step: item.step !== undefined ? Number(item.step) : 1,
				},
			};
		}
		// easePreset 需要三个一键填入按钮，声明式控件表达不了，用 render 保持原交互。
		if (item.type === "easePreset") {
			return { ...base, render: (setting: Setting) => this.renderEasePreset(setting, item) };
		}
		return { ...base, control: { type: "text", key: item.key, placeholder: item.placeholder ? t(item.placeholder) : undefined } };
	}

	// ===================== 命令式渲染（Obsidian < 1.13 回退） =====================

	/**
	 * Obsidian < 1.13 的渲染路径。
	 * 1.13+ 会优先采用 `getSettingDefinitions()`，官方文档明确要求保留此方法作为旧版回退。
	 */
	display(): void {
		this.renderImperative();
	}

	private renderImperative(): void {
		const { containerEl } = this;
		containerEl.empty();
		for (const section of SETTING_SECTIONS) {
			const items = itemsFor(section, "native");
			if (items.length === 0) continue;
			new Setting(containerEl).setName(t(section.title)).setHeading();
			if (section.note) containerEl.createDiv({ text: t(section.note), attr: { style: SECTION_NOTE_STYLE } });
			for (const item of items) this.renderItem(containerEl, item);
			if (section.footerNote) containerEl.createDiv({ text: t(section.footerNote), attr: { style: SECTION_FOOTER_STYLE } });
		}
	}

	private renderItem(containerEl: HTMLElement, item: SettingItem): void {
		const setting = new Setting(containerEl).setName(t(item.label));
		if (item.desc) setting.setDesc(t(item.desc));

		if (item.type === "toggle") {
			setting.addToggle(cb => cb.setValue(Boolean(this.record[item.key])).onChange(v => this.applyValue(item, v)));
			return;
		}
		if (item.type === "select") {
			setting.addDropdown(cb => {
				for (const o of item.options || []) cb.addOption(o.value, t(o.label));
				cb.setValue(asStr(this.record[item.key])).onChange(v => this.applyValue(item, v));
			});
			return;
		}
		if (item.type === "number") {
			setting.addText(cb => {
				cb.setValue(asStr(this.record[item.key])).onChange(v => this.applyValue(item, v));
				// 输入过程中不打断用户，失焦时再把夹紧后的真实值回填到输入框。
				cb.inputEl.addEventListener("blur", () => { cb.setValue(asStr(this.record[item.key])); });
			});
			return;
		}
		if (item.type === "easePreset") {
			setting.addText(cb => {
				cb.setValue(asStr(this.record[item.key])).onChange(v => this.applyValue(item, v));
				cb.inputEl.addEventListener("blur", () => { cb.setValue(asStr(this.record[item.key])); });
			});
			this.renderEasePreset(setting, item);
			return;
		}
		setting.addText(cb => cb.setValue(asStr(this.record[item.key])).setPlaceholder(item.placeholder ? t(item.placeholder) : "").onChange(v => this.applyValue(item, v)));
	}

	/** 三个难度因子一键填入按钮（命令式与声明式共用）。 */
	private renderEasePreset(setting: Setting, item: SettingItem): void {
		const current = Number(this.record[item.key]);
		const row = setting.settingEl.createDiv({ attr: { style: "display:flex;gap:4px;margin-top:6px;" } });
		for (const p of EASE_PRESETS) {
			const isActive = current === p.factor;
			const btn = row.createEl("button", {
				text: t(p.label),
				cls: isActive ? "qg-interval-active" : undefined,
				attr: {
					title: t(p.hint),
					style: "padding:2px 8px;border-radius:3px;cursor:pointer;font-size:13px;border:1px solid var(--background-modifier-border);" + (isActive ? "" : "background:var(--background-primary);color:var(--text-muted);"),
				},
			});
			btn.addEventListener("click", () => {
				this.setValue(item.key, p.factor);
				this.flushSave();
				this.refreshSettingsUi();
			});
		}
	}
}
