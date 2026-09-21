import type { PluginSettings } from "../types";

/** 设置项出现的界面：both=侧边栏+原生；sidebar=仅侧边栏；native=仅原生。 */
export type SettingSurface = "both" | "sidebar" | "native";
export type SettingType = "select" | "text" | "number" | "toggle" | "zoom" | "easePreset";

export interface SettingOption { value: string; label: string; }

export interface SettingItem {
	key: keyof PluginSettings;
	label: string;
	desc?: string;
	type: SettingType;
	placeholder?: string;
	options?: SettingOption[];
	min?: string;
	max?: string;
	step?: string;
	suffix?: string;
	presetKey?: string;
	surface?: SettingSurface;
}

export interface SettingSection {
	id: string;
	title: string;
	/** 标题下方的说明。 */
	note?: string;
	/** 区块底部的说明（如目录结构）。 */
	footerNote?: string;
	/** 侧边栏是否用网格布局（用于数量）。 */
	grid?: boolean;
	items: SettingItem[];
}

/**
 * 设置项单一事实来源：原生设置页与侧边栏设置页都从此渲染，
 * 避免两处文案/选项分叉。label/desc/note 用中文原文作为 i18n key。
 */
export const SETTING_SECTIONS: SettingSection[] = [
	{
		id: "interface",
		title: "界面语言",
		items: [
			{ key: "language", label: "界面语言", desc: "切换后界面文案即时生效；命令面板中的命令名需重启插件后更新", type: "select", options: [{ value: "zh", label: "中文" }, { value: "en", label: "English" }] },
		],
	},
	{
		id: "display",
		title: "显示",
		items: [
			{ key: "sidebarZoom", label: "侧边栏字号", type: "zoom", surface: "sidebar" },
		],
	},
	{
		id: "folders",
		title: "文件夹",
		note: "根文件夹下包含所有模块子文件夹，修改后需重启插件生效",
		footerNote: "预期目录结构：\n根文件夹/\n├─ 题目/（含 识别试卷/）\n├─ 错题/\n├─ 笔记/\n├─ 知识点/（统一索引，含相关题目/相关笔记/相关错题三段）\n└─ md文件/",
		items: [
			{ key: "rootFolder", label: "根文件夹", desc: "所有模块子文件夹的父目录", type: "text", placeholder: "智学助手" },
			{ key: "questionFolder", label: "题目文件夹", type: "text" },
			{ key: "wrongBookFolder", label: "错题文件夹", type: "text" },
			{ key: "noteViewFolder", label: "笔记文件夹", type: "text", placeholder: "笔记" },
			{ key: "knowledgeFolder", label: "知识点文件夹", desc: "统一的知识点索引目录（与题目/笔记/错题同层），索引文件内含「相关题目/相关笔记/相关错题」三段", type: "text", placeholder: "知识点" },
			{ key: "convertedMdFolder", label: "转换md文件夹", desc: "对非md文件（txt/rtf/docx/PDF/图片）生成题目或识别试卷时，把转换后的文本保存为md文件到这里，留空则关闭", type: "text" },
			{ key: "extractedExamFolder", label: "AI识别文件夹", type: "text", placeholder: "题目/识别试卷" },
			{ key: "excludeFolders", label: "排除文件夹", desc: "逗号分隔的文件夹名，扫描时跳过", type: "text" },
			{ key: "autoSave", label: "生成后自动保存到题库", type: "toggle" },
		],
	},
	{
		id: "counts",
		title: "默认题目数量",
		grid: true,
		items: [
			{ key: "countSingle", label: "单选题", type: "number", min: "0", max: "50", suffix: "题" },
			{ key: "countMulti", label: "多选题", type: "number", min: "0", max: "50", suffix: "题" },
			{ key: "countJudge", label: "判断题", type: "number", min: "0", max: "50", suffix: "题" },
			{ key: "countBlank", label: "填空题", type: "number", min: "0", max: "50", suffix: "题" },
			{ key: "countEssay", label: "简答题", type: "number", min: "0", max: "50", suffix: "题" },
		],
	},
	{
		id: "api",
		title: "API 配置",
		items: [
			{ key: "apiType", label: "接口类型", type: "select", options: [{ value: "ollama", label: "Ollama" }, { value: "openai", label: "OpenAI兼容" }] },
			{ key: "baseUrl", label: "接口地址", type: "text" },
			{ key: "modelName", label: "模型名称", type: "text" },
			{ key: "apiKey", label: "API Key", type: "text" },
			{ key: "temperature", label: "Temperature", desc: "控制输出随机性，0-2，越低越确定", type: "number", min: "0", max: "2", step: "0.1" },
		],
	},
	{
		id: "intervals",
		title: "复习间隔设置",
		note: "用难度因子控制间隔增长：SM-2 按 1 天 → 6 天 → 上一间隔 × 因子 递增。推荐 2.0–2.8（标准 2.5），越大间隔增长越快、复习越少。",
		items: [
			{ key: "wrongEaseFactor", label: "错题间隔因子", desc: "错题建议偏小（复习更频繁）", type: "easePreset", min: "1.3", max: "3", step: "0.1" },
			{ key: "questionEaseFactor", label: "题目间隔因子", type: "easePreset", min: "1.3", max: "3", step: "0.1" },
			{ key: "noteEaseFactor", label: "笔记间隔因子", type: "easePreset", min: "1.3", max: "3", step: "0.1" },
		],
	},
	{
		id: "study",
		title: "学习设置",
		items: [
			{ key: "weakPointThreshold", label: "薄弱点阈值", desc: "次以上错题标记为薄弱", type: "number", min: "1", max: "20" },
			{ key: "autoReviewReminder", label: "启动时提醒复习", type: "toggle" },
		],
	},
	{
		id: "ai",
		title: "AI 助手",
		items: [
			{ key: "chatRefBudget", label: "引用总预算(字)", desc: "单次提问最多带入的引用文本总量，超出按引用顺序截断；本地小模型建议调小", type: "number", min: "0" },
			{ key: "chatSearchScope", label: "聊天检索范围", desc: "「整个 vault」会把任意文件夹中命中的笔记内容发送给已配置的 AI 接口，请注意隐私", type: "select", options: [{ value: "plugin", label: "仅插件知识库" }, { value: "vault", label: "整个 vault" }] },
		],
	},
];

/** 按界面筛选设置项（surface 缺省为 both）。 */
export function itemsFor(section: SettingSection, surface: "sidebar" | "native"): SettingItem[] {
	return section.items.filter(i => {
		const s = i.surface ?? "both";
		return s === "both" || s === surface;
	});
}

/** 文本/数字设置写入 settings 的解析方式。 */
export function parseSettingValue(item: SettingItem, raw: string): string | number {
	if (item.type === "number") return item.step ? parseFloat(raw) || 0 : parseInt(raw) || 0;
	return raw;
}

/**
 * 按 schema 的 min/max 夹紧数值型设置。
 *
 * 旧实现只把 min/max 当占位符展示，从未真正约束输入：题目数量可以存成 999，
 * 温度可以存成 50，之后才在别处被静默截断。这里保证落盘的永远是合法值。
 */
export function clampSettingValue(item: SettingItem, value: unknown): unknown {
	if (item.type !== "number" && item.type !== "easePreset") return value;
	const num = typeof value === "number" ? value : Number(value);
	if (!isFinite(num)) return value;
	const min = item.min !== undefined ? Number(item.min) : NaN;
	const max = item.max !== undefined ? Number(item.max) : NaN;
	let out = num;
	if (isFinite(min)) out = Math.max(min, out);
	if (isFinite(max)) out = Math.min(max, out);
	return out;
}

/** 安全地把设置值转成字符串（数组等非原始值返回空串，避免 "[object Object]")。 */
export function asStr(v: unknown): string {
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	return "";
}