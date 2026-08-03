import { Plugin, TFile, TFolder, Notice, Editor, Menu, MarkdownView, MarkdownFileInfo } from "obsidian";
import { Document, Packer } from "docx";
import * as fs from "fs";
import * as path from "path";

import { DEFAULT_SETTINGS, SIDEBAR_VIEW_TYPE, NOTICE_DURATION_MS, REVIEW_REMINDER_DELAY_MS, WRONG_NOTES_CACHE_TTL_MS } from "./constants";
import type { HistoryEntry, WrongAnswerNote, PluginSettings } from "./types";
import { parseFM, buildFM } from "./utils/frontmatter";
import { isAbs, ensureFolderAbs, writeFileStr, readFileStr, listMdFiles, listMdFilesRecursive, ensureFolder, EXAM_SOURCE_EXTS, isExcludedPath, joinPath } from "./utils/fs-utils";
import { safeName } from "./utils/text";
import { isDueForReview } from "./utils/review";
import { stripAnswerSummarySection } from "./utils/layout";
import { buildWordParagraphs, exportPdfDirect } from "./utils/exporter";
import { getElectronRemote } from "./utils/electron";
import { KnowledgeService, type IndexSource } from "./services/knowledgeService";
import { MainSidebarView } from "./views/sidebarView";
import { QuestionGeneratorSettingTab } from "./views/settingTab";

// ===================== 主插件入口 =====================

export default class QuestionGeneratorPlugin extends Plugin {
	settings!: PluginSettings;
	history: HistoryEntry[] = [];
	knowledgeService = new KnowledgeService(this);

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
		await this.saveHistory();
	}

	async migrateOldWrongAnswers() {
		const data = await this.loadData() as { wrongAnswers?: { timestamp?: number; fileName?: string; note?: string; resultText?: string }[] } | null;
		if (data?.wrongAnswers && data.wrongAnswers.length > 0) {
			const folder = this.rootPath(this.settings.wrongBookFolder);
			await ensureFolder(this.app, folder);
			let migrated = 0;
			for (const old of data.wrongAnswers) {
				const dateStr = old.timestamp ? new Date(old.timestamp).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
				const tags = ["错题"];
				const fm = buildFM({ source: old.fileName || "未知", date: dateStr, tags, note: old.note || "" });
				const content = fm + (old.resultText || "");
				const fileName = safeName(old.fileName || "未知") + "_错题_" + dateStr + "_" + migrated + ".md";
				try {
					if (isAbs(folder)) writeFileStr(joinPath(folder, fileName), content);
					else await this.app.vault.create(folder + "/" + fileName, content);
					migrated++;
				} catch { /* empty */ }
			}
			if (migrated > 0) new Notice("已迁移 " + migrated + " 条旧错题到 " + folder);
			data.wrongAnswers = [];
			await this.saveData({ ...this.settings, history: this.history, wrongAnswers: [] });
		}
	}

	// ===================== 集中数据管理 =====================
	private _wrongNotesCache: WrongAnswerNote[] | null = null;
	private _cacheTime = 0;
	private _refreshCallbacks: (() => void)[] = [];

	invalidateCache() { this._wrongNotesCache = null; this._cacheTime = 0; }

	onDataChanged(callback: () => void) { this._refreshCallbacks.push(callback); }

	offDataChanged(callback: () => void) { this._refreshCallbacks = this._refreshCallbacks.filter(cb => cb !== callback); }

	emitDataChanged() { this.invalidateCache(); for (const cb of this._refreshCallbacks) { try { cb(); } catch { /* empty */ } } }

	async loadAllWrongNotes(forceRefresh = false): Promise<WrongAnswerNote[]> {
		const now = Date.now();
		if (!forceRefresh && this._wrongNotesCache && (now - this._cacheTime < WRONG_NOTES_CACHE_TTL_MS)) {
			return this._wrongNotesCache;
		}
		const notes: WrongAnswerNote[] = [];
		const folder = this.rootPath(this.settings.wrongBookFolder);
		const excludes = this.settings.excludeFolders || "";
		if (isAbs(folder)) {
			ensureFolderAbs(folder);
			for (const f of listMdFilesRecursive(folder)) {
				const fp = f.replace(/\\/g, "/");
				if (isExcludedPath(fp, excludes)) continue;
				const { meta, body } = parseFM(readFileStr(fp));
				notes.push({ filePath: fp, baseName: path.basename(fp).replace(/\.md$/, ""), date: (meta.date as string) || "", sourceFile: (meta.source as string) || "", sourcePath: (meta.sourcePath as string) || "", tags: Array.isArray(meta.tags) ? meta.tags : [], resultText: body, note: (meta.note as string) || "", nextReview: (meta.nextReview as string) || "", interval: typeof meta.interval === "number" ? meta.interval : 1, correctCount: typeof meta.correctCount === "number" ? meta.correctCount : 0, wrongCount: typeof meta.wrongCount === "number" ? meta.wrongCount : 1 });
			}
		} else {
			const prefix = folder.endsWith("/") ? folder : folder + "/";
			for (const child of this.app.vault.getFiles()) {
				if (child.extension !== "md" || !child.path.startsWith(prefix)) continue;
				if (isExcludedPath(child.path, excludes)) continue;
				const { meta, body } = parseFM(await this.app.vault.read(child));
				notes.push({ filePath: child.path, baseName: child.basename, date: (meta.date as string) || "", sourceFile: (meta.source as string) || "", sourcePath: (meta.sourcePath as string) || "", tags: Array.isArray(meta.tags) ? meta.tags : [], resultText: body, note: (meta.note as string) || "", nextReview: (meta.nextReview as string) || "", interval: typeof meta.interval === "number" ? meta.interval : 1, correctCount: typeof meta.correctCount === "number" ? meta.correctCount : 0, wrongCount: typeof meta.wrongCount === "number" ? meta.wrongCount : 1 });
			}
		}
		this._wrongNotesCache = notes;
		this._cacheTime = now;
		return notes;
	}

	async loadAllQuestionFilesForReview(): Promise<WrongAnswerNote[]> {
		const folder = this.rootPath(this.settings.questionFolder);
		const excludes = [this.rootPath(this.settings.knowledgeFolder)].filter(Boolean);
		const excludeCfg = this.settings.excludeFolders || "";
		const notes: WrongAnswerNote[] = [];
		if (isAbs(folder)) {
			ensureFolderAbs(folder);
			for (const f of listMdFilesRecursive(folder, excludes)) {
				const fp = f.replace(/\\/g, "/");
				if (isExcludedPath(fp, excludeCfg)) continue;
				const { meta, body } = parseFM(readFileStr(fp));
				notes.push({ filePath: fp, baseName: path.basename(fp).replace(/\.md$/, ""), date: (meta.date as string) || "", sourceFile: (meta.source as string) || "", sourcePath: (meta.sourcePath as string) || "", tags: Array.isArray(meta.tags) ? meta.tags : [], resultText: body, note: (meta.note as string) || "", nextReview: (meta.nextReview as string) || "", interval: typeof meta.interval === "number" ? meta.interval : 1, correctCount: typeof meta.correctCount === "number" ? meta.correctCount : 0, wrongCount: typeof meta.wrongCount === "number" ? meta.wrongCount : 0 });
			}
		} else {
			const folderFile = this.app.vault.getAbstractFileByPath(folder);
			if (folderFile instanceof TFolder) {
				const prefix = folder.endsWith("/") ? folder : folder + "/";
				const exclPrefixes = excludes.map(p => (p.endsWith("/") ? p : p + "/"));
				const children = this.app.vault.getFiles().filter(f => f.path.startsWith(prefix) && f.extension === "md" && !exclPrefixes.some(e => f.path.startsWith(e)) && !isExcludedPath(f.path, excludeCfg));
				for (const child of children) {
					const { meta, body } = parseFM(await this.app.vault.read(child));
					notes.push({ filePath: child.path, baseName: child.basename, date: (meta.date as string) || "", sourceFile: (meta.source as string) || "", sourcePath: (meta.sourcePath as string) || "", tags: Array.isArray(meta.tags) ? meta.tags : [], resultText: body, note: (meta.note as string) || "", nextReview: (meta.nextReview as string) || "", interval: typeof meta.interval === "number" ? meta.interval : 1, correctCount: typeof meta.correctCount === "number" ? meta.correctCount : 0, wrongCount: typeof meta.wrongCount === "number" ? meta.wrongCount : 0 });
				}
			}
		}
		return notes;
	}

	async loadAllVaultNotesForReview(): Promise<WrongAnswerNote[]> {
		const folder = this.rootPath(this.settings.noteViewFolder);
		const excludeCfg = this.settings.excludeFolders || "";
		const notes: WrongAnswerNote[] = [];
		if (!folder) return notes;
		if (isAbs(folder)) {
			ensureFolderAbs(folder);
			for (const f of listMdFilesRecursive(folder)) {
				const fp = f.replace(/\\/g, "/");
				if (isExcludedPath(fp, excludeCfg)) continue;
				const { meta, body } = parseFM(readFileStr(fp));
				notes.push({ filePath: fp, baseName: path.basename(fp).replace(/\.md$/, ""), date: (meta.date as string) || "", sourceFile: (meta.source as string) || path.basename(fp).replace(/\.md$/, ""), sourcePath: (meta.sourcePath as string) || "", tags: Array.isArray(meta.tags) ? meta.tags : [], resultText: body, note: (meta.note as string) || "", nextReview: (meta.nextReview as string) || "", interval: typeof meta.interval === "number" ? meta.interval : 1, correctCount: typeof meta.correctCount === "number" ? meta.correctCount : 0, wrongCount: typeof meta.wrongCount === "number" ? meta.wrongCount : 0 });
			}
		} else {
			const prefix = folder.endsWith("/") ? folder : folder + "/";
			for (const child of this.app.vault.getFiles()) {
				if (child.extension !== "md" || !child.path.startsWith(prefix)) continue;
				if (isExcludedPath(child.path, excludeCfg)) continue;
				const { meta, body } = parseFM(await this.app.vault.read(child));
				notes.push({ filePath: child.path, baseName: child.basename, date: (meta.date as string) || "", sourceFile: (meta.source as string) || child.basename, sourcePath: (meta.sourcePath as string) || "", tags: Array.isArray(meta.tags) ? meta.tags : [], resultText: body, note: (meta.note as string) || "", nextReview: (meta.nextReview as string) || "", interval: typeof meta.interval === "number" ? meta.interval : 1, correctCount: typeof meta.correctCount === "number" ? meta.correctCount : 0, wrongCount: typeof meta.wrongCount === "number" ? meta.wrongCount : 0 });
			}
		}
		return notes;
	}

	async loadExistingKnowledgeTags(): Promise<string[]> {
		return this.knowledgeService.loadExistingKnowledgeTags();
	}

	async syncKnowledgeFolder(tags: string[], links: { label: string; path: string }[], source: IndexSource = "错题", folderOverride?: string) {
		return this.knowledgeService.syncKnowledgeFolder(tags, links, source, folderOverride);
	}

	async rebuildKnowledgeIndex() {
		return this.knowledgeService.rebuildKnowledgeIndex();
	}

	async deleteWrongNote(filePath: string) {
		if (isAbs(filePath)) {
			if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
		} else {
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile) await this.app.fileManager.trashFile(file);
		}
		this.invalidateCache();
		await this.rebuildKnowledgeIndex();
	}

	async getWeakPoints(): Promise<{ tag: string; count: number; questions: WrongAnswerNote[] }[]> {
		return this.knowledgeService.getWeakPoints();
	}

	async migrateKnowledgeLinks() {
		return this.knowledgeService.migrateKnowledgeLinks();
	}

	async exportToFile(text: string, defaultName: string, format: "md" | "word" | "pdf", title?: string, source?: string) {
		try {
			
			if (format === "md") {
				const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: defaultName + ".md", filters: [{ name: "Markdown", extensions: ["md"] }] });
				if (r.canceled || !r.filePath) return;
				const dateStr = new Date().toISOString().slice(0, 10);
				const mdHeader = title ? "# " + title + "\n\n> 来源：" + (source || title) + "　|　日期：" + dateStr + "\n\n" : "";
				fs.writeFileSync(r.filePath, mdHeader + stripAnswerSummarySection(text), "utf-8");
				new Notice("Md文件已保存");
			} else if (format === "word") {
				const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: defaultName + ".docx", filters: [{ name: "Word", extensions: ["docx"] }] });
				if (r.canceled || !r.filePath) return;
				const children = buildWordParagraphs(text, title, source);
				const doc = new Document({ sections: [{ properties: {}, children }] });
				const buffer = await Packer.toBuffer(doc);
				fs.writeFileSync(r.filePath, Buffer.from(buffer));
				new Notice("Word文件已保存");
			} else if (format === "pdf") {
				const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: defaultName + ".pdf", filters: [{ name: "PDF", extensions: ["pdf"] }] });
				if (r.canceled || !r.filePath) return;
				await exportPdfDirect(r.filePath, text, title, source);
				new Notice("PDF文件已保存");
			}
		} catch (err) { new Notice("导出失败：" + (err as Error).message); }
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

	async onload() {
		await this.loadSettings();

		try {
			if (this.settings.rootFolder) await ensureFolder(this.app, this.settings.rootFolder);
			await ensureFolder(this.app, this.rootPath(this.settings.questionFolder));
			await ensureFolder(this.app, this.rootPath(this.settings.wrongBookFolder));
			await ensureFolder(this.app, this.rootPath(this.settings.noteViewFolder));
			await ensureFolder(this.app, this.rootPath(this.settings.extractedExamFolder));
			await ensureFolder(this.app, this.rootPath(this.settings.knowledgeFolder));
			if (this.settings.convertedMdFolder) await ensureFolder(this.app, this.rootPath(this.settings.convertedMdFolder));
		} catch (err) {
			console.error("[question-generator] 启动初始化错误:", err);
		}

		this.registerView(SIDEBAR_VIEW_TYPE, (leaf) => new MainSidebarView(leaf, this));
		this.addSettingTab(new QuestionGeneratorSettingTab(this.app, this));

		this.addRibbonIcon("pencil", "智学助手", async () => {
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
			void (async () => {
				try {
					await this.migrateOldWrongAnswers();
					await this.migrateKnowledgeLinks();
				} catch { /* empty */ }
			})();
			if (this.settings.autoReviewReminder) {
				try {
					const notes = await this.loadAllWrongNotes();
					const dueCount = notes.filter(n => isDueForReview(n)).length;
					if (dueCount > 0) {
						this.registerInterval(window.setTimeout(() => {
							const notice = new Notice("你有 " + dueCount + " 道错题待复习，点击开始", NOTICE_DURATION_MS);
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

		this.addCommand({ id: "open-sidebar", name: "打开智学助手侧边栏", callback: async () => {
			await this.activateSidebar();
		}});
		this.addCommand({ id: "view-history", name: "查看题目生成历史记录", callback: async () => {
			const view = await this.activateSidebar();
			if (view) { view.activeSection = "home"; view.homeView = "history"; await view.render(); }
		}});
		this.addCommand({ id: "view-wrong-answers", name: "查看错题本", callback: async () => {
			const view = await this.activateSidebar();
			if (view) { view.activeSection = "wrong"; view.wrongView = "list"; await view.render(); }
		}});
		this.addCommand({ id: "rebuild-knowledge-index", name: "重建知识点索引", callback: async () => { await this.rebuildKnowledgeIndex(); new Notice("知识点索引已重建"); } });
		this.addCommand({
			id: "generate-from-current",
			name: "基于当前文档生成试题",
			callback: async () => {
				const view = await this.activateSidebar();
				if (view) { view.activeSection = "home"; view.openGeneratePicker(); }
			}
		});
		this.addCommand({
			id: "extract-from-current",
			name: "识别当前文件试卷",
			callback: async () => {
				const file = this.app.workspace.getActiveFile();
				if (!file) { new Notice("请先打开一个试卷文件（md/txt/rtf/docx/pdf/图片）"); return; }
				const view = await this.activateSidebar();
				if (view) { view.activeSection = "home"; await view.openCurrentFileExtract(); }
			}
		});

		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			try {
				if (file instanceof TFolder) {
					menu.addItem(item => item.setTitle("选择文件生成题目").onClick(async () => {
						const view = await this.activateSidebar();
						if (view) { view.activeSection = "home"; view.openGeneratePicker(file.path); }
					}));
				}
				if (file instanceof TFile) {
					const ext = file.extension.toLowerCase();
					const isExamSource = ext === "md" || EXAM_SOURCE_EXTS.includes(ext);
					if (ext === "md") {
						menu.addItem(item => item.setTitle("基于本文档生成试题").onClick(async () => {
							const text = await this.app.vault.read(file);
							const view = await this.activateSidebar();
							if (view) { view.activeSection = "home"; view.homeView = "generate"; view.genSourceText = text; view.genFileName = file.name; view.genSourcePath = file.path; await view.render(); }
						}));
					}
					if (isExamSource) {
						menu.addItem(item => item.setTitle("识别本文档试卷").onClick(async () => {
							const view = await this.activateSidebar();
							if (view) { view.activeSection = "home"; await view.openCurrentFileExtract(file); }
						}));
					}
				}
			} catch (e) {
				console.error("[question-generator] file-menu error:", e);
			}
		}));

		this.registerEvent(this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
			try {
				const selectText = editor.getSelection();
				if (selectText && selectText.trim().length > 0) {
					const fileName = ("file" in info ? info.file?.name : undefined) || "片段";
					const filePath = ("file" in info ? info.file?.path : undefined) || "";
					menu.addItem(item => item.setTitle("基于选中内容生成试题").onClick(async () => {
						let fullText = selectText;
						if (fileName && fileName !== "片段") {
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
				console.error("[question-generator] editor-menu error:", e);
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
						}).catch(e => console.error("[question-generator]", e));
				} else {
					new Notice("请先打开一个Markdown文档再使用 Ctrl+Q");
				}
			}
		} catch (e) {
				console.error("[question-generator] keydown error:", e);
			}
		});
	}
	onunload() {
		const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
		for (const leaf of leaves) { leaf.detach(); }
	}
}

// ===================== 公共导出（保持向后兼容） =====================
export { DEFAULT_SETTINGS, SYSTEM_TAGS, SIDEBAR_VIEW_TYPE } from "./constants";
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
export { chatLLM } from "./services/llmService";
export { buildExamExtractPrompt, buildGeneratePrompt, parseTypeSpec, parseAITagsFromResult, mergeExamChunks } from "./services/questionService";
export { KnowledgeService, buildTaggingPrompt, parseTaggedResult } from "./services/knowledgeService";
export { convertDocumentToText, stripRtf, htmlToMarkdown } from "./services/documentService";
export type { OllamaResponse, OpenAIResponse, FmValue, HistoryEntry, WrongAnswerNote, QuestionType, ParsedQuestion, PluginSettings, TreeNode, SectionKey, HomeViewKey, SortMode, ReviewFilterType, ReviewSource } from "./types";
export { MainSidebarView } from "./views/sidebarView";
export { QuestionGeneratorSettingTab } from "./views/settingTab";
