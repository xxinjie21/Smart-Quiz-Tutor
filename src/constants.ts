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
	sortWrongBy: "date",
	extractedExamFolder: "题目/识别试卷",
	wrongReviewIntervals: "1,2,4,7,15,30",
	questionReviewIntervals: "7,15,30,60,90",
	noteReviewIntervals: "1,3,7,14,30",
	noteViewFolder: "笔记",
	sortReviewBy: "default",
	questionKnowledgeFolder: "题目/知识点",
	noteKnowledgeFolder: "笔记/知识点",
	wrongKnowledgeFolder: "错题/知识点",
};

export const SYSTEM_TAGS = ["错题", "题目"];

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
