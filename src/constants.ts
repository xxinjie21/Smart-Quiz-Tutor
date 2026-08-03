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
	wrongReviewIntervals: "1,2,4,7,15,30",
	questionReviewIntervals: "7,15,30,60,90",
	noteReviewIntervals: "2,6,14,35,70",
	noteViewFolder: "笔记",
	knowledgeFolder: "知识点",
};

export const SYSTEM_TAGS = ["错题", "题目", "笔记"];

export interface IntervalPreset {
	label: string;
	values: string;
	hint: string;
}

export const INTERVAL_PRESETS: Record<string, IntervalPreset[]> = {
	wrong: [
		{ label: "慢速", values: "2,5,10,20,40,60", hint: "复盘间隔长、执行省心，适合已初步掌握、仅需定期回顾的错题" },
		{ label: "标准", values: "1,2,4,7,15,30", hint: "考前日常训练主力方案，遗忘曲线与复习节奏平衡" },
		{ label: "快速", values: "1,1,3,5,10,20", hint: "前期隔天密集复盘，适合频繁出错的高频薄弱点" },
	],
	question: [
		{ label: "慢速", values: "10,20,40,80,120", hint: "适合基础扎实、掌握牢固、几乎不会遗忘的简单题目" },
		{ label: "标准", values: "7,15,30,60,90", hint: "覆盖范围广、周期适中，配合考研各阶段节奏" },
		{ label: "快速", values: "4,8,18,40,60", hint: "加密前期间隔、反复强化，适合刚学完的重难点" },
	],
	note: [
		{ label: "慢速", values: "3,8,20,45,80", hint: "长线缓释记忆，适合考研基础阶段按部就班的日常背诵" },
		{ label: "标准", values: "2,6,14,35,70", hint: "中等密度、长线巩固，强化期系统性复习主力配置" },
		{ label: "快速", values: "1,1,2,3,5", hint: "考前冲刺专用，短期高频轰炸、以速度换覆盖" },
	],
};

export const SIDEBAR_VIEW_TYPE = "question-generator-sidebar";

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
