import { Plugin, TFile, TFolder, Notice, Editor, Menu, MarkdownView, MarkdownFileInfo } from "obsidian";

import { DEFAULT_SETTINGS, SIDEBAR_VIEW_TYPE, NOTICE_DURATION_MS, REVIEW_REMINDER_DELAY_MS, HISTORY_LIMIT, HISTORY_RESULT_CHARS } from "./constants";
import type { HistoryEntry, WrongAnswerNote, PluginSettings, ChatMessage } from "./types";
import { type ChatAdapter } from "./utils/chatStorage";
import { isAbs, ensureFolder, EXAM_SOURCE_EXTS } from "./utils/fs-utils";
import { isDueForReview } from "./utils/review";
import { pruneHistory } from "./utils/history";
import { logError } from "./utils/log";
import { KnowledgeService, type IndexSource } from "./services/knowledgeService";
import { VaultDataService } from "./services/vaultDataService";
import { MainSidebarView } from "./views/sidebarView";
import { QuestionGeneratorSettingTab } from "./views/settingTab";
import { setLanguage, t, tf } from "./i18n/index";

// ===================== 主插件入口 =====================

export default class QuestionGeneratorPlugin extends Plugin {
	settings!: PluginSettings;
	history: HistoryEntry[] = [];
	knowledgeService = new KnowledgeService(this);
	vaultData = new VaultDataService(this);

	async loadSettings() {
		const data = await this.loadData() as { history?: HistoryEntry[]; wrongAnswers?: { timestamp?: number; fileName?: string; note?: string; resultText?: string }[]; chatHistory?: ChatMessage[] } | null;
		const raw = data ? { ...data } as Record<string, unknown> : {};
		delete raw.chatHistory;
		delete raw.questionKnowledgeFolder;
		delete raw.noteKnowledgeFolder;
		delete raw.wrongKnowledgeFolder;
		delete raw.wrongReviewIntervals;
		delete raw.questionReviewIntervals;
		delete raw.noteReviewIntervals;
		const legacyKf = ["题目/知识点", "笔记/知识点", "错题/知识点", "错题本/知识点"];
		if (typeof raw.knowledgeFolder === "string" && legacyKf.includes(raw.knowledgeFolder)) {
			raw.knowledgeFolder = DEFAULT_SETTINGS.knowledgeFolder;
		}
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
		if (data?.history) this.history = data.history;
		this.history = pruneHistory(this.history, HISTORY_LIMIT, HISTORY_RESULT_CHARS);
		setLanguage(this.settings.language || "zh");
	}

	/** 聊天文件系统的 adapter（路径相对 vault 根）。 */
	chatAdapter(): ChatAdapter {
		const a = this.app.vault.adapter;
		const base = this.app.vault.configDir + "/plugins/" + (this.manifest?.id || "smart-quiz-tutor");
		const join = (p: string) => base + "/" + p;
		return {
			read: (p) => a.read(join(p)),
			write: (p, d) => a.write(join(p), d),
			exists: (p) => a.exists(join(p)),
			mkdir: (p) => a.mkdir(join(p)),
			list: (p) => a.list(join(p)),
			remove: (p) => a.remove(join(p)),
			rmdir: (p) => a.rmdir(join(p), false),
		};
	}

	/** 清理旧版「工作区」目录布局（只保留 sessions/ 与 meta.json）。 */
	async cleanupLegacyChatWorkspaces(): Promise<void> {
		try {
			const adapter = this.chatAdapter();
			let folders: string[] = [];
			try { folders = (await adapter.list("chat-data")).folders.map(f => f.split("/").pop() || f); } catch { return; }
			for (const f of folders) {
				if (f === "sessions") continue;
				const dir = "chat-data/" + f;
				try {
					const listing = await adapter.list(dir);
					for (const file of listing.files) await adapter.remove(dir + "/" + file);
					for (const sub of listing.folders) await adapter.rmdir(dir + "/" + sub);
					await adapter.rmdir(dir);
				} catch { /* ignore */ }
			}
		} catch (e) {
			logError("chat cleanup", e);
		}
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

	async deleteWrongNote(filePath: string, skipRebuild = false): Promise<void> {
		return this.vaultData.deleteWrongNote(filePath, skipRebuild);
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

	/** 语言切换后刷新已打开的侧边栏头部/导航文案。 */
	refreshSidebarChrome() {
		for (const leaf of this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE)) {
			const view = leaf.view as MainSidebarView;
			view.refreshChrome?.();
		}
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
		this.addSettingTab(new QuestionGeneratorSettingTab(this.app, this));

		this.addRibbonIcon("pencil", t("智学助手"), async () => {
			await this.activateSidebar();
		});

		this.app.workspace.onLayoutReady(async () => {
			const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
			if (leaves.length === 0) {
				const leaf = this.app.workspace.getRightLeaf(false);
				if (leaf) {
					await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
				}
			}
			void (async () => {
				try {
					await this.migrateOldWrongAnswers();
					await this.migrateKnowledgeLinks();
					await this.cleanupLegacyChatWorkspaces();
				} catch (err) { logError("startup migration", err); }
			})();
			if (this.settings.autoReviewReminder) {
				try {
					const notes = await this.loadAllWrongNotes();
					const dueCount = notes.filter(n => isDueForReview(n)).length;
					if (dueCount > 0) {
						// 这是一次性定时器：用 register(clearTimeout) 而不是 registerInterval。
						// 两者的 id 空间恰好共用、清得掉，但语义对不上，后人容易误读成「每分钟提醒一次」。
						const timer = window.setTimeout(() => {
							const notice = new Notice(tf("你有 {n} 道错题待复习，点击开始", { n: dueCount }), NOTICE_DURATION_MS);
							notice.messageEl.addEventListener("click", () => {
								void (async () => {
									const view = await this.activateSidebar();
									if (view) { view.activeSection = "wrong"; view.wrongView = "list"; await view.render(); }
								})();
							});
						}, REVIEW_REMINDER_DELAY_MS);
						this.register(() => window.clearTimeout(timer));
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
			id: "generate-from-active",
			name: t("基于当前文档直接生成试题"),
			callback: async () => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") { new Notice(t("请先打开一个Markdown文档")); return; }
				try {
					const text = await this.app.vault.read(file);
					const view = await this.activateSidebar();
					if (view) { view.activeSection = "home"; view.homeView = "generate"; view.genSourceText = text; view.genFileName = file.name; view.genSourcePath = file.path; await view.render(); }
				} catch (e) { logError("read active file", e); }
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
	}
	onunload() {
		// 视图的 onClose 会自行 offDataChanged；这里兜住「leaf 被直接销毁、没走 onClose」的情况，
		// 否则残留的回调会在插件卸载后仍被 emitDataChanged 触发。
		this._refreshCallbacks = [];
		const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
		for (const leaf of leaves) { leaf.detach(); }
	}
}

// ===================== 公共导出（保持向后兼容） =====================
export { t, tf, setLanguage, getLanguage, zh, en } from "./i18n/index";
export { DEFAULT_SETTINGS, SYSTEM_TAGS, SIDEBAR_VIEW_TYPE, EASE_PRESETS, EASE_MIN, EASE_MAX } from "./constants";
export { parseFM, buildFM, patchFrontmatter, knowledgeTags, buildKnowledgeLinks } from "./utils/frontmatter";
export { isAbs, daysUntil, ensureFolderAbs, writeFileStr, readFileStr, listMdFiles, listMdFilesRecursive, listFilesRecursive, isImageFile, isDocumentFile, IMAGE_EXTS, DOCUMENT_EXTS, EXAM_SOURCE_EXTS, trashFileAbs, TRASH_DIR_NAME, ensureFolder, parseExcludeFolderNames, isExcludedPath, joinPath } from "./utils/fs-utils";
export { safeName, cleanSourceText, estimateTokens, stripAnswersForExport, extractAnswersForExport, htmlEscape } from "./utils/text";
export { todayStr, isDueForReview } from "./utils/review";
export { sm2Update, clampEase, DEFAULT_EASE_FACTOR, MIN_EASE_FACTOR, QUALITY } from "./utils/sm2";
export { localDateStr, addDaysStr } from "./utils/date";
export { loadSessions, listSessionIds, loadSession, saveSession, createSession, deleteSession, renameSession, setSessionScope, setActiveSession, loadMeta, saveMeta, autoTitle, genId, capMessages, planCompression, collectSummaries, buildRequestMessages, type ChatAdapter, type CompressionPlan } from "./utils/chatStorage";
export { stripMd, parseQuestions } from "./utils/parse";
export { extractKnowledgeTags } from "./utils/tags";
export { debounce } from "./utils/debounce";
export { buildFileTree } from "./utils/filetree";
export { stripAnswerSummarySection, splitSemantic, normalizeAnswerSteps, splitAnswerContent, fixSequentialNumbers, normalizeExamContent, highlightTechTerms, highlightTechHtml } from "./utils/layout";
export { buildWordParagraphs, buildExportHtml, parseExamBlocks, exportPdfDirect } from "./utils/exporter";
export { getElectronRemote, getElectronShell, hasElectronRemote } from "./utils/electron";
export { chatLLM, chatMessage, joinApiUrl } from "./services/llmService";
export { getScopeFiles, retrieveContext, buildChatPrompt, buildCompressPrompt, tokenize, rankCandidates, buildReferenceBlock } from "./services/chatService";
export { pruneHistory } from "./utils/history";
export { buildExamExtractPrompt, buildGeneratePrompt, parseTypeSpec, parseAITagsFromResult, mergeExamChunks } from "./services/questionService";
export { KnowledgeService, buildTaggingPrompt, parseTaggedResult } from "./services/knowledgeService";
export { VaultDataService } from "./services/vaultDataService";
export { convertDocumentToText, stripRtf, htmlToMarkdown, decodeTextBytes } from "./services/documentService";
export type { OllamaResponse, OpenAIResponse, FmValue, HistoryEntry, WrongAnswerNote, QuestionType, ParsedQuestion, PluginSettings, TreeNode, SectionKey, HomeViewKey, SortMode, ReviewFilterType, ReviewSource, ChatMessage, ChatSearchScope } from "./types";
export { MainSidebarView } from "./views/sidebarView";
export { QuestionGeneratorSettingTab } from "./views/settingTab";
