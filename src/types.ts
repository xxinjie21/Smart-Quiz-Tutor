export interface OllamaResponse { response?: string; }

export interface OpenAIResponse { choices?: { message?: { content?: string } }[]; }

export type FmValue = string | boolean | number | string[];

export interface HistoryEntry {
	id: string;
	timestamp: number;
	fileName: string;
	sourceSnippet: string;
	resultText: string;
	sourcePath: string;
}

export interface WrongAnswerNote {
	filePath: string;
	baseName: string;
	date: string;
	sourceFile: string;
	sourcePath: string;
	tags: string[];
	resultText: string;
	note: string;
	nextReview: string;
	interval: number;
	correctCount: number;
	wrongCount: number;
	easeFactor: number;
	repetitions: number;
	lapses: number;
}

export type QuestionType = "single" | "multi" | "judge" | "blank" | "essay";

export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
}

export type ChatSearchScope = "plugin" | "vault";

/** 一个独立会话，保存消息历史与检索范围。 */
export interface ChatSession {
	id: string;
	name: string;
	scope: ChatSearchScope;
	createdAt: number;
	updatedAt: number;
	messages: ChatMessage[];
}

export interface ParsedQuestion {
	number: number;
	type: QuestionType;
	text: string;
	options: { label: string; text: string }[];
	answer: string;
	explanation: string;
}

export interface PluginSettings {
	rootFolder: string;
	apiType: "ollama" | "openai";
	baseUrl: string;
	modelName: string;
	apiKey: string;
	temperature: number;
	countSingle: number;
	countMulti: number;
	countJudge: number;
	countBlank: number;
	countEssay: number;
	questionFolder: string;
	wrongBookFolder: string;
	convertedMdFolder: string;
	excludeFolders: string;
	autoSave: boolean;
	lastTags: string;
	lastEnabledTypes: string;
	weakPointThreshold: number;
	autoReviewReminder: boolean;
	extractedExamFolder: string;
	wrongEaseFactor: number;
	questionEaseFactor: number;
	noteEaseFactor: number;
	noteViewFolder: string;
	knowledgeFolder: string;
	language: "zh" | "en";
	chatSearchScope: ChatSearchScope;
	chatAutoRetrieve: boolean;
	chatRefBudget: number;
	chatActiveSessionId: string;
	chatSessionsPanelOpen: boolean;
	sidebarZoom: number;
}

/**
 * 列表 / 选择器所需的最小文件元信息。
 *
 * vault 内的文件是真正的 `TFile`；vault 之外（配置了绝对根目录）的文件只有磁盘 stat，
 * 没有 `TFile` 实例。统一用这个结构描述两者，避免 `as unknown as TFile` 这种伪装——
 * 伪装出来的对象缺少 `extension` 等字段，一旦被读取就会静默出错或抛异常。
 */
export interface FileMeta {
	name: string;
	path: string;
	basename: string;
	extension: string;
	stat: { mtime: number; size: number };
}

export interface TreeNode {
	name: string;
	path: string;
	isFolder: boolean;
	children: TreeNode[];
	file?: FileMeta;
}

export type SectionKey = "home" | "questions" | "notes" | "wrong" | "review" | "settings";

export type HomeViewKey = "default" | "filePicker" | "generate" | "answer" | "examBrowser" | "tagger" | "noteGen" | "history";

export type SortMode = "default" | "source" | "tag" | "time";

export type ReviewFilterType = "all" | "wrong" | "question" | "note";

export type ReviewSource = "wrong" | "question" | "note";
