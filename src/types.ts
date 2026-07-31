import type { TFile } from "obsidian";

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
}

export type QuestionType = "single" | "multi" | "judge" | "blank" | "essay";

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
	excludeFolders: string;
	autoSave: boolean;
	lastTags: string;
	lastEnabledTypes: string;
	weakPointThreshold: number;
	autoReviewReminder: boolean;
	sortWrongBy: "date" | "tag" | "review";
	extractedExamFolder: string;
	wrongReviewIntervals: string;
	questionReviewIntervals: string;
	noteReviewIntervals: string;
	noteViewFolder: string;
	sortReviewBy: "default" | "source" | "tag" | "time";
	questionKnowledgeFolder: string;
	noteKnowledgeFolder: string;
	wrongKnowledgeFolder: string;
	customTools: { label: string; url: string }[];
}

export interface TreeNode {
	name: string;
	path: string;
	isFolder: boolean;
	children: TreeNode[];
	file?: TFile;
}

export type SectionKey = "home" | "questions" | "notes" | "wrong" | "review" | "settings";

export type HomeViewKey = "default" | "filePicker" | "generate" | "answer" | "examBrowser" | "tagger";

export type SortMode = "default" | "source" | "tag" | "time";

export type ReviewFilterType = "all" | "wrong" | "question" | "note";

export type ReviewSource = "wrong" | "question" | "note";
