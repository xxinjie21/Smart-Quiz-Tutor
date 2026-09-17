import { ItemView, Notice, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { Document, Packer } from "docx";
import * as fs from "fs";
import * as path from "path";

import type QuestionGeneratorPlugin from "../main";
import {
	SIDEBAR_VIEW_TYPE, MAX_UNTAGGED_DISPLAY,
	AI_REQUEST_TIMEOUT_MS,
	SEARCH_DEBOUNCE_MS, PREVIEW_ITEMS_LIMIT,
} from "../constants";
import type { WrongAnswerNote, ParsedQuestion, TreeNode } from "../types";
import type { IndexSource } from "../services/knowledgeService";
import { parseFM, buildFM, knowledgeTags } from "../utils/frontmatter";
import { isAbs, daysUntil, writeFileStr, readFileStr, deleteFileAbs, ensureFolder, listMdFilesRecursive, isImageFile, isDocumentFile, EXAM_SOURCE_EXTS, joinPath, isExcludedPath } from "../utils/fs-utils";
import { safeName } from "../utils/text";
import { convertDocumentToText } from "../services/documentService";
import { DEFAULT_WRONG_INTERVALS, DEFAULT_QUESTION_INTERVALS, DEFAULT_NOTE_INTERVALS, parseReviewIntervals, reviewUpdate, isDueForReview } from "../utils/review";
import { debounce } from "../utils/debounce";
import { buildFileTree } from "../utils/filetree";
import { stripAnswerSummarySection } from "../utils/layout";
import { buildWordParagraphs, exportPdfDirect } from "../utils/exporter";
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

	async getActivityData(): Promise<Record<string, number>> {
		const activity: Record<string, number> = {};
		const folders = [
			this.plugin.rootPath(this.plugin.settings.questionFolder),
			this.plugin.rootPath(this.plugin.settings.wrongBookFolder),
			this.plugin.rootPath(this.plugin.settings.noteViewFolder),
		];
		const excludes = [this.plugin.rootPath(this.plugin.settings.knowledgeFolder)].filter(Boolean);
		const exclPrefixes = excludes.map(p => (p.endsWith("/") ? p : p + "/"));
		const excludeCfg = this.plugin.settings.excludeFolders || "";
		for (const folder of folders) {
			if (!folder) continue;
			try {
				if (isAbs(folder)) {
					if (!fs.existsSync(folder)) continue;
					const files = listMdFilesRecursive(folder, excludes);
					for (const fp of files) {
						if (isExcludedPath(fp, excludeCfg)) continue;
						try {
							const stat = fs.statSync(fp);
							const day = new Date(stat.mtimeMs).toISOString().slice(0, 10);
							activity[day] = (activity[day] || 0) + 1;
						} catch { /* skip */ }
					}
				} else {
					const prefix = folder.endsWith("/") ? folder : folder + "/";
					const files = this.app.vault.getFiles().filter(f => f.path.startsWith(prefix) && f.extension === "md" && !exclPrefixes.some(e => f.path.startsWith(e)) && !isExcludedPath(f.path, excludeCfg));
					for (const child of files) {
						const day = new Date(child.stat.mtime).toISOString().slice(0, 10);
						activity[day] = (activity[day] || 0) + 1;
					}
				}
			} catch { /* skip */ }
		}
		return activity;
	}

	renderHeatmap(container: HTMLElement, activity: Record<string, number>, year: string) {
		container.empty();
		const today = new Date();
		const todayStr = today.toISOString().slice(0, 10);

		// GitHub contribution-graph metrics: 12px cells, 2px gaps
		const CELL = 12;
		const GAP = 2;
		const STEP = CELL + GAP;
		const DAY_LABEL_W = 26;
		const MONTH_LABEL_H = 15;

		const getLevel = (val: number): number => {
			if (val === 0) return 0;
			if (val >= 10) return 4;
			if (val >= 6) return 3;
			if (val >= 3) return 2;
			return 1;
		};
		const cellColor = (level: number): string => "var(--qg-heat-" + level + ")";

		let yearNum = 0;
		if (year) {
			yearNum = parseInt(year, 10) || 0;
			if (yearNum < 1970 || yearNum > today.getFullYear()) yearNum = 0;
		}

		const startDate = new Date();
		let endDate: Date;
		if (yearNum > 0) {
			startDate.setFullYear(yearNum, 0, 1);
			startDate.setDate(startDate.getDate() - startDate.getDay());
			endDate = new Date(yearNum, 11, 31);
		} else {
			startDate.setDate(today.getDate() - 364);
			startDate.setDate(startDate.getDate() - startDate.getDay());
			endDate = today;
		}

		const startUtc = Date.UTC(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
		const endUtc = Date.UTC(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
		const WEEKS = Math.floor((endUtc - startUtc) / 86400000 / 7) + 1;
		const GRID_W = WEEKS * STEP - GAP;
		const GRID_H = 7 * STEP - GAP;

		let totalActivities = 0;
		let activeDays = 0;
		const summaryFilter = yearNum > 0 ? (d: string) => d.startsWith(year) : () => true;
		for (const d of Object.keys(activity)) {
			if (!summaryFilter(d)) continue;
			totalActivities += activity[d]!;
			activeDays++;
		}

		// Header: title + year select + Less/More legend (GitHub layout)
		const header = container.createDiv({ attr: { style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;" } });
		header.createDiv({ text: t("学习热力图"), attr: { style: "font-size:16px;font-weight:700;color:var(--text-normal);" } });
		header.createDiv({ attr: { style: "flex:1;" } });
		const years = Array.from(new Set(Object.keys(activity).map(k => k.slice(0, 4)))).filter(y => /^\d{4}$/.test(y)).sort().reverse();
		const sel = header.createEl("select", { attr: { style: "font-size:13px;padding:2px 6px;border-radius:6px;background:transparent;color:var(--text-normal);border:1px solid var(--background-modifier-border);max-width:110px;" } });
		sel.createEl("option", { text: t("近一年"), attr: { value: "" } });
		for (const y of years) sel.createEl("option", { text: tf("{y} 年", { y }), attr: { value: y } });
		sel.value = year;
		sel.addEventListener("change", () => {
			this.heatmapYear = sel.value;
			this.renderHeatmap(container, activity, sel.value);
		});
		const legend = header.createDiv({ attr: { style: "display:flex;align-items:center;gap:3px;font-size:9px;color:var(--text-faint);" } });
		legend.createSpan({ text: "Less" });
		for (let i = 0; i <= 4; i++) {
			legend.createDiv({ attr: { style: "width:" + CELL + "px;height:" + CELL + "px;border-radius:2px;background:" + cellColor(i) + ";outline:1px solid var(--qg-heat-outline);outline-offset:-1px;" } });
		}
		legend.createSpan({ text: "More" });

		container.createDiv({ text: (yearNum > 0 ? tf("{y}年", { y: yearNum }) : t("过去一年")) + tf("共 {n} 次学习活动，{d} 天有记录", { n: totalActivities, d: activeDays }), attr: { style: "color:var(--text-muted);font-size:12px;margin-bottom:8px;" } });

		const wrap = container.createDiv({ attr: { style: "overflow-x:auto;padding-right:12px;" } });
		const outer = wrap.createDiv({ attr: { style: "display:inline-flex;gap:0;" } });

		const dayCol = outer.createDiv({ attr: { style: "width:" + DAY_LABEL_W + "px;padding-top:" + MONTH_LABEL_H + "px;" } });
		const dayLabels = ["", t("一"), "", t("三"), "", t("五"), ""];
		for (const dl of dayLabels) {
			const row = dayCol.createDiv({ attr: { style: "height:" + STEP + "px;display:flex;align-items:center;justify-content:flex-end;padding-right:3px;font-size:10px;color:var(--text-muted);" } });
			row.setText(dl);
		}

		const right = outer.createDiv({ attr: { style: "display:flex;flex-direction:column;" } });

		const monthRow = right.createDiv({ attr: { style: "height:" + MONTH_LABEL_H + "px;position:relative;width:" + GRID_W + "px;" } });
		const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
		let lastMonth = -1;
		const shownMonths = new Set<number>();
		for (let col = 0; col < WEEKS; col++) {
			const d = new Date(startDate);
			d.setDate(d.getDate() + col * 7);
			const m = d.getMonth();
			if (m !== lastMonth && !shownMonths.has(m)) {
				const lbl = monthRow.createDiv({ attr: { style: "position:absolute;left:" + (col * STEP) + "px;font-size:10px;color:var(--text-muted);white-space:nowrap;" } });
				lbl.setText(monthNames[m]!);
				shownMonths.add(m);
				lastMonth = m;
			}
		}

		const grid = right.createDiv({ attr: { style: "position:relative;width:" + GRID_W + "px;height:" + GRID_H + "px;" } });

		for (let col = 0; col < WEEKS; col++) {
			for (let row = 0; row < 7; row++) {
				const d = new Date(startDate);
				d.setDate(d.getDate() + col * 7 + row);
				if (yearNum > 0 && d.getFullYear() !== yearNum) continue;
				const ds = d.toISOString().slice(0, 10);
				if (ds > todayStr) continue;
				const val = activity[ds] || 0;
				const level = getLevel(val);

				const cell = grid.createDiv({ attr: { style: "position:absolute;width:" + CELL + "px;height:" + CELL + "px;border-radius:2px;left:" + (col * STEP) + "px;top:" + (row * STEP) + "px;background:" + cellColor(level) + ";outline:1px solid var(--qg-heat-outline);outline-offset:-1px;cursor:default;" } });

				const dateLabel = tf("{m}月{d}日", { m: d.getMonth() + 1, d: d.getDate() });
				cell.setAttribute("title", (val > 0 ? tf("{n} 次学习活动 · ", { n: val }) : t("无活动 · ")) + dateLabel);

				if (ds === todayStr) {
					cell.setAttribute("title", cell.getAttribute("title") + t(" (今天)"));
					cell.createDiv({ attr: { style: "position:absolute;inset:-1px;border-radius:2px;outline:1px solid var(--text-normal);" } });
				}
			}
		}

		const scrollToToday = () => {
			if (wrap.clientWidth === 0) return;
			wrap.scrollLeft = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
		};
		const stayOnToday = () => {
			window.requestAnimationFrame(scrollToToday);
		};
		const ro = new ResizeObserver(stayOnToday);
		ro.observe(container);
		container.addEventListener("remove", () => ro.disconnect(), { once: true });
		window.requestAnimationFrame(scrollToToday);
		window.setTimeout(scrollToToday, 200);
		window.setTimeout(scrollToToday, 600);
		window.setTimeout(scrollToToday, 1200);
	}

	async renderHomeDefault() {
		if (!this.innerContentEl) return;
		const el = this.innerContentEl;
		el.empty();

		const stats = await this.getStats();

		const statsGrid = el.createDiv({ cls: "qg-stat-grid", attr: { style: "display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;" } });
		const miniCard = (label: string, value: string, color?: string) => {
			const c = statsGrid.createDiv({ cls: "qg-stat-card", attr: { style: "text-align:center;padding:14px 6px;border-radius:12px;cursor:pointer;" } });
			c.createDiv({ text: value, attr: { style: "font-size:29px;font-weight:bold;" + (color ? "color:" + color + ";" : "") } });
			c.createDiv({ text: label, attr: { style: "color:var(--text-muted);font-size:17px;margin-top:2px;" } });
			return c;
		};
		const qCard = miniCard(t("题目"), String(stats.questionCount), stats.questionCount > 0 ? "var(--interactive-accent)" : undefined);
		qCard.addEventListener("click", () => { this.activeSection = "questions"; void this.render(); });
		const nCard = miniCard(t("笔记"), String(stats.noteCount), stats.noteCount > 0 ? "var(--color-green)" : undefined);
		nCard.addEventListener("click", () => { this.activeSection = "notes"; void this.render(); });
		const dueCard = miniCard(t("待复习"), String(stats.dueCount), stats.dueCount > 0 ? "var(--color-orange)" : undefined);
		dueCard.addEventListener("click", () => { this.activeSection = "review"; void this.render(); });
		const wCard = miniCard(t("错题"), String(stats.totalWrong), stats.totalWrong > 0 ? "var(--color-red)" : undefined);
		wCard.addEventListener("click", () => { this.activeSection = "wrong"; this.wrongView = "list"; void this.render(); });

		const heatmapSection = el.createDiv({ cls: "qg-section-card", attr: { style: "margin-bottom:16px;padding:14px;border-radius:16px;overflow:hidden;" } });
		const heatmapData = await this.getActivityData();
		this.renderHeatmap(heatmapSection, heatmapData, this.heatmapYear);

		const actSection = el.createDiv({ attr: { style: "margin-bottom:14px;" } });
		actSection.createDiv({ text: t("快捷操作"), attr: { style: "font-size:18px;font-weight:600;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;" } });

		const actions = [
			{ label: t("💬 AI 助手"), desc: t("基于你的笔记知识库进行问答"), action: () => { void this.plugin.activateChat(); } },
			{ label: t("📝 选择文件生成题目"), desc: t("让AI根据文档内容创作新题目存入题库"), action: () => this.openGeneratePicker() },
			{ label: t("🎯 薄弱点生成题目"), desc: t("针对薄弱知识点"), badge: stats.weakCount > 0 ? String(stats.weakCount) : undefined, action: async () => { await this.generateFromWeakPoints(); } },
			{ label: t("📋 AI识别试卷"), desc: t("提取文档中已有题目，保存后直接答题"), action: () => { this.homeView = "examBrowser"; void this.renderHomeTab(); } },
			{ label: t("🏷️ AI添加标签"), desc: t("AI识别知识点并写入frontmatter，用于知识图谱"), action: () => { this.taggerMode = "current"; this.fpSelected.clear(); this.fpAllFiles = []; this.homeView = "tagger"; void this.renderHomeTab(); } },
			{ label: t("🤖 AI生成笔记"), desc: t("对当前文件或从文件/题目/错题/笔记生成浓缩知识点笔记"), action: () => { this.noteGenSourceType = "doc"; this.noteGenSelected.clear(); this.noteGenResultText = ""; this.noteGenMode = "picker"; this.homeView = "noteGen"; void this.renderHomeTab(); } },
		];
		for (const act of actions) {
			const row = el.createDiv({ cls: "qg-action-row" });
			const rowInfo = row.createDiv({ cls: "qg-action-info", attr: { style: "flex:1;min-width:0;" } });
			rowInfo.createDiv({ text: act.label, cls: "qg-action-label" });
			if (act.desc) rowInfo.createDiv({ text: act.desc, cls: "qg-action-desc" });
			if (act.badge) row.createSpan({ text: act.badge, cls: "qg-badge" });
			row.addEventListener("click", () => { void act.action(); });
		}

		if (stats.dueCount > 0) {
			const reviewSection = el.createDiv({ cls: "qg-review-banner", attr: { style: "padding:14px 16px;border-radius:16px;margin-bottom:16px;" } });
			const reviewHeader = reviewSection.createDiv({ attr: { style: "display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;" } });
			reviewHeader.createDiv({ text: tf("今日待复习 {n} 题", { n: stats.dueCount }), attr: { style: "font-weight:600;font-size:18px;" } });
			const goBtn = reviewHeader.createSpan({ text: t("去复习"), attr: { style: "padding:3px 12px;border-radius:999px;background:var(--interactive-accent);color:var(--text-on-accent);cursor:pointer;font-size:14px;font-weight:600;" } });
			goBtn.addEventListener("click", () => { this.activeSection = "review"; void this.render(); });
			const dueNotes = await this.getDueNotes();
			const shown = dueNotes.slice(0, PREVIEW_ITEMS_LIMIT);
			shown.forEach((item, i) => {
				const note = item.note;
				const isLast = i === shown.length - 1;
				const row = reviewSection.createDiv({ attr: { style: "display:flex;align-items:center;gap:8px;padding:8px 0;" + (isLast ? "" : "border-bottom:1px solid color-mix(in srgb, var(--qg-border) 60%, transparent);") } });
				row.createSpan({ text: (note.sourceFile || note.baseName).replace(/\[\[|\]\]/g, ""), attr: { style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:16px;" } });
				const btn = row.createSpan({ text: t("复习"), attr: { style: "padding:3px 10px;border-radius:999px;background:var(--interactive-accent);color:var(--text-on-accent);cursor:pointer;font-size:14px;font-weight:600;flex-shrink:0;" } });
				btn.addEventListener("click", () => {
					if (item.source === "wrong") { this.activeSection = "wrong"; this.wrongView = "detail"; this.wrongCurrentNote = note; void this.render(); }
					else { void this.app.workspace.openLinkText(note.baseName, "", false); }
				});
			});
			if (stats.dueCount > shown.length) reviewSection.createDiv({ text: tf("还有 {n} 题...", { n: stats.dueCount - shown.length }), attr: { style: "font-size:14px;color:var(--text-muted);padding-top:8px;" } });
		}

		const toolsSection = el.createDiv({ attr: { style: "margin-top:10px;" } });
		toolsSection.createDiv({ text: t("数据维护"), attr: { style: "font-size:18px;font-weight:600;color:var(--text-muted);margin:12px 0 8px;text-transform:uppercase;letter-spacing:0.5px;" } });
		const kmRow = toolsSection.createDiv({ cls: "qg-action-row" });
		const kmInfo = kmRow.createDiv({ cls: "qg-action-info", attr: { style: "flex:1;min-width:0;" } });
		kmInfo.createDiv({ text: t("🧠 知识点管理"), cls: "qg-action-label" });
		kmInfo.createDiv({ text: t("查看并删除知识点及其对应的索引文件"), cls: "qg-action-desc" });
		kmRow.addEventListener("click", () => { this.homeView = "knowledgeManager"; void this.renderHomeTab(); });
		const rebuildRow = toolsSection.createDiv({ cls: "qg-action-row" });
		const rebuildInfo = rebuildRow.createDiv({ cls: "qg-action-info", attr: { style: "flex:1;min-width:0;" } });
		rebuildInfo.createDiv({ text: t("🔄 重建知识点索引"), cls: "qg-action-label" });
		rebuildInfo.createDiv({ text: t("扫描各文件夹的标签，重新生成关联的知识点索引文件"), cls: "qg-action-desc" });
		rebuildRow.addEventListener("click", () => { void (async () => {
			const report = await this.plugin.rebuildKnowledgeIndex();
			const extra: string[] = [];
			if (report.brokenLinks > 0) extra.push(tf("失效链接 {n} 处", { n: report.brokenLinks }));
			if (report.duplicates > 0) extra.push(tf("疑似重复文件 {n} 组", { n: report.duplicates }));
			new Notice(extra.length > 0 ? t("知识点索引已重建") + "：" + extra.join("，") : t("知识点索引已重建"));
		})(); });
		const cacheRow = toolsSection.createDiv({ cls: "qg-action-row" });
		const cacheInfo = cacheRow.createDiv({ cls: "qg-action-info", attr: { style: "flex:1;min-width:0;" } });
		cacheInfo.createDiv({ text: t("🧹 清除缓存"), cls: "qg-action-label" });
		cacheInfo.createDiv({ text: t("清空内存中的错题缓存，下次访问自动重新读取"), cls: "qg-action-desc" });
		cacheRow.addEventListener("click", () => { this.plugin.invalidateCache(); new Notice(t("缓存已清除")); });
	}

	// ===================== QUESTIONS TAB =====================
	async listQuestionFiles(folder: string): Promise<TFile[]> {
		const excludes = [this.plugin.rootPath(this.plugin.settings.knowledgeFolder)].filter(Boolean);
		const excludeCfg = this.plugin.settings.excludeFolders || "";
		if (isAbs(folder)) {
			try {
				if (!fs.existsSync(folder)) return [];
				const files = listMdFilesRecursive(folder, excludes);
				return files.map((fp: string) => {
					const stat = fs.statSync(fp);
					return { name: path.basename(fp), path: fp, basename: path.basename(fp).replace(/\.md$/, ""), stat: { mtime: stat.mtimeMs, size: stat.size } } as unknown as TFile;
				}).filter(f => !isExcludedPath(f.path, excludeCfg)).sort((a: TFile, b: TFile) => (b.stat.mtime || 0) - (a.stat.mtime || 0));
			} catch { return []; }
		}
		try {
			const prefix = folder.endsWith("/") ? folder : folder + "/";
			const exclPrefixes = excludes.map(p => (p.endsWith("/") ? p : p + "/"));
			return this.app.vault.getFiles().filter(f => f.path.startsWith(prefix) && f.extension === "md" && !exclPrefixes.some(e => f.path.startsWith(e)) && !isExcludedPath(f.path, excludeCfg)).sort((a, b) => (b.stat.mtime || 0) - (a.stat.mtime || 0));
		} catch { return []; }
	}

	async renderQuestionsTab() {
		if (!this.innerContentEl) return;
		const el = this.innerContentEl;
		el.empty();

		const folder = this.plugin.rootPath(this.plugin.settings.questionFolder);
		if (!folder) { el.createDiv({ text: t("请在设置中配置题目文件夹"), attr: { style: "color:var(--text-muted);text-align:center;padding:30px 0;font-size:20px;" } }); return; }

		const files = await this.listQuestionFiles(folder);

		const allTags = new Set<string>();
		const fileData: { file: TFile; tags: string[] }[] = [];
		for (const file of files) {
			try {
				let content = "";
				if (isAbs(folder)) { content = readFileStr(file.path); } else { content = await this.app.vault.read(file); }
				const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
				let tags: string[] = [];
				if (fmMatch) {
					const tagMatch = fmMatch[1]!.match(/tags:\s*\[([^\]]*)\]/);
					if (tagMatch) tags = tagMatch[1]!.split(",").map(s => s.trim()).filter(Boolean);
				}
				const kp = knowledgeTags(tags);
				kp.forEach(t => allTags.add(t));
				fileData.push({ file, tags });
			} catch { fileData.push({ file, tags: [] }); }
		}

		const statsRow = el.createDiv({ attr: { style: "display:flex;gap:6px;margin-bottom:10px;font-size:18px;" } });
		statsRow.createSpan({ text: tf("{label} {n}", { label: t("题目"), n: files.length }), attr: { style: "padding:3px 8px;border-radius:4px;background:color-mix(in srgb, var(--interactive-accent) 15%, transparent);color:var(--interactive-accent);font-weight:600;" } });
		statsRow.createSpan({ text: tf("{label} {n}", { label: t("知识点"), n: allTags.size }), attr: { style: "padding:3px 8px;border-radius:4px;background:color-mix(in srgb, var(--color-green) 15%, transparent);color:var(--color-green);font-weight:600;" } });

		const sortBar = el.createDiv({ attr: { style: "display:flex;gap:2px;margin-bottom:10px;" } });
		const sortModes: { key: "default" | "source" | "tag" | "time"; label: string }[] = [
			{ key: "default", label: t("默认") },
			{ key: "source", label: t("按源文件") },
			{ key: "tag", label: t("按知识点") },
			{ key: "time", label: t("按时间") },
		];
		for (const m of sortModes) {
			const mb = sortBar.createEl("button", { text: m.label, attr: { style: "padding:3px 8px;border-radius:3px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:" + (this.questionsSortMode === m.key ? "var(--interactive-accent);color:var(--text-on-accent);" : "var(--background-secondary);color:var(--text-muted);") } });
			mb.addEventListener("click", () => { this.questionsSortMode = m.key; void this.renderQuestionsTab(); });
		}

		if (files.length === 0) {
			el.createDiv({ text: t("暂无题目文件"), attr: { style: "color:var(--text-faint);text-align:center;padding:20px 0;font-size:19px;" } });
			return;
		}

		const searchEl = el.createEl("input", { attr: { type: "text", placeholder: t("搜索文件名..."), style: "width:100%;padding:5px 8px;border-radius:4px;border:1px solid var(--background-modifier-border);font-size:18px;margin-bottom:8px;" } });
		this.adminBatchUpdate = this.renderAdminBatchBar(el, fileData.map(fd => fd.file.path), () => {
			const selected = fileData.filter(fd => this.adminSelected.has(fd.file.path)).map(fd => fd.file.path);
			void this.adminDeleteFiles(selected, folder, () => void this.renderQuestionsTab());
		}, () => {
			const selected = fileData.filter(fd => this.adminSelected.has(fd.file.path)).map(fd => fd.file.path);
			void this.adminExportFiles(selected, folder, t("题目批量导出"));
		});
		const listEl = el.createDiv({});

		const renderList = (query: string) => {
			listEl.empty();
			const q = query.toLowerCase();
			const filtered = q ? fileData.filter(fd => fd.file.name.toLowerCase().includes(q) || fd.file.basename.toLowerCase().includes(q)) : fileData;

			const renderFileItem = (container: HTMLElement, fd: { file: TFile; tags: string[] }) => {
				const file = fd.file;
				const item = container.createDiv({ attr: { style: "display:flex;align-items:center;gap:4px;padding:6px 4px;border-bottom:1px solid var(--background-modifier-border);font-size:18px;cursor:pointer;transition:background 0.15s;" } });
				item.classList.add("qg-hover-bg");
				const cb = item.createEl("input", { attr: { type: "checkbox", style: "flex-shrink:0;width:14px;height:14px;cursor:pointer;" } });
				cb.checked = this.adminSelected.has(file.path);
				cb.addEventListener("change", () => { if (cb.checked) this.adminSelected.add(file.path); else this.adminSelected.delete(file.path); this.adminBatchUpdate?.(); });
				const nameEl = item.createSpan({ text: file.name, attr: { style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--interactive-accent);" } });
				nameEl.addEventListener("click", () => { void this.app.workspace.openLinkText(file.path, "", false); });
				const kp = knowledgeTags(fd.tags);
				this.renderKnowledgeTags(item, kp);
				item.createSpan({ text: Math.round(file.stat.size / 1024) + "KB", attr: { style: "font-size:16px;color:var(--text-muted);flex-shrink:0;" } });
				const d = new Date(file.stat.mtime);
				item.createSpan({ text: (d.getMonth() + 1) + "/" + d.getDate(), attr: { style: "font-size:16px;color:var(--text-muted);flex-shrink:0;" } });
				const actRow = item.createDiv({ attr: { style: "display:flex;gap:2px;flex-shrink:0;" } });
				const actBtn = (label: string, tip: string, cb: () => void) => {
					const b = actRow.createSpan({ text: label, attr: { title: tip, style: "padding:1px 4px;border-radius:3px;cursor:pointer;font-size:16px;" } });
					b.addEventListener("click", (e) => { e.stopPropagation(); cb(); });
				};
				actBtn("📖", t("打开"), () => { void this.app.workspace.openLinkText(file.path, "", false).catch(() => {}); });
				actBtn("✏️", t("答题"), () => {
					void (async () => {
						const content = isAbs(folder) ? readFileStr(file.path) : await this.app.vault.read(file);
						const clean = content.replace(/^---[\s\S]*?---\s*/, "");
						this.startAnswer(clean, file.basename, file.path);
					})();
				});
				actBtn("📒", t("生成笔记"), () => {
					void (async () => {
						const content = isAbs(folder) ? readFileStr(file.path) : await this.app.vault.read(file);
						await this.noteGenStartDirect(file.basename, content.replace(/^---[\s\S]*?---\s*/, ""), file.path);
					})();
				});
				actBtn("📤", t("导出"), () => {
					void (async () => {
						const content = isAbs(folder) ? readFileStr(file.path) : await this.app.vault.read(file);
						const clean = content.replace(/^---[\s\S]*?---\s*/, "");
						const baseName = file.basename.replace(/_试题.*$/, "");
						const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: file.basename + ".docx", filters: [{ name: "Word", extensions: ["docx"] }, { name: "PDF", extensions: ["pdf"] }, { name: "Markdown", extensions: ["md"] }] });
						if (r.canceled || !r.filePath) return;
						const fp = r.filePath;
						if (fp.endsWith(".docx")) {
							const children = buildWordParagraphs(clean, baseName + t(" 配套试题"), baseName);
							const doc = new Document({ sections: [{ properties: {}, children }] });
							const buffer = await Packer.toBuffer(doc);
							fs.writeFileSync(fp, Buffer.from(buffer));
							new Notice(t("Word已保存"));
						} else if (fp.endsWith(".pdf")) {
							await exportPdfDirect(fp, clean, baseName + t(" 配套试题"), baseName);
							new Notice(t("PDF已保存"));
						} else {
							fs.writeFileSync(fp, clean, "utf-8");
							new Notice(t("Md已保存"));
						}
					})();
				});
				actBtn("✏", t("重命名"), () => {
					void (async () => {
						const newName = prompt(t("输入新文件名（不含扩展号）："), file.basename);
						if (!newName || newName === file.basename) return;
						try {
							if (isAbs(folder)) {
								const ext = file.name.endsWith(".md") ? ".md" : "";
								fs.renameSync(file.path, joinPath(folder, newName + ext));
							} else {
								const newPath = file.path.replace(/[^/]+$/, newName + ".md");
								await this.app.vault.rename(file, newPath);
							}
							new Notice(t("已重命名"));
							void this.renderQuestionsTab();
						} catch (err) { new Notice(tf("重命名失败：{msg}", { msg: (err as Error).message })); }
					})();
				});
				actBtn("🗑", t("删除"), () => {
					void (async () => {
						if (!confirm(tf("确定删除题目文件「{name}」？", { name: file.basename }))) return;
						try {
							if (isAbs(folder)) { fs.unlinkSync(file.path); } else { await this.app.fileManager.trashFile(file); }
							new Notice(t("已删除"));
							void this.renderQuestionsTab();
						} catch (err) { new Notice(tf("删除失败：{msg}", { msg: (err as Error).message })); }
					})();
				});
			};

			if (this.questionsSortMode === "default") {
				for (const fd of filtered) renderFileItem(listEl, fd);
			} else if (this.questionsSortMode === "source") {
				const groups: Record<string, { file: TFile; tags: string[] }[]> = {};
				const noSource: { file: TFile; tags: string[] }[] = [];
				for (const fd of filtered) {
					const src = fd.file.basename.replace(/_试题.*$/, "");
					if (!src) { noSource.push(fd); continue; }
					const arr = groups[src] || (groups[src] = []);
					arr.push(fd);
				}
				const sorted = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
				for (const [src, srcFiles] of sorted) {
					const group = listEl.createDiv({ attr: { style: "margin-bottom:8px;border:1px solid var(--background-modifier-border);border-radius:6px;overflow:hidden;" } });
					const header = group.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:pointer;background:var(--background-secondary);" } });
					const arrow = header.createSpan({ text: "▸", attr: { style: "font-size:17px;color:var(--text-muted);min-width:14px;" } });
					header.createSpan({ text: src, attr: { style: "font-weight:600;font-size:18px;color:var(--interactive-accent);flex:1;" } });
					header.createSpan({ text: tf("{n}题", { n: srcFiles.length }), attr: { style: "font-size:17px;color:var(--text-muted);" } });
					const list = group.createDiv({ attr: { style: "display:none;padding:4px 8px;" } });
					for (const fd of srcFiles) renderFileItem(list, fd);
					let expanded = false;
					header.addEventListener("click", () => { expanded = !expanded; list.style.display = expanded ? "block" : "none"; arrow.setText(expanded ? "▾" : "▸"); });
				}
				if (noSource.length > 0) {
					listEl.createDiv({ text: t("未分类"), attr: { style: "font-size:18px;font-weight:600;color:var(--text-muted);margin:10px 0 6px;" } });
					for (const fd of noSource) renderFileItem(listEl, fd);
				}
			} else if (this.questionsSortMode === "tag") {
				const tagGroups: Record<string, { file: TFile; tags: string[] }[]> = {};
				const untagged: { file: TFile; tags: string[] }[] = [];
				for (const fd of filtered) {
					const kp = knowledgeTags(fd.tags);
					if (kp.length === 0) { untagged.push(fd); continue; }
					for (const t of kp) {
						const arr = tagGroups[t] || (tagGroups[t] = []);
						arr.push(fd);
					}
				}
				const sortedTags = Object.entries(tagGroups).sort((a, b) => b[1].length - a[1].length);
				for (const [tag, tagFiles] of sortedTags) {
					const group = listEl.createDiv({ attr: { style: "margin-bottom:8px;border:1px solid var(--background-modifier-border);border-radius:6px;overflow:hidden;" } });
					const header = group.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:pointer;background:var(--background-secondary);" } });
					const arrow = header.createSpan({ text: "▸", attr: { style: "font-size:17px;color:var(--text-muted);min-width:14px;" } });
					header.createSpan({ text: "#" + tag, attr: { style: "font-weight:600;font-size:18px;color:var(--interactive-accent);flex:1;" } });
					header.createSpan({ text: tf("{n}题", { n: tagFiles.length }), attr: { style: "font-size:17px;color:var(--text-muted);" } });
					const list = group.createDiv({ attr: { style: "display:none;padding:4px 8px;" } });
					for (const fd of tagFiles) renderFileItem(list, fd);
					let expanded = false;
					header.addEventListener("click", () => { expanded = !expanded; list.style.display = expanded ? "block" : "none"; arrow.setText(expanded ? "▾" : "▸"); });
				}
				if (untagged.length > 0) {
					listEl.createDiv({ text: t("未分类"), attr: { style: "font-size:18px;font-weight:600;color:var(--text-muted);margin:10px 0 6px;" } });
					for (const fd of untagged) renderFileItem(listEl, fd);
				}
			} else if (this.questionsSortMode === "time") {
				const sorted = [...filtered].sort((a, b) => (b.file.stat.mtime || 0) - (a.file.stat.mtime || 0));
				for (const fd of sorted) renderFileItem(listEl, fd);
			}
		};
		searchEl.addEventListener("input", debounce(() => renderList(searchEl.value), SEARCH_DEBOUNCE_MS));
		renderList("");
	}

	// ===================== NOTES TAB =====================
	async renderNotesTab() {
		if (!this.innerContentEl) return;
		const el = this.innerContentEl;
		el.empty();

		if (this.notePickerActive) {
			this.renderNotePicker(el);
			return;
		}

		const folder = this.plugin.rootPath(this.plugin.settings.noteViewFolder);
		if (!folder) { el.createDiv({ text: t("请在设置中配置笔记文件夹"), attr: { style: "color:var(--text-muted);text-align:center;padding:30px 0;font-size:20px;" } }); return; }

		const files = await this.listNoteViewFiles(folder);

		const allTags = new Set<string>();
		const fileData: { file: TFile; tags: string[]; source: string }[] = [];
		for (const file of files) {
			try {
				let content = "";
				if (isAbs(folder)) { content = readFileStr(file.path); } else { content = await this.app.vault.read(file); }
				const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
				let tags: string[] = [];
				let source = "";
				if (fmMatch) {
					const tagMatch = fmMatch[1]!.match(/tags:\s*\[([^\]]*)\]/);
					if (tagMatch) tags = tagMatch[1]!.split(",").map(s => s.trim()).filter(Boolean);
				const srcMatch = fmMatch[1]!.match(/source:\s*(.+)/);
				if (srcMatch) source = srcMatch[1]!.trim().replace(/^"|"$/g, "").replace(/^\[\[|\]\]$/g, "");
				}
				const kp = knowledgeTags(tags);
				kp.forEach(t => allTags.add(t));
				fileData.push({ file, tags, source });
			} catch { fileData.push({ file, tags: [], source: "" }); }
		}

		const statsRow = el.createDiv({ attr: { style: "display:flex;gap:6px;margin-bottom:10px;font-size:18px;" } });
		statsRow.createSpan({ text: tf("{label} {n}", { label: t("笔记"), n: files.length }), attr: { style: "padding:3px 8px;border-radius:4px;background:color-mix(in srgb, var(--color-green) 15%, transparent);color:var(--color-green);font-weight:600;" } });
		statsRow.createSpan({ text: tf("{label} {n}", { label: t("知识点"), n: allTags.size }), attr: { style: "padding:3px 8px;border-radius:4px;background:color-mix(in srgb, var(--interactive-accent) 15%, transparent);color:var(--interactive-accent);font-weight:600;" } });

		const actionRow = el.createDiv({ attr: { style: "display:flex;gap:6px;margin-bottom:10px;" } });
		const createBtn = actionRow.createEl("button", { text: t("从文件创建笔记"), attr: { style: "padding:5px 12px;border-radius:4px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
		createBtn.addEventListener("click", () => { this.notePickerActive = true; void this.renderNotesTab(); });

		const sortBar = el.createDiv({ attr: { style: "display:flex;gap:2px;margin-bottom:10px;" } });
		const sortModes: { key: "default" | "source" | "tag" | "time"; label: string }[] = [
			{ key: "default", label: t("默认") },
			{ key: "source", label: t("按源文件") },
			{ key: "tag", label: t("按知识点") },
			{ key: "time", label: t("按时间") },
		];
		for (const m of sortModes) {
			const mb = sortBar.createEl("button", { text: m.label, attr: { style: "padding:3px 8px;border-radius:3px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:" + (this.notesSortMode === m.key ? "var(--interactive-accent);color:var(--text-on-accent);" : "var(--background-secondary);color:var(--text-muted);") } });
			mb.addEventListener("click", () => { this.notesSortMode = m.key; void this.renderNotesTab(); });
		}

		if (files.length === 0) {
			el.createDiv({ text: t("暂无笔记文件"), attr: { style: "color:var(--text-faint);text-align:center;padding:20px 0;font-size:19px;" } });
			return;
		}

		const searchEl = el.createEl("input", { attr: { type: "text", placeholder: t("搜索文件名..."), style: "width:100%;padding:5px 8px;border-radius:4px;border:1px solid var(--background-modifier-border);font-size:18px;margin-bottom:8px;" } });
		this.adminBatchUpdate = this.renderAdminBatchBar(el, fileData.map(fd => fd.file.path), () => {
			const selected = fileData.filter(fd => this.adminSelected.has(fd.file.path)).map(fd => fd.file.path);
			void this.adminDeleteFiles(selected, folder, () => void this.renderNotesTab());
		}, () => {
			const selected = fileData.filter(fd => this.adminSelected.has(fd.file.path)).map(fd => fd.file.path);
			void this.adminExportFiles(selected, folder, t("笔记批量导出"));
		});
		const listEl = el.createDiv({});

		const renderList = (query: string) => {
			listEl.empty();
			const q = query.toLowerCase();
			const filtered = q ? fileData.filter(fd => fd.file.name.toLowerCase().includes(q) || fd.file.basename.toLowerCase().includes(q) || fd.source.toLowerCase().includes(q)) : fileData;

			const renderFileItem = (container: HTMLElement, fd: { file: TFile; tags: string[]; source: string }) => {
				const file = fd.file;
				const item = container.createDiv({ attr: { style: "display:flex;align-items:center;gap:4px;padding:6px 4px;border-bottom:1px solid var(--background-modifier-border);font-size:18px;cursor:pointer;transition:background 0.15s;" } });
				item.classList.add("qg-hover-bg");
				const cb = item.createEl("input", { attr: { type: "checkbox", style: "flex-shrink:0;width:14px;height:14px;cursor:pointer;" } });
				cb.checked = this.adminSelected.has(file.path);
				cb.addEventListener("change", () => { if (cb.checked) this.adminSelected.add(file.path); else this.adminSelected.delete(file.path); this.adminBatchUpdate?.(); });
				const nameEl = item.createSpan({ text: file.name, attr: { style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--interactive-accent);" } });
				nameEl.addEventListener("click", () => { void this.app.workspace.openLinkText(file.path, "", false); });
				const kp = knowledgeTags(fd.tags);
				this.renderKnowledgeTags(item, kp);
				const d = new Date(file.stat.mtime);
				item.createSpan({ text: (d.getMonth() + 1) + "/" + d.getDate(), attr: { style: "font-size:16px;color:var(--text-muted);flex-shrink:0;" } });
				const actRow = item.createDiv({ attr: { style: "display:flex;gap:2px;flex-shrink:0;" } });
				const actBtn = (label: string, tip: string, cb: () => void) => {
					const b = actRow.createSpan({ text: label, attr: { title: tip, style: "padding:1px 4px;border-radius:3px;cursor:pointer;font-size:16px;" } });
					b.addEventListener("click", (e) => { e.stopPropagation(); cb(); });
				};
				actBtn("📖", t("打开"), () => { void this.app.workspace.openLinkText(file.path, "", false).catch(() => {}); });
				actBtn("📒", t("生成笔记"), () => {
					void (async () => {
						const content = isAbs(folder) ? readFileStr(file.path) : await this.app.vault.read(file);
						await this.noteGenStartDirect(file.basename, content.replace(/^---[\s\S]*?---\s*/, ""), file.path);
					})();
				});
				actBtn("🗑", t("删除"), () => {
					void (async () => {
						if (!confirm(tf("确定删除笔记「{name}」？", { name: file.basename }))) return;
						try {
							if (isAbs(folder)) { fs.unlinkSync(file.path); } else { await this.app.fileManager.trashFile(file); }
							new Notice(t("已删除"));
							void this.renderNotesTab();
						} catch (err) { new Notice(tf("删除失败：{msg}", { msg: (err as Error).message })); }
					})();
				});
			};

			if (this.notesSortMode === "default") {
				for (const fd of filtered) renderFileItem(listEl, fd);
			} else if (this.notesSortMode === "source") {
				const groups: Record<string, { file: TFile; tags: string[]; source: string }[]> = {};
				const noSource: { file: TFile; tags: string[]; source: string }[] = [];
				for (const fd of filtered) {
					const src = fd.source || fd.file.basename;
					if (!src) { noSource.push(fd); continue; }
					const arr = groups[src] || (groups[src] = []);
					arr.push(fd);
				}
				const sorted = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
				for (const [src, srcFiles] of sorted) {
					const group = listEl.createDiv({ attr: { style: "margin-bottom:8px;border:1px solid var(--background-modifier-border);border-radius:6px;overflow:hidden;" } });
					const header = group.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:pointer;background:var(--background-secondary);" } });
					const arrow = header.createSpan({ text: "▸", attr: { style: "font-size:17px;color:var(--text-muted);min-width:14px;" } });
					header.createSpan({ text: src, attr: { style: "font-weight:600;font-size:18px;color:var(--color-green);flex:1;" } });
					header.createSpan({ text: tf("{n}篇", { n: srcFiles.length }), attr: { style: "font-size:17px;color:var(--text-muted);" } });
					const list = group.createDiv({ attr: { style: "display:none;padding:4px 8px;" } });
					for (const fd of srcFiles) renderFileItem(list, fd);
					let expanded = false;
					header.addEventListener("click", () => { expanded = !expanded; list.style.display = expanded ? "block" : "none"; arrow.setText(expanded ? "▾" : "▸"); });
				}
				if (noSource.length > 0) {
					listEl.createDiv({ text: t("未分类"), attr: { style: "font-size:18px;font-weight:600;color:var(--text-muted);margin:10px 0 6px;" } });
					for (const fd of noSource) renderFileItem(listEl, fd);
				}
			} else if (this.notesSortMode === "tag") {
				const tagGroups: Record<string, { file: TFile; tags: string[]; source: string }[]> = {};
				const untagged: { file: TFile; tags: string[]; source: string }[] = [];
				for (const fd of filtered) {
					const kp = knowledgeTags(fd.tags);
					if (kp.length === 0) { untagged.push(fd); continue; }
					for (const t of kp) {
						const arr = tagGroups[t] || (tagGroups[t] = []);
						arr.push(fd);
					}
				}
				const sortedTags = Object.entries(tagGroups).sort((a, b) => b[1].length - a[1].length);
				for (const [tag, tagFiles] of sortedTags) {
					const group = listEl.createDiv({ attr: { style: "margin-bottom:8px;border:1px solid var(--background-modifier-border);border-radius:6px;overflow:hidden;" } });
					const header = group.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:pointer;background:var(--background-secondary);" } });
					const arrow = header.createSpan({ text: "▸", attr: { style: "font-size:17px;color:var(--text-muted);min-width:14px;" } });
					header.createSpan({ text: "#" + tag, attr: { style: "font-weight:600;font-size:18px;color:var(--color-green);flex:1;" } });
					header.createSpan({ text: tf("{n}篇", { n: tagFiles.length }), attr: { style: "font-size:17px;color:var(--text-muted);" } });
					const list = group.createDiv({ attr: { style: "display:none;padding:4px 8px;" } });
					for (const fd of tagFiles) renderFileItem(list, fd);
					let expanded = false;
					header.addEventListener("click", () => { expanded = !expanded; list.style.display = expanded ? "block" : "none"; arrow.setText(expanded ? "▾" : "▸"); });
				}
				if (untagged.length > 0) {
					listEl.createDiv({ text: t("未分类"), attr: { style: "font-size:18px;font-weight:600;color:var(--text-muted);margin:10px 0 6px;" } });
					for (const fd of untagged) renderFileItem(listEl, fd);
				}
			} else if (this.notesSortMode === "time") {
				const sorted = [...filtered].sort((a, b) => (b.file.stat.mtime || 0) - (a.file.stat.mtime || 0));
				for (const fd of sorted) renderFileItem(listEl, fd);
			}
		};
		searchEl.addEventListener("input", debounce(() => renderList(searchEl.value), SEARCH_DEBOUNCE_MS));
		renderList("");
	}

	renderNotePicker(el: HTMLDivElement) {
		const backBtn = el.createEl("button", { text: t("← 返回笔记列表"), attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:19px;margin-bottom:12px;" } });
		backBtn.addEventListener("click", () => { this.notePickerActive = false; void this.renderNotesTab(); });
		el.createDiv({ text: t("选择要加入笔记库的文件"), attr: { style: "font-size:21px;font-weight:bold;margin-bottom:8px;" } });

		const excludeList = this.buildExcludeList();
		this.fpAllFiles = this.app.vault.getFiles().filter(f => {
			if (f.extension !== "md") return false;
			const lowerPath = f.path.toLowerCase();
			for (const ex of excludeList) {
				if (lowerPath.includes(ex.toLowerCase() + "/") || lowerPath.startsWith(ex.toLowerCase())) return false;
			}
			return true;
		});

		const infoEl = el.createDiv({ attr: { style: "color:var(--text-muted);font-size:18px;margin-bottom:8px;" } });
		infoEl.setText(tf("共 {a} 个文档，已选 {b} 个", { a: this.fpAllFiles.length, b: this.fpSelected.size }));

		const searchDiv = el.createDiv({ attr: { style: "margin-bottom:8px;" } });
		const searchInput = searchDiv.createEl("input", { attr: { type: "text", placeholder: t("搜索文件名..."), style: "width:100%;padding:6px 8px;border-radius:4px;border:1px solid var(--background-modifier-border);" } });

		const toolBar = el.createDiv({ attr: { style: "margin-bottom:8px;display:flex;gap:6px;" } });
		const toolBtn = (label: string, cb: () => void) => {
			const b = toolBar.createEl("button", { text: label, attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
			b.addEventListener("click", cb);
		};
		toolBtn(t("全选"), () => { this.fpAllFiles.forEach(f => this.fpSelected.add(f.path)); rerender(); });
		toolBtn(t("取消全选"), () => { this.fpSelected.clear(); rerender(); });

		const listEl = el.createDiv({ attr: { style: "max-height:450px;overflow-y:auto;" } });
		const btnRow = el.createDiv({ attr: { style: "margin-top:12px;display:flex;gap:8px;" } });
		const confirmBtn = btnRow.createEl("button", { text: tf("创建笔记 ({n}个)", { n: 0 }), attr: { class: "mod-cta", style: "padding:6px 16px;border-radius:4px;cursor:pointer;font-size:19px;" } });
		const updateConfirm = () => { confirmBtn.setText(tf("创建笔记 ({n}个)", { n: this.fpSelected.size })); };
		const rerender = () => { this.renderSelectTree(listEl, searchInput, infoEl, this.fpAllFiles, this.fpSelected, rerender, updateConfirm, this.notePickerExpanded); updateConfirm(); };
		searchInput.addEventListener("input", debounce(() => rerender(), SEARCH_DEBOUNCE_MS));
		rerender();
		confirmBtn.addEventListener("click", () => {
			void (async () => {
				const chosen = this.fpAllFiles.filter(f => this.fpSelected.has(f.path));
				if (chosen.length === 0) { new Notice(t("请至少选择一个文件")); return; }
				const noteFolder = this.plugin.rootPath(this.plugin.settings.noteViewFolder);
				await ensureFolder(this.app, noteFolder);
				const useFs = isAbs(noteFolder);
				let count = 0;
				for (const f of chosen) {
					const content = useFs ? readFileStr(f.path) : await this.app.vault.read(f);
					const dateStr = new Date().toISOString().slice(0, 10);
					const fm = buildFM({ source: "[[" + f.basename + "]]", sourcePath: f.path, date: dateStr, tags: [] });
					const noteFileName = safeName(f.basename) + "_笔记_" + dateStr + ".md";
					if (useFs) {
						const fp = joinPath(noteFolder, noteFileName);
						try { writeFileStr(fp, fm + content); count++; }
						catch { try { writeFileStr(joinPath(noteFolder, safeName(f.basename) + "_笔记_" + Date.now() + ".md"), fm + content); count++; } catch { /* skip */ } }
					} else {
						const notePath = noteFolder + "/" + noteFileName;
						try { await this.app.vault.create(notePath, fm + content); count++; }
						catch { try { await this.app.vault.create(noteFolder + "/" + safeName(f.basename) + "_笔记_" + Date.now() + ".md", fm + content); count++; } catch { /* skip */ } }
					}
				}
				new Notice(tf("已创建 {n} 个笔记", { n: count }));
				this.notePickerActive = false;
				this.fpSelected.clear();
				void this.renderNotesTab();
			})();
		});
	}

	async listNoteViewFiles(folder: string): Promise<TFile[]> {
		const excludeCfg = this.plugin.settings.excludeFolders || "";
		if (isAbs(folder)) {
			try {
				if (!fs.existsSync(folder)) return [];
				const files = fs.readdirSync(folder).filter((f: string) => f.endsWith(".md"));
				return files.map((f: string) => {
					const fp = path.join(folder, f);
					const stat = fs.statSync(fp);
					return { name: f, path: fp, basename: f.replace(/\.md$/, ""), stat: { mtime: stat.mtimeMs, size: stat.size } } as unknown as TFile;
				}).filter(f => !isExcludedPath(f.path, excludeCfg)).sort((a: TFile, b: TFile) => (b.stat.mtime || 0) - (a.stat.mtime || 0));
			} catch { return []; }
		}
		try {
			const tfolder = this.app.vault.getAbstractFileByPath(folder);
			if (!tfolder || !(tfolder instanceof TFolder)) return [];
			return (tfolder.children as TFile[]).filter(f => f instanceof TFile && f.name.endsWith(".md") && !isExcludedPath(f.path, excludeCfg)).sort((a, b) => (b.stat.mtime || 0) - (a.stat.mtime || 0));
		} catch { return []; }
	}

	// ===================== WRONG TAB =====================
	async renderWrongTab() {
		if (!this.innerContentEl) return;
		if (this.wrongView === "detail" && this.wrongCurrentNote) {
			this.renderWrongDetail();
		} else {
			await this.renderWrongList();
		}
	}

	async renderWrongList() {
		if (!this.innerContentEl) return;
		const el = this.innerContentEl;
		el.empty();

		const notes = await this.plugin.loadAllWrongNotes();
		this.wrongNotes = notes;
		const dueNotes = notes.filter((n: WrongAnswerNote) => isDueForReview(n));

		const statsRow = el.createDiv({ attr: { style: "display:flex;gap:6px;margin-bottom:10px;font-size:18px;" } });
		statsRow.createSpan({ text: tf("{label} {n}", { label: t("错题"), n: notes.length }), attr: { style: "padding:3px 8px;border-radius:4px;background:color-mix(in srgb, var(--color-red) 15%, transparent);color:var(--color-red);font-weight:600;" } });
		statsRow.createSpan({ text: tf("{label} {n}", { label: t("待复习"), n: dueNotes.length }), attr: { style: "padding:3px 8px;border-radius:4px;background:color-mix(in srgb, var(--color-orange) 15%, transparent);color:var(--color-orange);font-weight:600;" } });

		const modeBar = el.createDiv({ attr: { style: "display:flex;gap:2px;margin-bottom:10px;" } });
		const sortModes: { key: "default" | "source" | "tag" | "time"; label: string }[] = [
			{ key: "default", label: t("默认") },
			{ key: "source", label: t("按源文件") },
			{ key: "tag", label: t("按知识点") },
			{ key: "time", label: t("按时间") },
		];
		for (const m of sortModes) {
			const mb = modeBar.createEl("button", { text: m.label, attr: { style: "padding:3px 8px;border-radius:3px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:" + (this.wrongSortMode === m.key ? "var(--interactive-accent);color:var(--text-on-accent);" : "var(--background-secondary);color:var(--text-muted);") } });
			mb.addEventListener("click", () => { this.wrongSortMode = m.key; void this.renderWrongTab(); });
		}

		if (dueNotes.length > 0) {
			const dueBtn = el.createDiv({ attr: { style: "padding:10px;margin-bottom:10px;border-radius:6px;border:2px solid var(--interactive-accent);background:color-mix(in srgb, var(--interactive-accent) 5%, transparent);cursor:pointer;text-align:center;font-weight:600;font-size:19px;" } });
			dueBtn.setText(tf("开始今日复习 ({n}题)", { n: dueNotes.length }));
			dueBtn.addEventListener("click", () => { this.wrongView = "detail"; this.wrongCurrentNote = dueNotes[0]!; void this.renderWrongTab(); });
		}

		const listEl = el.createDiv({});

		this.adminBatchUpdate = this.renderAdminBatchBar(el, notes.map(n => n.filePath), () => {
			const selected = notes.filter(n => this.adminSelected.has(n.filePath)).map(n => n.filePath);
			if (selected.length === 0) return;
			if (!confirm(tf("确定删除选中的 {n} 个错题记录？此操作不可撤销。", { n: selected.length }))) return;
			void (async () => {
				for (const p of selected) { try { await this.plugin.deleteWrongNote(p); } catch { /* skip */ } }
				for (const p of selected) this.adminSelected.delete(p);
				new Notice(tf("已删除 {n} 个错题记录", { n: selected.length }));
				void this.renderWrongTab();
			})();
		}, () => {
			const selected = notes.filter(n => this.adminSelected.has(n.filePath)).map(n => n.filePath);
			void this.adminExportFiles(selected, this.plugin.rootPath(this.plugin.settings.wrongBookFolder), t("错题批量导出"));
		});

		if (this.wrongSortMode === "default") {
			for (const note of notes) this.renderWrongNoteItem(listEl, note);
		} else if (this.wrongSortMode === "time") {
			const sorted = [...notes].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
			for (const note of sorted) this.renderWrongNoteItem(listEl, note);
		} else if (this.wrongSortMode === "source") {
			const sourceGroups: Record<string, WrongAnswerNote[]> = {};
			const noSource: WrongAnswerNote[] = [];
			for (const note of notes) {
				const src = (note.sourceFile || "").replace(/\[\[|\]\]/g, "").trim();
				if (!src) { noSource.push(note); continue; }
				if (!sourceGroups[src]) sourceGroups[src] = [];
				sourceGroups[src].push(note);
			}
			const sortedSources = Object.entries(sourceGroups).sort((a, b) => b[1].length - a[1].length);
			for (const [src, srcNotes] of sortedSources) {
				const group = listEl.createDiv({ attr: { style: "margin-bottom:8px;border:1px solid var(--background-modifier-border);border-radius:6px;overflow:hidden;" } });
				const header = group.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:pointer;background:var(--background-secondary);" } });
				const arrow = header.createSpan({ text: "▸", attr: { style: "font-size:17px;color:var(--text-muted);min-width:14px;" } });
				header.createSpan({ text: src, attr: { style: "font-weight:600;font-size:18px;color:var(--interactive-accent);flex:1;" } });
				header.createSpan({ text: tf("{n}题", { n: srcNotes.length }), attr: { style: "font-size:17px;color:var(--text-muted);" } });
				const list = group.createDiv({ attr: { style: "display:none;padding:4px 8px;" } });
				for (const note of srcNotes) this.renderWrongNoteItem(list, note);
				let expanded = false;
				header.addEventListener("click", () => { expanded = !expanded; list.style.display = expanded ? "block" : "none"; arrow.setText(expanded ? "▾" : "▸"); });
			}
			if (noSource.length > 0) {
				listEl.createDiv({ text: t("未分类"), attr: { style: "font-size:18px;font-weight:600;color:var(--text-muted);margin:10px 0 6px;" } });
				for (const note of noSource) this.renderWrongNoteItem(listEl, note);
			}
		} else {
			const tagGroups: Record<string, WrongAnswerNote[]> = {};
			const untagged: WrongAnswerNote[] = [];
			for (const note of notes) {
				const kp = knowledgeTags(note.tags);
				if (kp.length === 0) { untagged.push(note); continue; }
				for (const t of kp) {
					if (!tagGroups[t]) tagGroups[t] = [];
					tagGroups[t].push(note);
				}
			}
			const sortedTags = Object.entries(tagGroups).sort((a, b) => b[1].length - a[1].length);
			for (const [tag, tagNotes] of sortedTags) {
				const group = listEl.createDiv({ attr: { style: "margin-bottom:8px;border:1px solid var(--background-modifier-border);border-radius:6px;overflow:hidden;" } });
				const header = group.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:pointer;background:var(--background-secondary);" } });
				const arrow = header.createSpan({ text: "▸", attr: { style: "font-size:17px;color:var(--text-muted);min-width:14px;" } });
				header.createSpan({ text: "#" + tag, attr: { style: "font-weight:600;font-size:18px;color:var(--interactive-accent);flex:1;" } });
				header.createSpan({ text: tf("{n}题", { n: tagNotes.length }), attr: { style: "font-size:17px;color:var(--text-muted);" } });
				const list = group.createDiv({ attr: { style: "display:none;padding:4px 8px;" } });
				for (const note of tagNotes) this.renderWrongNoteItem(list, note);
				let expanded = false;
				header.addEventListener("click", () => { expanded = !expanded; list.style.display = expanded ? "block" : "none"; arrow.setText(expanded ? "▾" : "▸"); });
			}
			if (untagged.length > 0) {
				listEl.createDiv({ text: t("未分类"), attr: { style: "font-size:18px;font-weight:600;color:var(--text-muted);margin:10px 0 6px;" } });
				for (const note of untagged.slice(0, MAX_UNTAGGED_DISPLAY)) this.renderWrongNoteItem(listEl, note);
				if (untagged.length > 10) listEl.createDiv({ text: tf("还有{n}题...", { n: untagged.length - 10 }), attr: { style: "font-size:17px;color:var(--text-muted);text-align:center;padding:6px;" } });
			}
		}

		if (notes.length === 0) {
			el.createDiv({ text: t("暂无错题记录"), attr: { style: "color:var(--text-faint);text-align:center;padding:20px 0;font-size:19px;" } });
		}
	}

	renderWrongNoteItem(container: HTMLDivElement, note: WrongAnswerNote) {
		const item = container.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;padding:6px 8px;margin-bottom:4px;border-radius:4px;border:1px solid var(--background-modifier-border);font-size:18px;cursor:pointer;transition:background 0.15s;" } });
		const cb = item.createEl("input", { attr: { type: "checkbox", style: "flex-shrink:0;width:14px;height:14px;cursor:pointer;" } });
		cb.checked = this.adminSelected.has(note.filePath);
		cb.addEventListener("change", (e) => {
			e.stopPropagation();
			if (cb.checked) this.adminSelected.add(note.filePath); else this.adminSelected.delete(note.filePath);
			this.adminBatchUpdate?.();
		});
		const nameText = (note.sourceFile || note.baseName).replace(/\[\[|\]\]/g, "");
		const nameEl = item.createSpan({ text: nameText, attr: { style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--interactive-accent);cursor:pointer;" } });
		nameEl.addEventListener("click", (e) => {
			e.stopPropagation();
			const noteFile = this.app.vault.getFiles().find(f => f.path === note.filePath || f.basename === note.baseName);
			if (noteFile) { this.app.workspace.openLinkText(noteFile.path, "", false).catch(() => {}); return; }
			const srcFile = this.app.vault.getFiles().find(f => f.basename === nameText || f.name === nameText);
			if (srcFile) this.app.workspace.openLinkText(srcFile.path, "", false).catch(() => {});
			else new Notice(tf("找不到文件：{name}", { name: nameText }));
		});
		if (note.tags.length > 0) {
			const kTags = knowledgeTags(note.tags);
			this.renderKnowledgeTags(item, kTags);
		}
		if ((note.wrongCount || 0) > 0) item.createSpan({ text: tf("错{n}次", { n: note.wrongCount }), attr: { style: "font-size:16px;color:var(--color-red);min-width:36px;text-align:right;flex-shrink:0;" } });
		if (note.nextReview) {
			const isOverdue = isDueForReview(note);
			if (isOverdue) {
				item.createSpan({ text: t("已到期"), attr: { style: "font-size:16px;color:var(--interactive-accent);font-weight:600;min-width:40px;text-align:right;flex-shrink:0;" } });
			} else {
				const days = daysUntil(note.nextReview);
				item.createSpan({ text: tf("{d}天后", { d: days }), attr: { style: "font-size:16px;color:var(--text-faint);min-width:40px;text-align:right;flex-shrink:0;" } });
			}
		}
		const genBtn = item.createSpan({ text: "📒", attr: { title: t("生成笔记"), style: "padding:1px 4px;border-radius:3px;cursor:pointer;font-size:16px;color:var(--interactive-accent);flex-shrink:0;" } });
		genBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			void this.noteGenStartDirect((note.sourceFile || note.baseName).replace(/\[\[|\]\]/g, ""), note.resultText, note.sourcePath || note.filePath);
		});
		const delBtn = item.createSpan({ text: "×", cls: "qg-note-del" });
		delBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			void (async () => {
				if (!confirm(t("确定从错题本移除？"))) return;
				await this.plugin.deleteWrongNote(note.filePath);
				void this.renderWrongTab();
			})();
		});
		item.classList.add("qg-hover-bg");
	}

	renderWrongDetail() {
		if (!this.innerContentEl || !this.wrongCurrentNote) return;
		const el = this.innerContentEl;
		el.empty();
		const note = this.wrongCurrentNote;

		const backBtn = el.createEl("button", { text: t("← 返回列表"), attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:19px;margin-bottom:12px;" } });
		backBtn.addEventListener("click", () => { this.wrongView = "list"; this.wrongCurrentNote = null; void this.renderWrongTab(); });

		el.createDiv({ text: tf("加入时间：{d}", { d: note.date }), attr: { style: "color:var(--text-muted);font-size:18px;margin-bottom:6px;" } });
		if (note.tags.length > 0) {
			const tE = el.createDiv({ attr: { style: "margin-bottom:6px;" } });
			for (const t of note.tags) tE.createSpan({ text: "#" + t, attr: { style: "font-size:17px;color:var(--interactive-accent);margin-right:6px;" } });
		}
		if (note.note) el.createDiv({ text: tf("备注：{n}", { n: note.note }), attr: { style: "color:var(--text-faint);font-size:18px;font-style:italic;margin-bottom:8px;" } });
		el.createDiv({ text: note.resultText, attr: { style: "border:1px solid var(--background-modifier-border);border-radius:6px;padding:10px;max-height:400px;overflow-y:auto;white-space:pre-wrap;font-size:19px;line-height:1.6;" } });

		const btnRow = el.createDiv({ attr: { style: "margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;" } });
		const actBtn = (label: string, cls: string, cb: () => void) => {
			const b = btnRow.createEl("button", { text: label, attr: { class: cls, style: "padding:4px 10px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
			b.addEventListener("click", cb);
		};
		actBtn(t("查看错题文件"), "mod-cta", () => {
			const noteFile = this.app.vault.getFiles().find(f => f.path === note.filePath || f.basename === note.baseName);
			if (noteFile) { this.app.workspace.openLinkText(noteFile.path, "", false).catch(() => {}); }
			else new Notice(t("找不到错题文件"));
		});
		actBtn(t("开始答题"), "", () => {
			if (!note.resultText) { new Notice(t("无题目内容")); return; }
			this.startAnswer(note.resultText, note.sourceFile || note.baseName, note.sourcePath || "");
		});
		actBtn(t("基于原文重新生成"), "", () => { void this.wrongRePracticeSingle(note); });
		actBtn(t("导出MD"), "", () => { void this.wrongExportNote(note, "md"); });
		actBtn(t("导出Word"), "", () => { void this.wrongExportNote(note, "word"); });
		actBtn(t("导出PDF"), "", () => { void this.wrongExportNote(note, "pdf"); });
		actBtn(t("删除"), "mod-warning", () => { void this.wrongDeleteNote(note); });

		const due = isDueForReview(note);
		const reviewSection = el.createDiv({ attr: { style: "margin-top:12px;padding:12px;border-radius:8px;border:1px solid " + (due ? "var(--interactive-accent)" : "var(--background-modifier-border)") + ";background:" + (due ? "color-mix(in srgb, var(--interactive-accent) 5%, transparent)" : "var(--background-secondary)") + ";" } });
		const dueInfo = due ? t("已到复习时间") : tf("下次复习: {d}", { d: note.nextReview || t("未设置") });
		const correctCount = note.correctCount || 0;
		const wrongCount = note.wrongCount || 0;
		reviewSection.createDiv({ text: dueInfo + tf("　间隔: {i}天　答对{c}次　答错{w}次", { i: note.interval, c: correctCount, w: wrongCount }), attr: { style: "font-size:18px;color:var(--text-muted);margin-bottom:8px;" } });
		reviewSection.createDiv({ text: t("判断对错："), attr: { style: "font-size:19px;font-weight:600;margin-bottom:8px;" } });
		const qRow = reviewSection.createDiv({ attr: { style: "display:flex;gap:8px;" } });
		const correctBtn = qRow.createEl("button", { text: t("✓ 正确"), attr: { style: "padding:6px 16px;border-radius:4px;cursor:pointer;font-size:18px;border:2px solid var(--color-green);background:var(--background-secondary);color:var(--color-green);font-weight:600;" } });
		correctBtn.addEventListener("click", () => { void this.wrongUpdateScheduling(note, true); });
		const wrongBtn = qRow.createEl("button", { text: t("✗ 错误"), attr: { style: "padding:6px 16px;border-radius:4px;cursor:pointer;font-size:18px;border:2px solid var(--color-red);background:var(--background-secondary);color:var(--color-red);font-weight:600;" } });
		wrongBtn.addEventListener("click", () => { void this.wrongUpdateScheduling(note, false); });
	}

	async wrongDeleteNote(note: WrongAnswerNote) {
		if (!confirm(t("确定删除这条错题记录？此操作不可撤销。"))) return;
		if (isAbs(this.plugin.rootPath(this.plugin.settings.wrongBookFolder))) deleteFileAbs(note.filePath);
		else { const file = this.app.vault.getAbstractFileByPath(note.filePath); if (file instanceof TFile) await this.app.fileManager.trashFile(file); }
		new Notice(t("已删除"));
		this.plugin.emitDataChanged();
		this.wrongView = "list";
		this.wrongCurrentNote = null;
		await this.renderWrongTab();
	}

	async wrongRePracticeSingle(note: WrongAnswerNote) {
		const srcName = note.sourceFile.replace(/\[\[|\]\]/g, "");
		let sourceText = "";
		let found = false;
		let srcPath = "";
		const src = this.app.vault.getFiles().find(f => f.basename === srcName || f.name === srcName);
		if (src) { sourceText = await this.app.vault.read(src); found = true; srcPath = src.path; }
		else if (isAbs(this.plugin.rootPath(this.plugin.settings.questionFolder))) {
			const qDir = this.plugin.rootPath(this.plugin.settings.questionFolder);
			if (fs.existsSync(qDir)) {
				for (const f of fs.readdirSync(qDir)) {
					if (f.includes(srcName) && f.endsWith(".md")) { sourceText = readFileStr(joinPath(qDir, f)); found = true; srcPath = joinPath(qDir, f); break; }
				}
			}
		}
		if (found) { this.startGenerate(sourceText, srcName, srcPath); }
		else new Notice(t("源文件不存在"));
	}

	async wrongRePracticeDue() {
		const dueNotes = this.wrongNotes.filter(n => isDueForReview(n));
		const sources: string[] = [];
		const paths: string[] = [];
		for (const note of dueNotes) {
			const srcName = note.sourceFile.replace(/\[\[|\]\]/g, "");
			const src = this.app.vault.getFiles().find(f => f.basename === srcName || f.name === srcName);
			if (src) { sources.push(await this.app.vault.read(src)); paths.push(src.path); }
			else if (isAbs(this.plugin.rootPath(this.plugin.settings.questionFolder))) {
				const qDir = this.plugin.rootPath(this.plugin.settings.questionFolder);
				if (fs.existsSync(qDir)) { for (const f of fs.readdirSync(qDir)) { if (f.includes(srcName) && f.endsWith(".md")) { sources.push(readFileStr(joinPath(qDir, f))); paths.push(joinPath(qDir, f)); break; } } }
			}
		}
		if (sources.length === 0) { new Notice(t("没有可用的源文件")); return; }
		this.startGenerate(sources.join("\n\n---\n\n"), t("今日待复习题目"), paths.join(","));
	}

	async wrongExportNote(note: WrongAnswerNote, format: "md" | "word" | "pdf") {
		try {
			
			const dateStr = note.date || new Date().toISOString().slice(0, 10);
			const srcName = note.sourceFile?.replace(/\[\[|\]\]/g, "") || "";
			if (format === "md") {
				const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: note.baseName + ".md", filters: [{ name: "Markdown", extensions: ["md"] }] });
				if (r.canceled || !r.filePath) return;
				const mdContent = "# " + note.baseName + "\n\n> 来源：" + (srcName || t("未知")) + "　|　日期：" + dateStr + "\n\n" + stripAnswerSummarySection(note.resultText);
				fs.writeFileSync(r.filePath, mdContent, "utf-8");
				new Notice(t("Md文件已保存"));
			} else if (format === "word") {
				const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: note.baseName + ".docx", filters: [{ name: "Word", extensions: ["docx"] }] });
				if (r.canceled || !r.filePath) return;
				const children = buildWordParagraphs(note.resultText, note.baseName, srcName + " " + dateStr);
				const doc = new Document({ sections: [{ properties: {}, children }] });
				const buffer = await Packer.toBuffer(doc);
				fs.writeFileSync(r.filePath, Buffer.from(buffer));
				new Notice(t("Word文件已保存"));
			} else if (format === "pdf") {
				const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: note.baseName + ".pdf", filters: [{ name: "PDF", extensions: ["pdf"] }] });
				if (r.canceled || !r.filePath) return;
				await exportPdfDirect(r.filePath, note.resultText, note.baseName, srcName + " " + dateStr);
				new Notice(t("PDF文件已保存"));
			}
		} catch (err) { new Notice(tf("导出失败：{msg}", { msg: (err as Error).message })); }
	}

	syncToKnowledgeIndex(tags: string[], label: string, filePath: string, source: IndexSource) {
		const kTags = knowledgeTags(tags);
		if (kTags.length === 0) return;
		void this.plugin.syncKnowledgeFolder(kTags, [{ label, path: filePath }], source, this.plugin.rootPath(this.plugin.settings.knowledgeFolder));
	}

	private renderAdminBatchBar(container: HTMLElement, allKeys: string[], deleteCb: () => void, exportCb: () => void) {
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

	private async adminDeleteFiles(paths: string[], folder: string, rerender: () => void) {
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

	private async adminExportFiles(paths: string[], folder: string, title: string) {
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

	async getStats() {
		const wrongNotes = await this.plugin.loadAllWrongNotes();
		const questionFiles = await this.plugin.loadAllQuestionFilesForReview();
		const vaultNotes = await this.plugin.loadAllVaultNotesForReview();
		const allReviewItems = [...wrongNotes, ...questionFiles, ...vaultNotes];
		const dueCount = allReviewItems.filter(n => isDueForReview(n)).length;
		const weakPoints = await this.plugin.getWeakPoints();
		const qFolder = this.plugin.rootPath(this.plugin.settings.questionFolder);
		const nFolder = this.plugin.rootPath(this.plugin.settings.noteViewFolder);
		let questionCount = 0;
		let noteCount = 0;
		const excludeCfg = this.plugin.settings.excludeFolders || "";
		if (qFolder) {
			const excludes = [this.plugin.rootPath(this.plugin.settings.knowledgeFolder)].filter(Boolean);
			if (isAbs(qFolder)) { try { if (fs.existsSync(qFolder)) questionCount = listMdFilesRecursive(qFolder, excludes).filter(fp => !isExcludedPath(fp, excludeCfg)).length; } catch { /* */ } }
			else { const prefix = qFolder.endsWith("/") ? qFolder : qFolder + "/"; const exclPrefixes = excludes.map(p => (p.endsWith("/") ? p : p + "/")); questionCount = this.app.vault.getFiles().filter(f => f.path.startsWith(prefix) && f.extension === "md" && !exclPrefixes.some(e => f.path.startsWith(e)) && !isExcludedPath(f.path, excludeCfg)).length; }
		}
		if (nFolder) {
			if (isAbs(nFolder)) { try { if (fs.existsSync(nFolder)) noteCount = fs.readdirSync(nFolder).filter((f: string) => f.endsWith(".md") && !isExcludedPath(path.join(nFolder, f), excludeCfg)).length; } catch { /* */ } }
			else { const tf = this.app.vault.getAbstractFileByPath(nFolder); if (tf instanceof TFolder) noteCount = tf.children.filter(f => f instanceof TFile && f.name.endsWith(".md") && !isExcludedPath(f.path, excludeCfg)).length; }
		}
		return {
			dueCount,
			totalWrong: wrongNotes.length,
			weakCount: weakPoints.length,
			questionCount,
			noteCount,
		};
	}

	async getDueNotes(): Promise<{ note: WrongAnswerNote; source: "wrong" | "question" | "note" }[]> {
		const wrongNotes = await this.plugin.loadAllWrongNotes();
		const questionFiles = await this.plugin.loadAllQuestionFilesForReview();
		const vaultNotes = await this.plugin.loadAllVaultNotesForReview();
		return [
			...wrongNotes.map(n => ({ note: n, source: "wrong" as const })),
			...questionFiles.map(n => ({ note: n, source: "question" as const })),
			...vaultNotes.map(n => ({ note: n, source: "note" as const })),
		].filter(i => isDueForReview(i.note));
	}
}

