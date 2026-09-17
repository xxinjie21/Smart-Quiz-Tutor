import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import * as fs from "fs";

import type QuestionGeneratorPlugin from "../main";
import {
	SIDEBAR_VIEW_TYPE,
	AI_REQUEST_TIMEOUT_MS,
} from "../constants";
import type { WrongAnswerNote, ParsedQuestion, TreeNode } from "../types";
import type { IndexSource } from "../services/knowledgeService";
import { parseFM, buildFM, knowledgeTags } from "../utils/frontmatter";
import { isAbs, writeFileStr, readFileStr, ensureFolder, isImageFile, isDocumentFile, EXAM_SOURCE_EXTS, joinPath } from "../utils/fs-utils";
import { convertDocumentToText } from "../services/documentService";
import { DEFAULT_WRONG_INTERVALS, DEFAULT_QUESTION_INTERVALS, DEFAULT_NOTE_INTERVALS, parseReviewIntervals, reviewUpdate } from "../utils/review";
import { buildFileTree } from "../utils/filetree";
import { getElectronRemote } from "../utils/electron";
import { chatLLM, type ChatLLMOptions } from "../services/llmService";
import { buildExamExtractPrompt } from "../services/questionService";
import { buildTaggingPrompt, parseTaggedResult } from "../services/knowledgeService";
import type { NoteGenSourceType } from "../services/noteService";
import { t, tf, getLanguage } from "../i18n/index";
import { ChatPanel } from "./chatPanel";
import { renderSettingsTab as renderSettingsSection } from "./sidebar/settings";
import { renderHistoryView as renderHistorySection } from "./sidebar/history";
import { renderKnowledgeManager as renderKnowledgeManagerSection } from "./sidebar/knowledge";
import { renderReviewTab as renderReviewTabSection } from "./sidebar/review";
import { startAnswer as startAnswerSection, renderAnswerView as renderAnswerViewSection } from "./sidebar/answer";
import { renderTaggerView as renderTaggerViewSection, runAITagging as runAITaggingSection } from "./sidebar/tagger";
import { renderExamBrowser as renderExamBrowserSection, extractFromExamSelected as extractFromExamSelectedSection, openCurrentFileExtract as openCurrentFileExtractSection } from "./sidebar/exam";
import { renderNoteGenView as renderNoteGenViewSection, noteGenStartDirect as noteGenStartDirectSection } from "./sidebar/noteGen";
import { renderFilePicker as renderFilePickerSection, generateFromCurrentFile as generateFromCurrentFileSection, generateFromSelected as generateFromSelectedSection, loadPickerFiles as loadPickerFilesSection, startGenerate as startGenerateSection, renderGenerateView as renderGenerateViewSection, genStartGenerate as genStartGenerateSection, genRunGenerate as genRunGenerateSection, genRenderResult as genRenderResultSection, genSaveToVault as genSaveToVaultSection, genExportMd as genExportMdSection, genExportWord as genExportWordSection, genExportPdf as genExportPdfSection, genExportNoAnswer as genExportNoAnswerSection, generateFromWeakPoints as generateFromWeakPointsSection, openGeneratePicker as openGeneratePickerSection } from "./sidebar/generate";
import { renderWrongTab as renderWrongTabSection, renderWrongList as renderWrongListSection, renderWrongNoteItem as renderWrongNoteItemSection, renderWrongDetail as renderWrongDetailSection, wrongDeleteNote as wrongDeleteNoteSection, wrongRePracticeSingle as wrongRePracticeSingleSection, wrongRePracticeDue as wrongRePracticeDueSection, wrongExportNote as wrongExportNoteSection } from "./sidebar/wrong";
import { listQuestionFiles as listQuestionFilesSection, renderQuestionsTab as renderQuestionsTabSection } from "./sidebar/questions";
import { renderNotesTab as renderNotesTabSection, renderNotePicker as renderNotePickerSection, listNoteViewFiles as listNoteViewFilesSection } from "./sidebar/notes";
import { getActivityData as getActivityDataSection, renderHeatmap as renderHeatmapSection, renderHomeDefault as renderHomeDefaultSection, getStats as getStatsSection, getDueNotes as getDueNotesSection } from "./sidebar/home";

export class MainSidebarView extends ItemView {
	plugin: QuestionGeneratorPlugin;
	activeSection: "home" | "questions" | "notes" | "wrong" | "review" | "chat" | "settings" = "home";
	private chatPanel: ChatPanel | null = null;
	innerContentEl: HTMLDivElement | null = null;
	navButtons: Map<string, HTMLDivElement> = new Map();
	navEl: HTMLElement | null = null;
	navIndicatorEl: HTMLDivElement | null = null;
	private _refreshHandler: (() => void) | null = null;

	// Home sub-views
	homeView: "default" | "filePicker" | "generate" | "answer" | "examBrowser" | "tagger" | "noteGen" | "knowledgeManager" | "history" = "default";
	heatmapYear = "";

	// File picker state
	fpSelected: Set<string> = new Set();
	fpAllFiles: TFile[] = [];
	genPickerMode: "current" | "folder" = "current";
	genPickerFolder = "";
	// Admin tab batch selection (keyed by file path)
	adminSelected: Set<string> = new Set();
	adminBatchUpdate: (() => void) | null = null;

	// Generate state
	genSourceText = "";
	genFileName = "";
	genSourcePath = "";
	genResultText = "";
	genCurrentTags: string[] = [];
	genIsGenerating = false;
	aiCancelled = false;
	private cancelWaiters: (() => void)[] = [];

	// Exam browser state
	examFiles: TFile[] = [];
	examSelected: Set<string> = new Set();
	examMode: "current" | "folder" = "current";
	examProcessing = false;
	examStatusText = "";

	// Answer state
	answerQuestions: ParsedQuestion[] = [];
	answerAnswers: Map<number, string> = new Map();
	answerResultText = "";
	answerSourceName = "";
	answerSourcePath = "";
	answerCurrentTags: string[] = [];
	answerWrongChecked: Set<number> = new Set();

	// Wrong state
	wrongView: "list" | "detail" = "list";
	wrongNotes: WrongAnswerNote[] = [];
	wrongCurrentNote: WrongAnswerNote | null = null;
	wrongSortMode: "default" | "source" | "tag" | "time" = "default";
	questionsSortMode: "default" | "source" | "tag" | "time" = "default";
	notesSortMode: "default" | "source" | "tag" | "time" = "default";
	notePickerActive = false;
	reviewSortBy: "default" | "source" | "tag" | "time" = "default";
	reviewFilterType: "all" | "wrong" | "question" | "note" = "all";

	// Tagger state
	taggerMode: "current" | "folder" = "current";
	taggerProcessing = false;
	taggerStatusText = "";

	// Note generation state
	noteGenSourceType: NoteGenSourceType = "doc";
	noteGenMode: "picker" | "preview" = "picker";
	noteGenSelected: Set<string> = new Set();
	noteGenFiles: TFile[] = [];
	noteGenWrongNotes: WrongAnswerNote[] = [];
	noteGenResultText = "";
	noteGenResultTags: string[] = [];
	noteGenTargetName = "";
	noteGenTargetPath = "";
	noteGenTargetKey = "";
	noteGenSourceText = "";
	noteGenIsGenerating = false;

	// Folder tree expansion state (persisted across rerenders so folders stay open)
	fpExpanded: Set<string> = new Set();
	examExpanded: Set<string> = new Set();
	noteGenExpanded: Set<string> = new Set();
	taggerExpanded: Set<string> = new Set();
	notePickerExpanded: Set<string> = new Set();

	getViewType() { return SIDEBAR_VIEW_TYPE; }
	getDisplayText() { return t("智学助手"); }
	getIcon() { return "pencil"; }

	constructor(leaf: WorkspaceLeaf, plugin: QuestionGeneratorPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	async onOpen() {
		this._refreshHandler = () => void this.render();
		this.plugin.onDataChanged(this._refreshHandler);
		await this.render();
	}
	async onClose() {
		if (this._refreshHandler) { this.plugin.offDataChanged(this._refreshHandler); this._refreshHandler = null; }
		this.cancelAI();
		this.chatPanel?.destroy();
		this.chatPanel = null;
		this.genIsGenerating = false;
		this.innerContentEl = null;
		this.navEl = null;
		this.navIndicatorEl = null;
	}

	async render() {
		const container = this.containerEl.children[1] as HTMLElement;
		if (!container) return;
		container.addClass("question-generator-sidebar");

		if (!this.navEl || !this.navEl.isConnected) {
			container.empty();

			const header = container.createDiv({ cls: "qg-header", attr: { style: "padding:14px 16px 10px;" } });
			header.createDiv({ text: t("智学助手"), attr: { style: "font-size:22px;font-weight:700;letter-spacing:-0.01em;" } });

			const nav = container.createDiv({ cls: "qg-nav", attr: { style: "display:flex;margin:0 14px 12px;" } });
			const navItems: { key: "home" | "questions" | "notes" | "wrong" | "review" | "chat" | "settings"; label: string; icon: string }[] = [
				{ key: "home", label: t("首页"), icon: "🏠" },
				{ key: "questions", label: t("题目"), icon: "📝" },
				{ key: "notes", label: t("笔记"), icon: "📋" },
				{ key: "wrong", label: t("错题"), icon: "❌" },
				{ key: "review", label: t("复习"), icon: "📊" },
				{ key: "chat", label: t("AI"), icon: "💬" },
				{ key: "settings", label: t("设置"), icon: "⚙️" },
			];
			this.navButtons.clear();
			for (const item of navItems) {
				const btn = nav.createDiv({ cls: "qg-nav-item", attr: { style: "flex:1;text-align:center;padding:6px 0;cursor:pointer;font-size:15px;" } });
				btn.setText(item.icon + " " + item.label);
				btn.addEventListener("click", () => {
					this.activeSection = item.key;
					if (item.key === "home") this.homeView = "default";
					if (item.key === "wrong") this.wrongView = "list";
					void this.render();
				});
				this.navButtons.set(item.key, btn);
			}
			this.navIndicatorEl = nav.createDiv({ cls: "qg-nav-indicator" });
			this.navEl = nav;
			this.innerContentEl = container.createDiv({ cls: "qg-inner" });
		} else {
			this.innerContentEl?.empty();
		}

		let activeBtn: HTMLElement | null = null;
		for (const [key, btn] of this.navButtons) {
			const active = key === this.activeSection;
			btn.toggleClass("qg-nav-item-active", active);
			if (active) activeBtn = btn;
		}
		if (activeBtn && this.navIndicatorEl) {
			this.navIndicatorEl.style.width = `${activeBtn.offsetWidth}px`;
			this.navIndicatorEl.style.transform = `translateX(${activeBtn.offsetLeft - 3}px)`;
		}

		this.innerContentEl?.toggleClass("qg-inner-chat", this.activeSection === "chat");

		switch (this.activeSection) {
			case "home": await this.renderHomeTab(); break;
			case "questions": await this.renderQuestionsTab(); break;
			case "notes": await this.renderNotesTab(); break;
			case "wrong": await this.renderWrongTab(); break;
			case "review": await this.renderReviewTab(); break;
			case "chat": this.renderChatTab(); break;
			case "settings": this.renderSettingsTab(); break;
		}

		this.animateContent();
	}

	animateContent() {
		this.innerContentEl?.animate(
			[{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "translateY(0)" }],
			{ duration: 250, easing: "cubic-bezier(0.4, 0, 0.2, 1)" }
		);
	}

	// ===================== AI CHAT TAB =====================
	renderChatTab() {
		if (!this.innerContentEl) return;
		if (!this.chatPanel) {
			this.chatPanel = new ChatPanel(this.plugin, this.innerContentEl, this);
		} else {
			this.innerContentEl.appendChild(this.chatPanel.rootEl);
			this.chatPanel.renderMessages();
		}
	}

	// ===================== HOME TAB =====================
	async renderHomeTab() {
		if (!this.innerContentEl) return;
		switch (this.homeView) {
			case "default": await this.renderHomeDefault(); break;
			case "filePicker": this.renderFilePicker(); break;
			case "generate": this.renderGenerateView(); break;
			case "answer": this.renderAnswerView(); break;
			case "examBrowser": await this.renderExamBrowser(); break;
			case "tagger": await this.renderTaggerView(); break;
			case "noteGen": await this.renderNoteGenView(); break;
			case "knowledgeManager": await this.renderKnowledgeManager(); break;
			case "history": this.renderHistoryView(); break;
		}
		this.animateContent();
	}

async getActivityData(): Promise<Record<string, number>> { return getActivityDataSection(this); }

renderHeatmap(container: HTMLElement, activity: Record<string, number>, year: string) { return renderHeatmapSection(this, container, activity, year); }

async renderHomeDefault() { return renderHomeDefaultSection(this); }

	// ===================== QUESTIONS TAB =====================
async listQuestionFiles(folder: string): Promise<TFile[]> { return listQuestionFilesSection(this, folder); }

async renderQuestionsTab() { return renderQuestionsTabSection(this); }

	// ===================== NOTES TAB =====================
async renderNotesTab() { return renderNotesTabSection(this); }

renderNotePicker(el: HTMLDivElement) { return renderNotePickerSection(this, el); }

async listNoteViewFiles(folder: string): Promise<TFile[]> { return listNoteViewFilesSection(this, folder); }

	// ===================== WRONG TAB =====================
async renderWrongTab() { return renderWrongTabSection(this); }

async renderWrongList() { return renderWrongListSection(this); }

renderWrongNoteItem(container: HTMLDivElement, note: WrongAnswerNote) { return renderWrongNoteItemSection(this, container, note); }

renderWrongDetail() { return renderWrongDetailSection(this); }

async wrongDeleteNote(note: WrongAnswerNote) { return wrongDeleteNoteSection(this, note); }

async wrongRePracticeSingle(note: WrongAnswerNote) { return wrongRePracticeSingleSection(this, note); }

async wrongRePracticeDue() { return wrongRePracticeDueSection(this); }

async wrongExportNote(note: WrongAnswerNote, format: "md" | "word" | "pdf") { return wrongExportNoteSection(this, note, format); }

	syncToKnowledgeIndex(tags: string[], label: string, filePath: string, source: IndexSource) {
		const kTags = knowledgeTags(tags);
		if (kTags.length === 0) return;
		void this.plugin.syncKnowledgeFolder(kTags, [{ label, path: filePath }], source, this.plugin.rootPath(this.plugin.settings.knowledgeFolder));
	}

	renderAdminBatchBar(container: HTMLElement, allKeys: string[], deleteCb: () => void, exportCb: () =>
		void) {
		const bar = container.createDiv({ attr: { style: "display:flex;gap:6px;margin-bottom:8px;align-items:center;" } });
		bar.createSpan({ text: t("批量"), attr: { style: "font-size:16px;color:var(--text-muted);flex-shrink:0;" } });
		const mkBtn = (label: string, cb: () => void) => {
			const b = bar.createEl("button", { text: label, attr: { style: "padding:3px 10px;border-radius:4px;cursor:pointer;font-size:16px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
			b.addEventListener("click", cb);
			return b;
		};
		const selAll = mkBtn(t("全选"), () => { allKeys.forEach(k => this.adminSelected.add(k)); update(); });
		const selNone = mkBtn(t("取消全选"), () => { this.adminSelected.clear(); update(); });
		const delBtn = mkBtn(t("删除"), deleteCb);
		const expBtn = mkBtn(t("导出"), exportCb);
		const update = () => {
			const n = allKeys.filter(k => this.adminSelected.has(k)).length;
			delBtn.setText(tf("删除 ({n})", { n }));
			expBtn.setText(tf("导出 ({n})", { n }));
			selAll.setText(allKeys.length === n ? t("已全选") : t("全选"));
			selNone.setText(n > 0 ? tf("取消 ({n})", { n }) : t("取消全选"));
		};
		update();
		return update;
	}

	async adminDeleteFiles(paths: string[], folder: string, rerender: () => void) {
		if (paths.length === 0) return;
		if (!confirm(tf("确定删除选中的 {n} 个文件？此操作不可撤销。", { n: paths.length }))) return;
		let ok = 0;
		for (const p of paths) {
			try {
				if (isAbs(folder)) { fs.unlinkSync(p); ok++; }
				else { const f = this.app.vault.getAbstractFileByPath(p); if (f instanceof TFile) { await this.app.fileManager.trashFile(f); ok++; } }
			} catch { /* skip */ }
		}
		for (const p of paths) this.adminSelected.delete(p);
		new Notice(tf("已删除 {n} 个文件", { n: ok }));
		this.plugin.emitDataChanged();
		rerender();
	}

	async adminExportFiles(paths: string[], folder: string, title: string) {
		if (paths.length === 0) return;
		const parts: string[] = [];
		for (const p of paths) {
			try {
				let content = "";
				if (isAbs(folder)) content = readFileStr(p);
				else { const f = this.app.vault.getAbstractFileByPath(p); if (!(f instanceof TFile)) continue; content = await this.app.vault.read(f); }
				parts.push(content.replace(/^---[\s\S]*?---\s*/, "").trim());
			} catch { /* skip */ }
		}
		if (parts.length === 0) { new Notice(t("所选文件均无法读取")); return; }
		const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: title + ".md", filters: [{ name: "Markdown", extensions: ["md"] }] });
		if (r.canceled || !r.filePath) return;
		fs.writeFileSync(r.filePath, parts.join("\n\n---\n\n"), "utf-8");
		new Notice(tf("已导出 {n} 个文件", { n: parts.length }));
	}

	async updateReviewSchedule(note: WrongAnswerNote, source: "wrong" | "question" | "note", wasCorrect: boolean): Promise<{ correctCount: number; interval: number; nextReview: string }> {
		const intervals = source === "wrong" ? parseReviewIntervals(this.plugin.settings.wrongReviewIntervals, DEFAULT_WRONG_INTERVALS)
			: source === "question" ? parseReviewIntervals(this.plugin.settings.questionReviewIntervals, DEFAULT_QUESTION_INTERVALS)
			: parseReviewIntervals(this.plugin.settings.noteReviewIntervals, DEFAULT_NOTE_INTERVALS);
		const result = reviewUpdate(note.correctCount || 0, wasCorrect, intervals);
		const wrongCount = note.wrongCount || 0;
		const newWrongCount = wasCorrect ? wrongCount : wrongCount + 1;
		if (isAbs(note.filePath)) {
			const content = readFileStr(note.filePath);
			const { meta, body } = parseFM(content);
			meta.interval = result.interval;
			meta.correctCount = result.correctCount;
			meta.nextReview = result.nextReview;
			if (source === "wrong") meta.wrongCount = newWrongCount;
			writeFileStr(note.filePath, buildFM(meta) + body);
		} else {
			const file = this.app.vault.getAbstractFileByPath(note.filePath);
			if (!(file instanceof TFile)) throw new Error("文件不存在");
			const content = await this.app.vault.read(file);
			const { meta, body } = parseFM(content);
			meta.interval = result.interval;
			meta.correctCount = result.correctCount;
			meta.nextReview = result.nextReview;
			if (source === "wrong") meta.wrongCount = newWrongCount;
			await this.app.vault.modify(file, buildFM(meta) + body);
		}
		this.plugin.emitDataChanged();
		return result;
	}

	async wrongUpdateScheduling(note: WrongAnswerNote, wasCorrect: boolean) {
		try {
			const result = await this.updateReviewSchedule(note, "wrong", wasCorrect);
			new Notice(wasCorrect ? tf("正确！下次复习 {d}（间隔{i}天）", { d: result.nextReview, i: result.interval }) : t("已记录错误，明天复习"));
			this.wrongView = "list";
			this.wrongCurrentNote = null;
			await this.renderWrongTab();
		} catch (err) {
			new Notice(tf("更新复习计划失败：{msg}", { msg: (err as Error).message }));
		}
	}

	// ===================== REVIEW TAB =====================
	async renderReviewTab() { return renderReviewTabSection(this); }

	// ===================== SETTINGS TAB =====================
	renderSettingsTab() { renderSettingsSection(this); }

	// ===================== FILE PICKER (unified, matches exam browser) =====================
renderFilePicker() { return renderFilePickerSection(this); }

async generateFromCurrentFile() { return generateFromCurrentFileSection(this); }

async generateFromSelected() { return generateFromSelectedSection(this); }

	selectInfoText(files: TFile[], selected: Set<string>): string {
		const sel = files.filter(f => selected.has(f.path));
		let size = 0;
		let toks = 0;
		for (const f of sel) { size += f.stat.size; toks += this.fileTokenEstimate(f); }
		const extra = sel.length > 0 ? tf("　已选≈{s}KB · ≈{t} token", { s: Math.round(size / 1024).toLocaleString(), t: toks.toLocaleString() }) : "";
		return tf("共 {a} 个文档，已选 {b} 个", { a: files.length, b: selected.size }) + extra;
	}

	fileTokenEstimate(f: TFile): number {
		const size = f.stat.size;
		const ext = f.extension.toLowerCase();
		if (ext === "md" || ext === "txt" || ext === "rtf") return Math.ceil(size / 2);
		return Math.ceil(size / 4);
	}

	fileSizeInfo(f: TFile): string {
		return tf("大小：{s}KB　预估Token：≈{t}", { s: Math.round(f.stat.size / 1024).toLocaleString(), t: this.fileTokenEstimate(f).toLocaleString() });
	}

	renderSelectTree(listEl: HTMLDivElement, searchInput: HTMLInputElement, infoEl: HTMLElement, files: TFile[], selected: Set<string>, onChanged: () => void, onSelectChange?: () => void, expandedSet?: Set<string>) {
		listEl.empty();
		const query = searchInput.value.toLowerCase();
		const filtered = query ? files.filter(f => f.path.toLowerCase().includes(query) || f.basename.toLowerCase().includes(query)) : files;
		const tree = buildFileTree(filtered);
		this.renderSelectNode(listEl, tree, 0, infoEl, files, selected, onChanged, onSelectChange, expandedSet);
	}

	renderSelectNode(container: HTMLDivElement, node: TreeNode, depth: number, infoEl: HTMLElement, files: TFile[], selected: Set<string>, onChanged: () => void, onSelectChange?: () => void, expandedSet?: Set<string>) {
		const sorted = [...node.children].sort((a, b) => {
			if (a.isFolder && !b.isFolder) return -1;
			if (!a.isFolder && b.isFolder) return 1;
			return a.name.localeCompare(b.name);
		});
		for (const child of sorted) {
			if (child.isFolder) {
				const folderEl = container.createDiv({ attr: { style: "margin-left:" + (depth * 16) + "px;" } });
				const folderRow = folderEl.createDiv({ attr: { style: "display:flex;align-items:center;gap:4px;padding:3px 4px;cursor:pointer;border-radius:4px;font-weight:bold;font-size:19px;" } });
				const arrow = folderRow.createSpan({ text: "▸", attr: { style: "font-size:17px;min-width:14px;color:var(--text-muted);" } });
				const folderFiles = this.selectFolderFiles(child);
				const folderCb = folderRow.createEl("input", { attr: { type: "checkbox" } });
				folderCb.checked = folderFiles.length > 0 && folderFiles.every(f => selected.has(f.path));
				folderCb.indeterminate = folderFiles.some(f => selected.has(f.path)) && !folderCb.checked;
				folderCb.addEventListener("change", () => {
					if (folderCb.checked) folderFiles.forEach(f => selected.add(f.path));
					else folderFiles.forEach(f => selected.delete(f.path));
					onChanged();
					if (onSelectChange) onSelectChange();
				});
				folderRow.createSpan({ text: child.name + " (" + child.children.length + ")" });
				const childContainer = folderEl.createDiv({ attr: { style: "display:none;" } });
				let expanded = expandedSet ? expandedSet.has(child.path) : false;
				childContainer.style.display = expanded ? "block" : "none";
				arrow.setText(expanded ? "▾" : "▸");
				folderRow.addEventListener("click", (e) => {
					if ((e.target as HTMLElement).tagName === "INPUT") return;
					expanded = !expanded;
					if (expandedSet) { expanded ? expandedSet.add(child.path) : expandedSet.delete(child.path); }
					childContainer.style.display = expanded ? "block" : "none";
					arrow.setText(expanded ? "▾" : "▸");
				});
				this.renderSelectNode(childContainer, child, depth + 1, infoEl, files, selected, onChanged, undefined, expandedSet);
			} else {
				const row = container.createDiv({ attr: { style: "margin-left:" + (depth * 16) + "px;padding:3px 4px;display:flex;align-items:center;gap:6px;cursor:pointer;border-radius:4px;font-size:19px;" } });
				const cb = row.createEl("input", { attr: { type: "checkbox" } });
				cb.checked = selected.has(child.path);
				const notifySelect = onSelectChange ?? onChanged;
				cb.addEventListener("change", () => {
					cb.checked ? selected.add(child.path) : selected.delete(child.path);
					infoEl.setText(this.selectInfoText(files, selected));
					notifySelect();
				});
				row.createSpan({ text: child.name, attr: { style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" } });
				if (child.file) {
					row.createSpan({ text: Math.round(child.file.stat.size / 1024) + "KB · ≈" + this.fileTokenEstimate(child.file).toLocaleString() + "tok", attr: { style: "color:var(--text-muted);font-size:16px;flex-shrink:0;" } });
					const d = new Date(child.file.stat.mtime);
					row.createSpan({ text: (d.getMonth() + 1) + "/" + d.getDate(), attr: { style: "color:var(--text-muted);font-size:17px;flex-shrink:0;" } });
				}
				row.addEventListener("click", (e) => {
					if ((e.target as HTMLElement).tagName === "INPUT") return;
					cb.checked = !cb.checked;
					cb.checked ? selected.add(child.path) : selected.delete(child.path);
					infoEl.setText(this.selectInfoText(files, selected));
					notifySelect();
				});
			}
		}
	}

	selectFolderFiles(node: TreeNode): TFile[] {
		const files: TFile[] = [];
		for (const c of node.children) {
			if (c.isFolder) files.push(...this.selectFolderFiles(c));
			else if (c.file) files.push(c.file);
		}
		return files;
	}

	// ===================== EXAM BROWSER (inline) =====================
	async renderExamBrowser() { return renderExamBrowserSection(this); }

	buildExcludeList(): string[] {
		const list = this.plugin.settings.excludeFolders.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
		const configDir = this.app.vault.configDir;
		if (configDir && !list.includes(configDir.toLowerCase())) list.push(configDir.toLowerCase());
		return list;
	}

	loadSourceFiles(): TFile[] {
		const excludeList = this.buildExcludeList();
		return this.app.vault.getFiles().filter(f => {
			const ext = f.extension.toLowerCase();
			if (ext !== "md" && !EXAM_SOURCE_EXTS.includes(ext)) return false;
			const lowerPath = f.path.toLowerCase();
			for (const ex of excludeList) {
				if (lowerPath.includes(ex + "/") || lowerPath.startsWith(ex)) return false;
			}
			return true;
		}).sort((a, b) => b.stat.mtime - a.stat.mtime);
	}


loadPickerFiles() { return loadPickerFilesSection(this); }


	async extractFromExamSelected() { return extractFromExamSelectedSection(this); }

	cancelAI() {
		this.aiCancelled = true;
		const waiters = this.cancelWaiters;
		this.cancelWaiters = [];
		for (const w of waiters) w();
	}

	resetAI() {
		this.aiCancelled = false;
		this.cancelWaiters = [];
	}

	async callAIWithPrompt(prompt: string, images?: string[], opts?: ChatLLMOptions): Promise<string> {
		const cfg = this.plugin.settings;
		const abortErr = (msg: string): Error => { const e = new Error(msg); e.name = "AbortError"; return e; };
		const chatPromise = chatLLM(cfg, prompt, {
			...(images && images.length > 0 ? { images } : {}),
			...(opts?.system ? { system: opts.system } : {}),
		});
		chatPromise.catch(() => { /* 取消/超时后丢弃迟到的错误，避免未处理 rejection */ });
		let cancelReject: (() => void) | null = null;
		const cancelPromise = new Promise<never>((_, reject) => {
			cancelReject = () => reject(abortErr("已中止"));
			this.cancelWaiters.push(cancelReject);
		});
		let timer: number | null = null;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = window.setTimeout(() => reject(abortErr("请求超时（3分钟）")), AI_REQUEST_TIMEOUT_MS);
		});
		try {
			return await Promise.race([chatPromise, cancelPromise, timeoutPromise]);
		} finally {
			if (cancelReject) { const idx = this.cancelWaiters.indexOf(cancelReject); if (idx >= 0) this.cancelWaiters.splice(idx, 1); }
			if (timer !== null) window.clearTimeout(timer);
		}
	}

	async readFileAsBase64(file: TFile): Promise<string> {
		const buf = await this.app.vault.readBinary(file);
		const bytes = new Uint8Array(buf);
		let binary = "";
		const chunkSize = 0x8000;
		for (let i = 0; i < bytes.length; i += chunkSize) {
			binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
		}
		return btoa(binary);
	}

	async examSourceToText(file: TFile): Promise<string> {
		let text = "";
		if (isImageFile(file.name)) {
			const b64 = await this.readFileAsBase64(file);
			const prompt = getLanguage() === "en"
				? buildExamExtractPrompt("(The exam image is provided with the request; identify all content in the image and extract all questions)")
				: buildExamExtractPrompt("（试卷图片已随请求提供，请识别图片中的全部内容并提取所有题目）");
			new Notice(t("图片识别：请确认当前模型支持多模态（视觉）能力"));
			text = await this.callAIWithPrompt(prompt, [b64]);
		} else if (file.extension === "md") {
			text = await this.app.vault.read(file);
		} else if (isDocumentFile(file.name)) {
			const absPath = await this.vaultFileToAbs(file);
			if (!absPath) { new Notice("无法读取文件：" + file.name); return ""; }
			text = await convertDocumentToText(absPath);
		}
		if (text) void this.saveConvertedMd(file, text);
		return text;
	}

	async saveConvertedMd(file: TFile, text: string) {
		const folderSetting = this.plugin.settings.convertedMdFolder;
		if (!folderSetting || file.extension.toLowerCase() === "md") return;
		if (!text || text.trim().length === 0) return;
		const folder = this.plugin.rootPath(folderSetting);
		await ensureFolder(this.app, folder);
		const safeBase = file.basename.replace(/[<>:"/\\|?*]/g, "_");
		if (isAbs(folder)) {
			writeFileStr(joinPath(folder, safeBase + ".md"), text);
		} else {
			const savePath = folder + "/" + safeBase + ".md";
			try { await this.app.vault.create(savePath, text); }
			catch { await this.app.vault.create(folder + "/" + safeBase + "_" + Date.now() + ".md", text); }
		}
	}

	async aiSuggestTags(text: string): Promise<string[]> {
		try {
			const existingTags = await this.plugin.loadExistingKnowledgeTags();
			const prompt = buildTaggingPrompt(text, existingTags);
			const full = await this.callAIWithPrompt(prompt);
			return parseTaggedResult(full || "");
		} catch (err) {
			console.error("[question-generator] AI知识点标签识别失败:", err);
			return [];
		}
	}

	async vaultFileToAbs(file: TFile): Promise<string | null> {
		try {
			const adapter = this.app.vault.adapter as { getFullPath?: (p: string) => string };
			if (typeof adapter.getFullPath === "function") return adapter.getFullPath(file.path);
		} catch { /* empty */ }
		return null;
	}

	// ===================== AI TAGGER (inline) =====================
	async renderTaggerView() { return renderTaggerViewSection(this); }

	async runAITagging(files: TFile[]) { return runAITaggingSection(this, files); }

	// ===================== NOTE GENERATION =====================
	async renderNoteGenView() { return renderNoteGenViewSection(this); }

	async noteGenStartDirect(name: string, content: string, sourcePath: string) { return noteGenStartDirectSection(this, name, content, sourcePath); }

	// ===================== KNOWLEDGE MANAGER =====================
	async renderKnowledgeManager() { return renderKnowledgeManagerSection(this); }

	// ===================== GENERATE (inline) =====================
startGenerate(sourceText: string, name: string, sourcePath: string = "") { return startGenerateSection(this, sourceText, name, sourcePath); }

renderGenerateView() { return renderGenerateViewSection(this); }

genStartGenerate(typeStr: string) { return genStartGenerateSection(this, typeStr); }

async genRunGenerate(onChunk: (s: string) => void, typeStr: string, spinner: HTMLElement, subText: HTMLElement) { return genRunGenerateSection(this, onChunk, typeStr, spinner, subText); }

genRenderResult() { return genRenderResultSection(this); }

async genSaveToVault() { return genSaveToVaultSection(this); }

async genExportMd() { return genExportMdSection(this); }

async genExportWord() { return genExportWordSection(this); }

async genExportPdf() { return genExportPdfSection(this); }

async genExportNoAnswer() { return genExportNoAnswerSection(this); }

async generateFromWeakPoints() { return generateFromWeakPointsSection(this); }

	// ===================== ANSWER (inline) =====================
	startAnswer(resultText: string, sourceName: string, sourcePath: string = "") { startAnswerSection(this, resultText, sourceName, sourcePath); }

	renderAnswerView() { renderAnswerViewSection(this); }

	// ===================== HELPERS =====================

	renderKnowledgeTags(container: HTMLElement, tags: string[], maxVisible = 3) {
		if (tags.length === 0) return;
		const chipWrap = container.createDiv({ attr: { style: "display:flex;flex-wrap:wrap;gap:2px;align-items:center;max-width:45%;justify-content:flex-end;flex-shrink:1;min-width:0;" } });
		const visible = tags.slice(0, maxVisible);
		for (const t of visible) {
			chipWrap.createSpan({ text: "#" + t, attr: { style: "font-size:14px;color:var(--text-faint);background:var(--background-modifier-border);border-radius:10px;padding:0 6px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px;" } });
		}
		if (tags.length > maxVisible) {
			chipWrap.createSpan({ text: "+" + (tags.length - maxVisible), attr: { style: "font-size:13px;color:var(--text-faint);flex-shrink:0;" , title: tags.slice(maxVisible).join("、") } });
		}
		chipWrap.setAttribute("title", tags.join("、"));
	}

	renderHistoryView() { renderHistorySection(this); }

openGeneratePicker(folder?: string) { return openGeneratePickerSection(this, folder); }

	async openCurrentFileExtract(file?: TFile) { return openCurrentFileExtractSection(this, file); }

async getStats() { return getStatsSection(this); }

async getDueNotes(): Promise<{ note: WrongAnswerNote; source: "wrong" | "question" | "note" }[]> { return getDueNotesSection(this); }
}

