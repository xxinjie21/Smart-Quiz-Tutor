import type { PluginSettings } from "./types";

export const DEFAULT_SETTINGS: PluginSettings = {
	rootFolder: "智学助手",
	apiType: "ollama",
	baseUrl: "http://127.0.0.1:11434",
	modelName: "qwen2:7b",
	apiKey: "",
	temperature: 0.1,
	countSingle: 5,
	countMulti: 3,
	countJudge: 5,
	countBlank: 2,
	countEssay: 2,
	questionFolder: "题目",
	wrongBookFolder: "错题",
	convertedMdFolder: "md文件",
	excludeFolders: ".trash, 模板, templates",
	autoSave: true,
	lastTags: "",
	lastEnabledTypes: "single,multi,judge,blank,essay",
	weakPointThreshold: 2,
	autoReviewReminder: true,
	extractedExamFolder: "题目/识别试卷",
	wrongEaseFactor: 2.3,
	questionEaseFactor: 2.5,
	noteEaseFactor: 2.5,
	noteViewFolder: "笔记",
	knowledgeFolder: "知识点",
	language: "zh",
	chatSearchScope: "plugin",
	chatAutoRetrieve: true,
	chatRefBudget: 60000,
	chatActiveSessionId: "",
	chatSessionsPanelOpen: false,
	sidebarZoom: 1,
};

export const SYSTEM_TAGS = ["错题", "题目", "笔记"];

export interface EasePreset {
	label: string;
	/** 初始难度因子（SM-2 的 EF）。 */
	factor: number;
	hint: string;
}

/** 难度因子下限/上限（SM-2 下限 1.3，上限防止间隔爆炸式增长）。 */
export const EASE_MIN = 1.3;
export const EASE_MAX = 3.0;
export const EASE_RECOMMENDED = "2.0–2.8";

/**
 * 单次复习间隔的天数上限（约 10 年）。
 *
 * 纯 SM-2 的 `I(n) = I(n-1) × EF` 没有上界，而错题卡片允许在未到期时反复评分，
 * 所以连续点几十次「简单」会让间隔溢出成 `Invalid Date`，把 `nextReview` 写成
 * `NaN-NaN-NaN`（该条目从此永远不会到期）。这里加一个硬上限兜住。
 */
export const MAX_INTERVAL_DAYS = 3650;

/**
 * 一键填入的难度因子预设。
 *
 * 文案以「复习频率」命名，而不是「快/慢」——因子越大间隔增长越快、复习次数越少，
 * 旧标签（慢速=2.7、快速=2.3）与提示语恰好相反，容易让用户选反。
 */
export const EASE_PRESETS: EasePreset[] = [
	{ label: "少复习", factor: 2.7, hint: "因子 2.7：间隔增长快、复习次数少，适合已牢固掌握、很少遗忘的内容" },
	{ label: "标准", factor: 2.5, hint: "SM-2 标准难度因子，间隔增长与记忆曲线平衡" },
	{ label: "多复习", factor: 2.3, hint: "因子 2.3：间隔增长慢、复习更频繁，适合高频薄弱点" },
];

export const SIDEBAR_VIEW_TYPE = "question-generator-sidebar";

export const CHAT_HISTORY_LIMIT = 50;
export const CHAT_RETRIEVE_LIMIT = 5;
export const CHAT_CANDIDATE_LIMIT = 60;
export const CHAT_TITLE_MAX = 20;
/** 引用拼装：头部保留字数、单片段字数、最多片段数。 */
export const REF_HEAD_CHARS = 1500;
export const REF_SNIPPET_CHARS = 700;
export const REF_SNIPPET_MAX = 3;
/** 单文件引用捕获硬上限（防止内存过大）。 */
export const REF_CAPTURE_MAX = 200000;

export const HISTORY_LIMIT = 100;
export const HISTORY_RESULT_CHARS = 2000;

export const MAX_EXAM_CHUNK_CHARS = 15000;
export const EXAM_CHUNK_OVERLAP = 2000;
export const MAX_EXTRACTED_TAGS = 8;
export const MAX_UNTAGGED_DISPLAY = 10;
export const MAX_HISTORY_SNIPPET = 500;
export const AI_REQUEST_TIMEOUT_MS = 180000;
export const TOKEN_WARN_THRESHOLD = 6000;
export const NOTICE_DURATION_MS = 8000;
export const REVIEW_REMINDER_DELAY_MS = 2000;
export const WRONG_NOTES_CACHE_TTL_MS = 2000;
export const SEARCH_DEBOUNCE_MS = 250;
export const PREVIEW_ITEMS_LIMIT = 3;
