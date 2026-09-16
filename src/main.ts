import { Plugin, TFile, TFolder, Notice, Editor, Menu, MarkdownView, MarkdownFileInfo } from "obsidian";

import { DEFAULT_SETTINGS, SIDEBAR_VIEW_TYPE, CHAT_VIEW_TYPE, NOTICE_DURATION_MS, REVIEW_REMINDER_DELAY_MS, HISTORY_LIMIT, HISTORY_RESULT_CHARS } from "./constants";
import type { HistoryEntry, WrongAnswerNote, PluginSettings } from "./types";
import { isAbs, ensureFolder, EXAM_SOURCE_EXTS } from "./utils/fs-utils";
import { isDueForReview } from "./utils/review";
import { pruneHistory } from "./utils/history";
import { logError } from "./utils/log";
import { KnowledgeService, type IndexSource } from "./services/knowledgeService";
import { VaultDataService } from "./services/vaultDataService";
import { MainSidebarView } from "./views/sidebarView";
import { ChatView } from "./views/chatView";
import { QuestionGeneratorSettingTab } from "./views/settingTab";
import { setLanguage, t, tf } from "./i18n/index";

// ===================== 主插件入口 =====================

export default class QuestionGeneratorPlugin extends Plugin {
	settings!: PluginSettings;
	history: HistoryEntry[] = [];
	knowledgeService = new KnowledgeService(this);
	vaultData = new VaultDataService(this);

	async loadSettings() {
		const data = await this.loadData() as { history?: HistoryEntry[]; wrongAnswers?: { timestamp?: number; fileName?: string; note?: string; resultText?: string }[] } | null;
		const raw = data ? { ...data } as Record<string, unknown> : {};
		delete raw.questionKnowledgeFolder;
		delete raw.noteKnowledgeFolder;
		delete raw.wrongKnowledgeFolder;
		const legacyKf = ["题目/知识点", "笔记/知识点", "错题/知识点", "错题本/知识点"];
		if (typeof raw.knowledgeFolder === "string" && legacyKf.includes(raw.knowledgeFolder)) {
			raw.knowledgeFolder = DEFAULT_SETTINGS.knowledgeFolder;
		}
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
		if (data?.history) this.history = data.history;
		this.history = pruneHistory(this.history, HISTORY_LIMIT, HISTORY_RESULT_CHARS);
		setLanguage(this.settings.language || "zh");
	}
	rootPath(subFolder: string): string {
		const root = this.settings.rootFolder;
		if (!root) return subFolder;
		if (isAbs(subFolder)) return subFolder;
		return root + "/" + subFolder;
	}
	async saveSettings() {
		await this.saveData({ ...this.settings, history: this.history });
	}
	async saveHistory() {
		await this.saveData({ ...this.settings, history: this.history });
	}
	async addHistory(entry: HistoryEntry) {
		this.history.push(entry);
		this.history = pruneHistory(this.history, HISTORY_LIMIT, HISTORY_RESULT_CHARS);
		await this.saveHistory();
	}

	// ===================== 集中数据管理（转发到 VaultDataService） =====================
	private _refreshCallbacks: (() => void)[] = [];

	invalidateCache() { this.vaultData.invalidateCache(); }

	onDataChanged(callback: () => void) { this._refreshCallbacks.push(callback); }

	offDataChanged(callback: () => void) { this._refreshCallbacks = this._refreshCallbacks.filter(cb => cb !== callback); }

	emitDataChanged() { this.invalidateCache(); for (const cb of this._refreshCallbacks) { try { cb(); } catch { /* empty */ } } }

	async loadAllWrongNotes(forceRefresh = false): Promise<WrongAnswerNote[]> {
		return this.vaultData.loadAllWrongNotes(forceRefresh);
	}

	async loadAllQuestionFilesForReview(): Promise<WrongAnswerNote[]> {
		return this.vaultData.loadAllQuestionFilesForReview();
	}

	async loadAllVaultNotesForReview(): Promise<WrongAnswerNote[]> {
		return this.vaultData.loadAllVaultNotesForReview();
	}

	async migrateOldWrongAnswers(): Promise<void> {
		return this.vaultData.migrateOldWrongAnswers();
	}

	async deleteWrongNote(filePath: string): Promise<void> {
		return this.vaultData.deleteWrongNote(filePath);
	}

	async exportToFile(text: string, defaultName: string, format: "md" | "word" | "pdf", title?: string, source?: string): Promise<void> {
		return this.vaultData.exportToFile(text, defaultName, format, title, source);
	}

	// ===================== 知识点索引（转发到 KnowledgeService） =====================
	async loadExistingKnowledgeTags(): Promise<string[]> {
		return this.knowledgeService.loadExistingKnowledgeTags();
	}

	async syncKnowledgeFolder(tags: string[], links: { label: string; path: string }[], source: IndexSource = "错题", folderOverride?: string) {
		return this.knowledgeService.syncKnowledgeFolder(tags, links, source, folderOverride);
	}

	async rebuildKnowledgeIndex() {
		return this.knowledgeService.rebuildKnowledgeIndex();
	}

	async getWeakPoints(): Promise<{ tag: string; count: number; questions: WrongAnswerNote[] }[]> {
		return this.knowledgeService.getWeakPoints();
	}

	async migrateKnowledgeLinks() {
		return this.knowledgeService.migrateKnowledgeLinks();
	}

	async activateSidebar(): Promise<MainSidebarView | null> {
		const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
		if (leaves.length > 0) {
			await this.app.workspace.revealLeaf(leaves[0]!);
			return leaves[0]!.view as MainSidebarView;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
			return leaf.view as MainSidebarView;
		}
		return null;
	}

	async activateChat(): Promise<MainSidebarView | null> {
		const view = await this.activateSidebar();
		if (view) { view.activeSection = "chat"; await view.render(); }
		return view;
	}

	async onload() {
		await this.loadSettings();

		const initFolders = [
			this.settings.rootFolder,
			this.rootPath(this.settings.questionFolder),
			this.rootPath(this.settings.wrongBookFolder),
			this.rootPath(this.settings.noteViewFolder),
			this.rootPath(this.settings.extractedExamFolder),
			this.rootPath(this.settings.knowledgeFolder),
			this.settings.convertedMdFolder ? this.rootPath(this.settings.convertedMdFolder) : "",
		];
		for (const folder of initFolders) {
			try {
				await ensureFolder(this.app, folder);
			} catch (err) {
				logError("ensure folder failed: " + folder, err);
			}
		}

		this.registerView(SIDEBAR_VIEW_TYPE, (leaf) => new MainSidebarView(leaf, this));
		this.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, this));
		this.addSettingTab(new QuestionGeneratorSettingTab(this.app, this));

		this.addRibbonIcon("pencil", t("智学助手"), async () => {
			const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
			if (leaves.length > 0) {
				await this.app.workspace.revealLeaf(leaves[0]!);
			} else {
				const leaf = this.app.workspace.getRightLeaf(false);
				if (leaf) {
					await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
				}
			}
		});

		this.app.workspace.onLayoutReady(async () => {
			const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
			if (leaves.length === 0) {
				const leaf = this.app.workspace.getRightLeaf(false);
				if (leaf) {
					await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
				}
			}
			// AI 对话已内嵌到智学助手侧边栏，关闭旧的独立对话标签页
			for (const chatLeaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) chatLeaf.detach();
			void (async () => {
				try {
					await this.migrateOldWrongAnswers();
					await this.migrateKnowledgeLinks();
				} catch (err) { logError("startup migration", err); }
			})();
			if (this.settings.autoReviewReminder) {
				try {
					const notes = await this.loadAllWrongNotes();
					const dueCount = notes.filter(n => isDueForReview(n)).length;
					if (dueCount > 0) {
						this.registerInterval(window.setTimeout(() => {
							const notice = new Notice(tf("你有 {n} 道错题待复习，点击开始", { n: dueCount }), NOTICE_DURATION_MS);
							notice.messageEl.addEventListener("click", () => {
								void (async () => {
									const view = await this.activateSidebar();
									if (view) { view.activeSection = "wrong"; view.wrongView = "list"; await view.render(); }
								})();
							});
						}, REVIEW_REMINDER_DELAY_MS));
					}
				} catch { /* empty */ }
			}
		});

		this.addCommand({ id: "open-sidebar", name: t("打开智学助手侧边栏"), callback: async () => {
			await this.activateSidebar();
		}});
		this.addCommand({ id: "view-history", name: t("查看题目生成历史记录"), callback: async () => {
			const view = await this.activateSidebar();
			if (view) { view.activeSection = "home"; view.homeView = "history"; await view.render(); }
		}});
		this.addCommand({ id: "view-wrong-answers", name: t("查看错题本"), callback: async () => {
			const view = await this.activateSidebar();
			if (view) { view.activeSection = "wrong"; view.wrongView = "list"; await view.render(); }
		}});
		this.addCommand({ id: "rebuild-knowledge-index", name: t("重建知识点索引"), callback: async () => {
			const report = await this.rebuildKnowledgeIndex();
			const extra: string[] = [];
			if (report.brokenLinks > 0) extra.push(tf("失效链接 {n} 处", { n: report.brokenLinks }));
			if (report.duplicates > 0) extra.push(tf("疑似重复文件 {n} 组", { n: report.duplicates }));
			new Notice(extra.length > 0 ? t("知识点索引已重建") + "：" + extra.join("，") : t("知识点索引已重建"));
		} });
		this.addCommand({
			id: "generate-from-current",
			name: t("基于当前文档生成试题"),
			callback: async () => {
				const view = await this.activateSidebar();
				if (view) { view.activeSection = "home"; view.openGeneratePicker(); }
			}
		});
		this.addCommand({
			id: "extract-from-current",
			name: t("识别当前文件试卷"),
			callback: async () => {
				const file = this.app.workspace.getActiveFile();
				if (!file) { new Notice(t("请先打开一个试卷文件（md/txt/rtf/docx/pdf/图片）")); return; }
				const view = await this.activateSidebar();
				if (view) { view.activeSection = "home"; await view.openCurrentFileExtract(); }
			}
		});

		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			try {
				if (file instanceof TFolder) {
					menu.addItem(item => item.setTitle(t("选择文件生成题目")).onClick(async () => {
						const view = await this.activateSidebar();
						if (view) { view.activeSection = "home"; view.openGeneratePicker(file.path); }
					}));
				}
				if (file instanceof TFile) {
					const ext = file.extension.toLowerCase();
					const isExamSource = ext === "md" || EXAM_SOURCE_EXTS.includes(ext);
					if (ext === "md") {
						menu.addItem(item => item.setTitle(t("基于本文档生成试题")).onClick(async () => {
							const text = await this.app.vault.read(file);
							const view = await this.activateSidebar();
							if (view) { view.activeSection = "home"; view.homeView = "generate"; view.genSourceText = text; view.genFileName = file.name; view.genSourcePath = file.path; await view.render(); }
						}));
					}
					if (isExamSource) {
						menu.addItem(item => item.setTitle(t("识别本文档试卷")).onClick(async () => {
							const view = await this.activateSidebar();
							if (view) { view.activeSection = "home"; await view.openCurrentFileExtract(file); }
						}));
					}
				}
			} catch (e) {
				logError("file-menu error", e);
			}
		}));

		this.registerEvent(this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
			try {
				const selectText = editor.getSelection();
				if (selectText && selectText.trim().length > 0) {
					const snippetFallback = t("片段");
					const fileName = ("file" in info ? info.file?.name : undefined) || snippetFallback;
					const filePath = ("file" in info ? info.file?.path : undefined) || "";
					menu.addItem(item => item.setTitle(t("基于选中内容生成试题")).onClick(async () => {
						let fullText = selectText;
						if (fileName && fileName !== snippetFallback) {
							try {
								const file = this.app.vault.getAbstractFileByPath(filePath);
								if (file instanceof TFile) {
									const fileTitle = file.basename;
									fullText = "文档标题：" + fileTitle + "\n\n" + selectText;
								}
							} catch { /* empty */ }
						}
						const sidebarView = await this.activateSidebar();
						if (sidebarView) { sidebarView.activeSection = "home"; sidebarView.homeView = "generate"; sidebarView.genSourceText = fullText; sidebarView.genFileName = fileName; sidebarView.genSourcePath = filePath; await sidebarView.render(); }
					}));
				}
			} catch (e) {
				logError("editor-menu error", e);
			}
		}));

		this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => {
			try {
				if (evt.ctrlKey && evt.key === "q") {
					evt.preventDefault();
					const file = this.app.workspace.getActiveFile();
					if (file && file.extension === "md") {
						this.app.vault.read(file).then(async text => {
							const view = await this.activateSidebar();
							if (view) { view.activeSection = "home"; view.homeView = "generate"; view.genSourceText = text; view.genFileName = file.name; view.genSourcePath = file.path; await view.render(); }
						}).catch(e => logError("read active file", e));
					} else {
						new Notice(t("请先打开一个Markdown文档再使用 Ctrl+Q"));
					}
				}
			} catch (e) {
				logError("keydown error", e);
			}
		});
	}
	onunload() {
		const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
		for (const leaf of leaves) { leaf.detach(); }
		const chatLeaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
		for (const leaf of chatLeaves) { leaf.detach(); }
	}
}

// ===================== 公共导出（保持向后兼容） =====================
export { t, tf, setLanguage, getLanguage, zh, en } from "./i18n/index";
export { DEFAULT_SETTINGS, SYSTEM_TAGS, SIDEBAR_VIEW_TYPE, CHAT_VIEW_TYPE } from "./constants";
export { parseFM, buildFM, knowledgeTags, buildKnowledgeLinks } from "./utils/frontmatter";
export { isAbs, daysUntil, ensureFolderAbs, writeFileStr, readFileStr, listMdFiles, listMdFilesRecursive, listFilesRecursive, isImageFile, isDocumentFile, IMAGE_EXTS, DOCUMENT_EXTS, EXAM_SOURCE_EXTS, deleteFileAbs, ensureFolder, parseExcludeFolderNames, isExcludedPath, joinPath } from "./utils/fs-utils";
export { safeName, cleanSourceText, estimateTokens, stripAnswersForExport, htmlEscape } from "./utils/text";
export { DEFAULT_WRONG_INTERVALS, DEFAULT_QUESTION_INTERVALS, DEFAULT_NOTE_INTERVALS, parseReviewIntervals, reviewUpdate, todayStr, isDueForReview } from "./utils/review";
export { stripMd, parseQuestions } from "./utils/parse";
export { extractKnowledgeTags } from "./utils/tags";
export { debounce } from "./utils/debounce";
export { buildFileTree } from "./utils/filetree";
export { stripAnswerSummarySection, splitSemantic, normalizeAnswerSteps, splitAnswerContent, fixSequentialNumbers, normalizeExamContent, highlightTechTerms, highlightTechHtml } from "./utils/layout";
export { buildWordParagraphs, buildExportHtml, parseExamBlocks, exportPdfDirect } from "./utils/exporter";
export { getElectronRemote } from "./utils/electron";
export { chatLLM, chatMessage } from "./services/llmService";
export { getScopeFiles, retrieveContext, buildChatPrompt, tokenize, rankCandidates, buildReferenceBlock } from "./services/chatService";
export { pruneHistory } from "./utils/history";
export { buildExamExtractPrompt, buildGeneratePrompt, parseTypeSpec, parseAITagsFromResult, mergeExamChunks } from "./services/questionService";
export { KnowledgeService, buildTaggingPrompt, parseTaggedResult } from "./services/knowledgeService";
export { VaultDataService } from "./services/vaultDataService";
export { convertDocumentToText, stripRtf, htmlToMarkdown } from "./services/documentService";
export type { OllamaResponse, OpenAIResponse, FmValue, HistoryEntry, WrongAnswerNote, QuestionType, ParsedQuestion, PluginSettings, TreeNode, SectionKey, HomeViewKey, SortMode, ReviewFilterType, ReviewSource, ChatMessage, ChatSearchScope } from "./types";
export { MainSidebarView } from "./views/sidebarView";
export { ChatView } from "./views/chatView";
export { QuestionGeneratorSettingTab } from "./views/settingTab";
