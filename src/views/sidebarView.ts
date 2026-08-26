import { ItemView, Modal, Notice, TFile, TFolder, WorkspaceLeaf, type App } from "obsidian";
import { Document, Packer } from "docx";
import * as fs from "fs";
import * as path from "path";

import type QuestionGeneratorPlugin from "../main";
import {
	SIDEBAR_VIEW_TYPE, MAX_EXAM_CHUNK_CHARS, EXAM_CHUNK_OVERLAP, MAX_UNTAGGED_DISPLAY, MAX_HISTORY_SNIPPET,
	AI_REQUEST_TIMEOUT_MS, TOKEN_WARN_THRESHOLD,
	SEARCH_DEBOUNCE_MS, PREVIEW_ITEMS_LIMIT, INTERVAL_PRESETS,
} from "../constants";
import type { HistoryEntry, WrongAnswerNote, QuestionType, ParsedQuestion, PluginSettings, TreeNode } from "../types";
import type { IndexSource } from "../services/knowledgeService";
import { parseFM, buildFM, knowledgeTags, buildKnowledgeLinks } from "../utils/frontmatter";
import { isAbs, daysUntil, writeFileStr, readFileStr, deleteFileAbs, ensureFolder, listMdFiles, listMdFilesRecursive, isImageFile, isDocumentFile, EXAM_SOURCE_EXTS, joinPath, isExcludedPath } from "../utils/fs-utils";
import { safeName, cleanSourceText, estimateTokens, stripAnswersForExport } from "../utils/text";
import { convertDocumentToText } from "../services/documentService";
import { DEFAULT_WRONG_INTERVALS, DEFAULT_QUESTION_INTERVALS, DEFAULT_NOTE_INTERVALS, parseReviewIntervals, reviewUpdate, isDueForReview } from "../utils/review";
import { parseQuestions } from "../utils/parse";
import { debounce } from "../utils/debounce";
import { buildFileTree } from "../utils/filetree";
import { stripAnswerSummarySection, splitAnswerContent, fixSequentialNumbers, normalizeExamContent } from "../utils/layout";
import { buildWordParagraphs, exportPdfDirect } from "../utils/exporter";
import { getElectronRemote } from "../utils/electron";
import { chatLLM, type ChatLLMOptions } from "../services/llmService";
import { buildExamExtractPrompt, buildGeneratePrompt, parseAITagsFromResult, mergeExamChunks } from "../services/questionService";
import { buildTaggingPrompt, parseTaggedResult } from "../services/knowledgeService";
import { buildNotePrompt, parseNoteResult, buildNoteFrontmatter, type NoteGenSourceType } from "../services/noteService";
import { t, tf } from "../i18n/index";

export class MainSidebarView extends ItemView {
	plugin: QuestionGeneratorPlugin;
	activeSection: "home" | "questions" | "notes" | "wrong" | "review" | "settings" = "home";
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
			const navItems: { key: "home" | "questions" | "notes" | "wrong" | "review" | "settings"; label: string; icon: string }[] = [
				{ key: "home", label: t("首页"), icon: "🏠" },
				{ key: "questions", label: t("题目"), icon: "📝" },
				{ key: "notes", label: t("笔记"), icon: "📋" },
				{ key: "wrong", label: t("错题"), icon: "❌" },
				{ key: "review", label: t("复习"), icon: "📊" },
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
			this.innerContentEl = container.createDiv({ attr: { style: "flex:1;overflow-y:auto;padding:0 14px 14px;" } });
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

		switch (this.activeSection) {
			case "home": await this.renderHomeTab(); break;
			case "questions": await this.renderQuestionsTab(); break;
			case "notes": await this.renderNotesTab(); break;
			case "wrong": await this.renderWrongTab(); break;
			case "review": await this.renderReviewTab(); break;
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
		rebuildRow.addEventListener("click", () => { void (async () => { await this.plugin.rebuildKnowledgeIndex(); new Notice(t("知识点索引已重建")); })(); });
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

	private syncToKnowledgeIndex(tags: string[], label: string, filePath: string, source: IndexSource) {
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

	private async updateReviewSchedule(note: WrongAnswerNote, source: "wrong" | "question" | "note", wasCorrect: boolean): Promise<{ correctCount: number; interval: number; nextReview: string }> {
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
	async renderReviewTab() {
		if (!this.innerContentEl) return;
		const el = this.innerContentEl;
		el.empty();

		const wrongNotes = await this.plugin.loadAllWrongNotes();
		const questionFiles = await this.plugin.loadAllQuestionFilesForReview();
		const vaultNotes = await this.plugin.loadAllVaultNotesForReview();

		type ReviewItem = { note: WrongAnswerNote; source: "wrong" | "question" | "note" };
		const allItems: ReviewItem[] = [
			...wrongNotes.map(n => ({ note: n, source: "wrong" as const })),
			...questionFiles.map(n => ({ note: n, source: "question" as const })),
			...vaultNotes.map(n => ({ note: n, source: "note" as const })),
		];

		const filterBar = el.createDiv({ attr: { style: "display:flex;gap:2px;margin-bottom:10px;" } });
		const filterOpts: { key: "all" | "wrong" | "question" | "note"; label: string }[] = [
			{ key: "all", label: t("全部") },
			{ key: "wrong", label: t("错题") },
			{ key: "question", label: t("题目") },
			{ key: "note", label: t("笔记") },
		];
		const dueItems = allItems.filter(i => isDueForReview(i.note));
		for (const opt of filterOpts) {
			const count = opt.key === "all" ? dueItems.length : dueItems.filter(i => i.source === opt.key).length;
			const btn = filterBar.createEl("button", { text: opt.label + " (" + count + ")", attr: { style: "padding:3px 8px;border-radius:3px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:" + (this.reviewFilterType === opt.key ? "var(--interactive-accent);color:var(--text-on-accent);" : "var(--background-secondary);color:var(--text-muted);") } });
			btn.addEventListener("click", () => { this.reviewFilterType = opt.key; void this.renderReviewTab(); });
		}

		const sortBar = el.createDiv({ attr: { style: "display:flex;gap:2px;margin-bottom:10px;" } });
		const sortOpts: { key: "default" | "source" | "tag" | "time"; label: string }[] = [
			{ key: "default", label: t("默认") },
			{ key: "source", label: t("按源文件") },
			{ key: "tag", label: t("按知识点") },
			{ key: "time", label: t("按时间") },
		];
		for (const opt of sortOpts) {
			const btn = sortBar.createEl("button", { text: opt.label, attr: { style: "padding:3px 8px;border-radius:3px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:" + (this.reviewSortBy === opt.key ? "var(--interactive-accent);color:var(--text-on-accent);" : "var(--background-secondary);color:var(--text-muted);") } });
			btn.addEventListener("click", () => { this.reviewSortBy = opt.key; void this.renderReviewTab(); });
		}

		if (dueItems.length === 0) {
			el.createDiv({ text: t("今日暂无待复习内容，继续学习积累吧！"), attr: { style: "color:var(--text-muted);text-align:center;padding:30px 0;font-size:20px;" } });
			return;
		}

		const filteredDue = this.reviewFilterType === "all" ? dueItems : dueItems.filter(i => i.source === this.reviewFilterType);

		const sourceLabel: Record<string, string> = { wrong: t("错题"), question: t("题目"), note: t("笔记") };
		const sourceColor: Record<string, string> = { wrong: "var(--color-red)", question: "var(--interactive-accent)", note: "var(--color-green)" };

		const banner = el.createDiv({ attr: { style: "padding:14px 16px;margin-bottom:14px;border-radius:8px;border:2px solid var(--interactive-accent);background:color-mix(in srgb, var(--interactive-accent) 8%, transparent);" } });
		const bTop = banner.createDiv({ attr: { style: "display:flex;align-items:center;justify-content:space-between;" } });
		bTop.createDiv({ text: t("今日待复习"), attr: { style: "font-size:20px;font-weight:700;color:var(--interactive-accent);" } });
		bTop.createDiv({ text: tf("{n} 项", { n: dueItems.length }), attr: { style: "font-size:26px;font-weight:bold;color:var(--interactive-accent);" } });
		const parts: string[] = [];
		const wDue = dueItems.filter(i => i.source === "wrong").length;
		const qDue = dueItems.filter(i => i.source === "question").length;
		const nDue = dueItems.filter(i => i.source === "note").length;
		if (wDue > 0) parts.push(tf("错题 {n}", { n: wDue }));
		if (qDue > 0) parts.push(tf("题目 {n}", { n: qDue }));
		if (nDue > 0) parts.push(tf("笔记 {n}", { n: nDue }));
		if (parts.length > 0) banner.createDiv({ text: parts.join("　"), attr: { style: "font-size:17px;color:var(--text-muted);margin-top:4px;" } });

		const sortedDue = [...filteredDue];
		if (this.reviewSortBy === "source") {
			sortedDue.sort((a, b) => (a.note.sourceFile || a.note.baseName).localeCompare(b.note.sourceFile || b.note.baseName));
		} else if (this.reviewSortBy === "tag") {
			sortedDue.sort((a, b) => (knowledgeTags(a.note.tags)[0] || "").localeCompare(knowledgeTags(b.note.tags)[0] || ""));
		} else if (this.reviewSortBy === "time") {
			sortedDue.sort((a, b) => (a.note.nextReview || "").localeCompare(b.note.nextReview || ""));
		} else {
			const priority: Record<string, number> = { wrong: 0, question: 1, note: 2 };
			sortedDue.sort((a, b) => priority[a.source]! - priority[b.source]!);
		}

		let lastGroup = "";
		for (const item of sortedDue) {
			const groupKey = this.reviewSortBy === "source" ? (item.note.sourceFile || item.note.baseName) : this.reviewSortBy === "tag" ? (knowledgeTags(item.note.tags)[0] || t("无标签")) : "";
			if (this.reviewSortBy !== "default" && groupKey && groupKey !== lastGroup) {
				if (lastGroup !== "") el.createDiv({ attr: { style: "height:6px;" } });
				el.createDiv({ text: groupKey, attr: { style: "font-size:16px;font-weight:500;color:var(--text-faint);margin-bottom:4px;padding-left:4px;" } });
				lastGroup = groupKey;
			}
			this.renderReviewRow(el, item, sourceLabel, sourceColor, daysUntil);
		}
	}

	private renderReviewRow(container: HTMLElement, item: { note: WrongAnswerNote; source: string }, sourceLabel: Record<string, string>, sourceColor: Record<string, string>, daysUntil: (s: string) => number) {
		const row = container.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;padding:6px 8px;margin-bottom:4px;border-radius:4px;border:1px solid var(--background-modifier-border);font-size:18px;transition:background 0.15s;" } });
		row.classList.add("qg-hover-bg");
		row.createSpan({ text: sourceLabel[item.source] || item.source, attr: { style: "min-width:32px;font-size:13px;padding:1px 5px;border-radius:3px;background:" + (sourceColor[item.source] || "var(--text-muted)") + ";color:white;" } });
		const nameText = (item.note.sourceFile || item.note.baseName).replace(/\[\[|\]\]/g, "");
		row.createSpan({ text: nameText, attr: { style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--interactive-accent);" } });
		const kp = knowledgeTags(item.note.tags);
		this.renderKnowledgeTags(row, kp);
		if (item.source === "wrong" && (item.note.wrongCount || 0) > 0) row.createSpan({ text: tf("错{n}次", { n: item.note.wrongCount }), attr: { style: "font-size:15px;color:var(--color-red);min-width:36px;text-align:right;flex-shrink:0;" } });
		if (item.note.nextReview) {
			const isOverdue = isDueForReview(item.note);
			if (isOverdue) {
				row.createSpan({ text: t("已到期"), attr: { style: "font-size:15px;color:var(--interactive-accent);font-weight:600;min-width:44px;text-align:right;" } });
			} else {
				row.createSpan({ text: tf("{d}天后", { d: daysUntil(item.note.nextReview) }), attr: { style: "font-size:15px;color:var(--text-faint);min-width:44px;text-align:right;" } });
			}
		}
		const doneBtn = row.createEl("button", { text: t("✓ 完成"), attr: { style: "padding:2px 8px;border-radius:3px;cursor:pointer;font-size:15px;border:1px solid var(--color-green);background:transparent;color:var(--color-green);white-space:nowrap;" } });
		doneBtn.addEventListener("click", (e) => { e.stopPropagation(); void this.markReviewDone(item.note, item.source as "wrong" | "question" | "note"); });
		const failBtn = row.createEl("button", { text: t("✗ 仍错"), attr: { style: "padding:2px 8px;border-radius:3px;cursor:pointer;font-size:15px;border:1px solid var(--color-red);background:transparent;color:var(--color-red);white-space:nowrap;" } });
		failBtn.addEventListener("click", (e) => { e.stopPropagation(); void this.markReviewStillWrong(item.note, item.source as "wrong" | "question" | "note"); });
		row.addEventListener("click", () => {
			if (item.source === "wrong") { this.wrongView = "detail"; this.wrongCurrentNote = item.note; this.activeSection = "wrong"; void this.render(); }
			else { void this.app.workspace.openLinkText(item.note.baseName, "", false); }
		});
	}

	private async markReviewDone(note: WrongAnswerNote, source: "wrong" | "question" | "note") {
		try {
			const result = await this.updateReviewSchedule(note, source, true);
			new Notice(tf("已标记完成！下次复习 {d}（间隔{i}天）", { d: result.nextReview, i: result.interval }));
			void this.renderReviewTab();
		} catch (err) {
			new Notice(tf("更新复习计划失败：{msg}", { msg: (err as Error).message }));
		}
	}

	private async markReviewStillWrong(note: WrongAnswerNote, source: "wrong" | "question" | "note") {
		try {
			await this.updateReviewSchedule(note, source, false);
			new Notice(t("已记录错误，明天复习"));
			void this.renderReviewTab();
		} catch (err) {
			new Notice(tf("更新复习计划失败：{msg}", { msg: (err as Error).message }));
		}
	}

	// ===================== SETTINGS TAB =====================
	renderSettingsTab() {
		if (!this.innerContentEl) return;
		const el = this.innerContentEl;
		const savedScrollTop = el.scrollTop;
		el.empty();
		const s = this.plugin.settings;

		const section = (title: string) => {
			el.createDiv({ text: title, attr: { style: "font-size:19px;font-weight:600;color:var(--text-muted);margin:14px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--background-modifier-border);" } });
		};
		const fieldRow = (label: string, minW = "70px") => {
			const row = el.createDiv({ attr: { style: "display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:18px;" } });
			row.createSpan({ text: label, attr: { style: "min-width:" + minW + ";color:var(--text-muted);" } });
			return row;
		};
		const textInput = (row: HTMLElement, value: string, onChange: (v: string) => void, placeholder?: string) => {
			const inp = row.createEl("input", { attr: { type: "text", value, style: "flex:1;padding:5px;border-radius:4px;border:1px solid var(--background-modifier-border);", placeholder: placeholder || "" } });
			inp.addEventListener("change", () => { onChange(inp.value); void this.plugin.saveSettings(); });
			return inp;
		};

		section("文件夹");
		el.createDiv({ text: "根文件夹下包含所有模块子文件夹，修改后需重启插件生效", attr: { style: "color:var(--text-muted);font-size:17px;margin-bottom:8px;" } });
		textInput(fieldRow("根文件夹"), s.rootFolder, v => { s.rootFolder = v; }, "智学助手");
		textInput(fieldRow("题目文件夹"), s.questionFolder, v => { s.questionFolder = v; });
		textInput(fieldRow("错题文件夹"), s.wrongBookFolder, v => { s.wrongBookFolder = v; });
		textInput(fieldRow("笔记文件夹"), s.noteViewFolder, v => { s.noteViewFolder = v; }, "笔记");
		textInput(fieldRow("知识点文件夹"), s.knowledgeFolder, v => { s.knowledgeFolder = v; }, "知识点");
		textInput(fieldRow("转换md文件夹"), s.convertedMdFolder, v => { s.convertedMdFolder = v; }, "md文件");
		textInput(fieldRow("AI识别文件夹"), s.extractedExamFolder, v => { s.extractedExamFolder = v; }, "题目/识别试卷");
		textInput(fieldRow("排除文件夹"), s.excludeFolders, v => { s.excludeFolders = v; });
		const asRow = fieldRow("");
		const asCb = asRow.createEl("input", { attr: { type: "checkbox" } });
		asCb.checked = s.autoSave;
		asCb.addEventListener("change", () => { s.autoSave = asCb.checked; void this.plugin.saveSettings(); });
		asRow.createSpan({ text: "生成后自动保存到题库" });
		el.createDiv({ text: "预期目录结构：\n根文件夹/\n├─ 题目/（含 识别试卷/）\n├─ 错题/\n├─ 笔记/\n├─ 知识点/（统一索引，含相关题目/相关笔记/相关错题三段）\n└─ md文件/", attr: { style: "color:var(--text-muted);font-size:16px;line-height:1.6;margin-top:10px;padding:10px 12px;border-radius:6px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);white-space:pre-wrap;" } });

		section("默认题目数量");
		const counts = [
			{ label: "单选题", key: "countSingle" as const },
			{ label: "多选题", key: "countMulti" as const },
			{ label: "判断题", key: "countJudge" as const },
			{ label: "填空题", key: "countBlank" as const },
			{ label: "简答题", key: "countEssay" as const },
		];
		const countGrid = el.createDiv({ attr: { style: "display:grid;grid-template-columns:1fr 1fr;gap:6px;" } });
		for (const c of counts) {
			const row = countGrid.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;font-size:18px;" } });
			row.createSpan({ text: c.label, attr: { style: "min-width:50px;color:var(--text-muted);" } });
			const inp = row.createEl("input", { attr: { type: "number", min: "0", max: "50", value: String(s[c.key]), style: "width:50px;padding:4px;border-radius:4px;border:1px solid var(--background-modifier-border);text-align:center;" } });
			inp.addEventListener("change", () => { s[c.key] = parseInt(inp.value) || 0; void this.plugin.saveSettings(); });
			row.createSpan({ text: "题", attr: { style: "color:var(--text-muted);" } });
		}

		section("API 配置");
		const apiTypeRow = fieldRow("接口类型");
		const apiTypeSel = apiTypeRow.createEl("select", { attr: { style: "flex:1;padding:5px;border-radius:4px;border:1px solid var(--background-modifier-border);" } });
		apiTypeSel.createEl("option", { value: "ollama", text: "Ollama" });
		apiTypeSel.createEl("option", { value: "openai", text: "OpenAI兼容" });
		apiTypeSel.value = s.apiType;
		apiTypeSel.addEventListener("change", () => { s.apiType = apiTypeSel.value as "ollama" | "openai"; void this.plugin.saveSettings(); });
		textInput(fieldRow("接口地址"), s.baseUrl, v => { s.baseUrl = v; });
		textInput(fieldRow("模型名称"), s.modelName, v => { s.modelName = v; });
		textInput(fieldRow("API Key"), s.apiKey || "", v => { s.apiKey = v; });
		const tempRow = fieldRow("Temperature");
		const tempInput = tempRow.createEl("input", { attr: { type: "number", min: "0", max: "2", step: "0.1", value: String(s.temperature), style: "width:60px;padding:5px;border-radius:4px;border:1px solid var(--background-modifier-border);text-align:center;" } });
		tempInput.addEventListener("change", () => { s.temperature = parseFloat(tempInput.value) || 0.1; void this.plugin.saveSettings(); });
		tempRow.createSpan({ text: String(s.temperature), attr: { id: "pg-temp-val", style: "color:var(--text-muted);min-width:30px;" } });
		tempInput.addEventListener("input", () => { const v = tempRow.querySelector("#pg-temp-val"); if (v) v.textContent = tempInput.value; });

		section("复习间隔设置");
		el.createDiv({ text: "参数越大复习间隔越长，记忆越牢固但可能遗忘；参数越小复习越频繁，短期效果好但耗时多。推荐使用默认值。", attr: { style: "color:var(--text-muted);font-size:17px;margin-bottom:10px;line-height:1.5;padding:8px 10px;border-radius:6px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);" } });

		const renderIntervalRow = (label: string, currentValue: string, presetKey: string, onChange: (v: string) => void) => {
			const row = el.createDiv({ attr: { style: "margin-bottom:14px;padding:10px;border-radius:6px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);" } });
			row.createDiv({ text: label, attr: { style: "font-size:18px;font-weight:600;margin-bottom:6px;" } });
			const presets = INTERVAL_PRESETS[presetKey]!;
			const btnRow = row.createDiv({ attr: { style: "display:flex;gap:4px;margin-bottom:6px;" } });
			const currentPreset = presets.find(p => p.values === currentValue);
			for (const p of presets) {
				const isActive = p.values === currentValue;
				const btn = btnRow.createEl("button", { text: p.label, cls: isActive ? "qg-interval-active" : undefined, attr: { style: "padding:3px 10px;border-radius:3px;cursor:pointer;font-size:16px;border:1px solid var(--background-modifier-border);" + (isActive ? "" : "background:var(--background-primary);color:var(--text-muted);") } });
				btn.addEventListener("click", () => { onChange(p.values); void this.plugin.saveSettings(); row.parentElement && this.renderSettingsTab(); });
			}
			const activePreset = currentPreset || presets[1]!;
			const tipRow = row.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:16px;color:var(--text-muted);" } });
			tipRow.createSpan({ text: "💡", attr: { style: "font-size:14px;" } });
			tipRow.createSpan({ text: activePreset.hint });
			const customRow = row.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;" } });
			customRow.createSpan({ text: "自定义：", attr: { style: "font-size:16px;color:var(--text-muted);flex-shrink:0;" } });
			const inp = customRow.createEl("input", { attr: { type: "text", value: currentValue, style: "flex:1;padding:4px 6px;border-radius:4px;border:1px solid var(--background-modifier-border);font-size:16px;font-family:monospace;", placeholder: "如 1,2,4,7,15,30" } });
			inp.addEventListener("change", () => { onChange(inp.value); void this.plugin.saveSettings(); });
		};

		renderIntervalRow("错题复习间隔（天）", s.wrongReviewIntervals, "wrong", v => { s.wrongReviewIntervals = v; });
		renderIntervalRow("题目复习间隔（天）", s.questionReviewIntervals, "question", v => { s.questionReviewIntervals = v; });
		renderIntervalRow("笔记复习间隔（天）", s.noteReviewIntervals, "note", v => { s.noteReviewIntervals = v; });
		section("学习设置");
		const wpRow = fieldRow("薄弱点阈值");
		const wpInput = wpRow.createEl("input", { attr: { type: "number", min: "1", max: "20", value: String(s.weakPointThreshold), style: "width:60px;padding:5px;border-radius:4px;border:1px solid var(--background-modifier-border);text-align:center;" } });
		wpInput.addEventListener("change", () => { s.weakPointThreshold = parseInt(wpInput.value) || 2; void this.plugin.saveSettings(); });
		wpRow.createSpan({ text: "次以上错题标记为薄弱", attr: { style: "color:var(--text-muted);" } });
		const rrRow = fieldRow("");
		const rrCb = rrRow.createEl("input", { attr: { type: "checkbox" } });
		rrCb.checked = s.autoReviewReminder;
		rrCb.addEventListener("change", () => { s.autoReviewReminder = rrCb.checked; void this.plugin.saveSettings(); });
		rrRow.createSpan({ text: "启动时提醒复习" });

		window.requestAnimationFrame(() => { el.scrollTop = savedScrollTop; });
	}

	// ===================== FILE PICKER (unified, matches exam browser) =====================
	renderFilePicker() {
		if (!this.innerContentEl) return;
		const el = this.innerContentEl;
		el.empty();

		const backBtn = el.createEl("button", { text: "← 返回", attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:19px;margin-bottom:12px;" } });
		backBtn.addEventListener("click", () => { this.fpSelected.clear(); this.homeView = "default"; void this.renderHomeTab(); });

		el.createDiv({ text: "生成题目", attr: { style: "font-size:21px;font-weight:bold;margin-bottom:4px;" } });
		el.createDiv({ text: "选择vault中的文档，AI根据内容生成各类题目，生成后保存到题库", attr: { style: "color:var(--text-muted);font-size:17px;margin-bottom:12px;" } });

		const modeRow = el.createDiv({ attr: { style: "display:flex;gap:4px;margin-bottom:12px;" } });
		const modes: { key: "current" | "folder"; label: string }[] = [
			{ key: "current", label: "当前文件" },
			{ key: "folder", label: "从文件夹选择" },
		];
		for (const m of modes) {
			const btn = modeRow.createEl("button", { text: m.label, attr: { style: "padding:4px 12px;border-radius:3px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:" + (this.genPickerMode === m.key ? "var(--interactive-accent);color:var(--text-on-accent);" : "var(--background-secondary);color:var(--text-muted);") } });
			btn.addEventListener("click", () => { this.genPickerMode = m.key; this.fpSelected.clear(); this.renderFilePicker(); });
		}

		if (this.genPickerMode === "current") {
			const activeFile = this.app.workspace.getActiveFile();
			const activeExt = activeFile ? activeFile.extension.toLowerCase() : "";
			if (!activeFile || (activeExt !== "md" && !EXAM_SOURCE_EXTS.includes(activeExt))) {
				el.createDiv({ text: "请先打开一个文档（md/txt/rtf/docx/pdf/图片）", attr: { style: "color:var(--text-muted);text-align:center;padding:30px 0;font-size:19px;" } });
			} else {
				const info = el.createDiv({ attr: { style: "padding:8px 10px;border-radius:6px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);margin-bottom:12px;font-size:17px;" } });
				info.createSpan({ text: "当前文件：" });
				info.createSpan({ text: activeFile.path, attr: { style: "color:var(--interactive-accent);word-break:break-all;" } });
				info.createDiv({ text: this.fileSizeInfo(activeFile), attr: { style: "color:var(--text-muted);font-size:16px;margin-top:2px;line-height:1.5;" } });
				const processBtn = el.createEl("button", { text: "📝 基于当前文件生成题目", attr: { style: "padding:8px 20px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--interactive-accent);background:var(--interactive-accent);color:var(--text-on-accent);" } });
				processBtn.addEventListener("click", () => { void this.generateFromCurrentFile(); });
			}
		} else {
			this.loadPickerFiles();

			const infoEl = el.createDiv({ attr: { style: "color:var(--text-muted);font-size:18px;margin-bottom:6px;" } });
			infoEl.setText(this.selectInfoText(this.fpAllFiles, this.fpSelected));

			const searchInput = el.createEl("input", { attr: { type: "text", placeholder: "搜索文件名...", style: "width:100%;padding:6px 8px;border-radius:4px;border:1px solid var(--background-modifier-border);margin-bottom:8px;" } });

			const toolBar = el.createDiv({ attr: { style: "margin-bottom:8px;display:flex;gap:6px;" } });
			const toolBtn = (label: string, cb: () => void) => {
				const b = toolBar.createEl("button", { text: label, attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
				b.addEventListener("click", cb);
			};

			const listEl = el.createDiv({ attr: { style: "max-height:420px;overflow-y:auto;" } });
			const btnRow = el.createDiv({ attr: { style: "margin-top:12px;display:flex;gap:8px;" } });
			const confirmBtn = btnRow.createEl("button", { text: "📝 生成题目（0个）", attr: { style: "flex:1;padding:8px 16px;border-radius:4px;font-size:19px;cursor:pointer;border:1px solid var(--interactive-accent);background:var(--interactive-accent);color:var(--text-on-accent);opacity:0.5;pointer-events:none;" } });
			confirmBtn.addEventListener("click", () => {
				if (this.fpSelected.size === 0) { new Notice("请至少选择一个文件"); return; }
				void this.generateFromSelected();
			});
			const clearBtn = btnRow.createEl("button", { text: "清空选择", attr: { style: "padding:8px 16px;border-radius:4px;font-size:19px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
			clearBtn.addEventListener("click", () => { this.fpSelected.clear(); rerender(); });
			const updateConfirm = () => {
				const size = this.fpSelected.size;
				confirmBtn.setText("📝 生成题目（" + size + "个）");
				confirmBtn.style.opacity = size === 0 ? "0.5" : "1";
				confirmBtn.style.pointerEvents = size === 0 ? "none" : "auto";
			};
			const rerender = () => { this.renderSelectTree(listEl, searchInput, infoEl, this.fpAllFiles, this.fpSelected, rerender, updateConfirm, this.fpExpanded); updateConfirm(); };
			toolBtn("全选", () => { this.fpAllFiles.forEach(f => this.fpSelected.add(f.path)); rerender(); });
			toolBtn("取消全选", () => { this.fpSelected.clear(); rerender(); });
			searchInput.addEventListener("input", debounce(() => rerender(), SEARCH_DEBOUNCE_MS));
			rerender();
		}
	}

	async generateFromCurrentFile() {
		const file = this.app.workspace.getActiveFile();
		const ext = file ? file.extension.toLowerCase() : "";
		if (!file || (ext !== "md" && !EXAM_SOURCE_EXTS.includes(ext))) { new Notice("请打开一个支持的文档（md/txt/rtf/docx/PDF/图片）"); return; }
		const text = await this.examSourceToText(file);
		if (!text || text.trim().length === 0) { new Notice("未能读取文件内容"); return; }
		this.startGenerate(text, file.name, file.path);
	}

	async generateFromSelected() {
		const chosen = this.fpAllFiles.filter(f => this.fpSelected.has(f.path));
		if (chosen.length === 0) return;
		let combined = "";
		const paths: string[] = [];
		for (const f of chosen) {
			const text = await this.examSourceToText(f);
			if (text && text.trim().length > 0) { combined += "\n\n---\n\n" + text; paths.push(f.path); }
		}
		if (paths.length === 0) { new Notice("所选文件均无法读取内容"); return; }
		this.startGenerate(combined.trim(), paths.length + "个文档", paths.join(","));
	}

	selectInfoText(files: TFile[], selected: Set<string>): string {
		const sel = files.filter(f => selected.has(f.path));
		let size = 0;
		let toks = 0;
		for (const f of sel) { size += f.stat.size; toks += this.fileTokenEstimate(f); }
		const extra = sel.length > 0 ? "　已选≈" + Math.round(size / 1024).toLocaleString() + "KB · ≈" + toks.toLocaleString() + " token" : "";
		return "共 " + files.length + " 个文档，已选 " + selected.size + " 个" + extra;
	}

	fileTokenEstimate(f: TFile): number {
		const size = f.stat.size;
		const ext = f.extension.toLowerCase();
		if (ext === "md" || ext === "txt" || ext === "rtf") return Math.ceil(size / 2);
		return Math.ceil(size / 4);
	}

	fileSizeInfo(f: TFile): string {
		return "大小：" + Math.round(f.stat.size / 1024).toLocaleString() + "KB　预估Token：≈" + this.fileTokenEstimate(f).toLocaleString();
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
	async renderExamBrowser() {
		if (!this.innerContentEl) return;
		if (this.homeView !== "examBrowser") return;
		const el = this.innerContentEl;
		el.empty();

		const backBtn = el.createEl("button", { text: "← 返回", attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:19px;margin-bottom:12px;" } });
		backBtn.addEventListener("click", () => { this.cancelAI(); this.examSelected.clear(); this.examStatusText = ""; this.homeView = "default"; void this.renderHomeTab(); });

		el.createDiv({ text: "AI 识别试卷", attr: { style: "font-size:21px;font-weight:bold;margin-bottom:4px;" } });
		el.createDiv({ text: "选择vault中的文档，AI自动识别并提取其中的题目，保存后进入答题模式", attr: { style: "color:var(--text-muted);font-size:17px;margin-bottom:12px;" } });

		if (this.examProcessing) {
			const statusEl = el.createDiv({ attr: { style: "text-align:center;padding:24px 0;" } });
			statusEl.createDiv({ text: "⏳", attr: { style: "font-size:28px;margin-bottom:8px;" } });
			statusEl.createDiv({ text: this.examStatusText || "AI 正在识别题目...", attr: { style: "color:var(--text-muted);font-size:19px;" } });
			const stopBtn = statusEl.createEl("button", { text: "⏹ 停止", attr: { style: "padding:6px 16px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--color-red);background:var(--background-secondary);color:var(--color-red);margin-top:12px;" } });
			stopBtn.addEventListener("click", () => this.cancelAI());
			return;
		}

		if (this.examFiles.length === 0) this.loadExamFiles();

		const modeRow = el.createDiv({ attr: { style: "display:flex;gap:4px;margin-bottom:12px;" } });
		const modes: { key: "current" | "folder"; label: string }[] = [
			{ key: "current", label: "当前文件" },
			{ key: "folder", label: "从文件夹选择" },
		];
		for (const m of modes) {
			const btn = modeRow.createEl("button", { text: m.label, attr: { style: "padding:4px 12px;border-radius:3px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:" + (this.examMode === m.key ? "var(--interactive-accent);color:var(--text-on-accent);" : "var(--background-secondary);color:var(--text-muted);") } });
			btn.addEventListener("click", () => { this.examMode = m.key; this.examSelected.clear(); void this.renderExamBrowser(); });
		}

		if (this.examMode === "current") {
			const activeFile = this.app.workspace.getActiveFile();
			const activeExt = activeFile ? activeFile.extension.toLowerCase() : "";
			if (!activeFile || (activeExt !== "md" && !EXAM_SOURCE_EXTS.includes(activeExt))) {
				el.createDiv({ text: "请先打开一个试卷文件（md/txt/rtf/docx/pdf/图片）", attr: { style: "color:var(--text-muted);text-align:center;padding:30px 0;font-size:19px;" } });
			} else {
				const info = el.createDiv({ attr: { style: "padding:8px 10px;border-radius:6px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);margin-bottom:12px;font-size:17px;" } });
				info.createSpan({ text: "当前文件：" });
				info.createSpan({ text: activeFile.path, attr: { style: "color:var(--interactive-accent);" } });
				info.createDiv({ text: this.fileSizeInfo(activeFile), attr: { style: "color:var(--text-muted);margin-top:2px;" } });
				const processBtn = el.createEl("button", { text: "📄 识别当前文件", attr: { style: "padding:8px 20px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--interactive-accent);background:var(--interactive-accent);color:var(--text-on-accent);" } });
				processBtn.addEventListener("click", () => { void this.openCurrentFileExtract(); });
			}
		} else {
			const infoEl = el.createDiv({ attr: { style: "color:var(--text-muted);font-size:18px;margin-bottom:6px;" } });
			infoEl.setText(this.selectInfoText(this.examFiles, this.examSelected));

			const searchInput = el.createEl("input", { attr: { type: "text", placeholder: "搜索文件名...", style: "width:100%;padding:6px 8px;border-radius:4px;border:1px solid var(--background-modifier-border);margin-bottom:8px;" } });

			const toolBar = el.createDiv({ attr: { style: "margin-bottom:8px;display:flex;gap:6px;" } });
			const toolBtn = (label: string, cb: () => void) => {
				const b = toolBar.createEl("button", { text: label, attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
				b.addEventListener("click", cb);
			};

			const listEl = el.createDiv({ attr: { style: "max-height:420px;overflow-y:auto;" } });
			const btnRow = el.createDiv({ attr: { style: "margin-top:12px;display:flex;gap:8px;" } });
			const procBtn = btnRow.createEl("button", { text: "🔍 AI 识别题目（0个）", attr: { style: "flex:1;padding:8px 16px;border-radius:4px;font-size:19px;cursor:pointer;border:1px solid var(--interactive-accent);background:var(--interactive-accent);color:var(--text-on-accent);opacity:0.5;pointer-events:none;" } });
			procBtn.addEventListener("click", () => {
				if (this.examSelected.size === 0) { new Notice("请至少选择一个文件"); return; }
				void this.extractFromExamSelected();
			});
			const clearBtn = btnRow.createEl("button", { text: "清空选择", attr: { style: "padding:8px 16px;border-radius:4px;font-size:19px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
			clearBtn.addEventListener("click", () => { this.examSelected.clear(); rerender(); });
			const updateConfirm = () => {
				const size = this.examSelected.size;
				procBtn.setText("🔍 AI 识别题目（" + size + "个）");
				procBtn.style.opacity = size === 0 ? "0.5" : "1";
				procBtn.style.pointerEvents = size === 0 ? "none" : "auto";
			};
			const rerender = () => { this.renderSelectTree(listEl, searchInput, infoEl, this.examFiles, this.examSelected, rerender, updateConfirm, this.examExpanded); updateConfirm(); };
			toolBtn("全选", () => { this.examFiles.forEach(f => this.examSelected.add(f.path)); rerender(); });
			toolBtn("取消全选", () => { this.examSelected.clear(); rerender(); });
			searchInput.addEventListener("input", debounce(() => rerender(), SEARCH_DEBOUNCE_MS));
			rerender();
		}

		if (this.examStatusText) {
			el.createDiv({ text: this.examStatusText, attr: { style: "margin-top:10px;padding:8px 10px;border-radius:6px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);font-size:17px;color:var(--text-muted);" } });
		}
	}

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

	loadExamFiles() { this.examFiles = this.loadSourceFiles(); }

	loadPickerFiles() {
		this.fpAllFiles = this.loadSourceFiles();
		if (this.genPickerFolder) {
			const prefix = this.genPickerFolder.endsWith("/") ? this.genPickerFolder : this.genPickerFolder + "/";
			this.fpAllFiles = this.fpAllFiles.filter(f => f.path.startsWith(prefix));
		}
	}

	loadTaggerFiles() {
		const excludeList = this.buildExcludeList();
		this.fpAllFiles = this.app.vault.getFiles().filter(f => {
			if (f.extension !== "md") return false;
			const lp = f.path.toLowerCase();
			for (const ex of excludeList) { if (lp.includes(ex + "/") || lp.startsWith(ex)) return false; }
			return true;
		});
	}

	async extractFromExamSelected() {
		const files = this.examFiles.filter(f => this.examSelected.has(f.path));
		if (files.length === 0) return;

		this.examProcessing = true;
		this.resetAI();
		this.examStatusText = "准备识别 " + files.length + " 个文件...";
		void this.renderExamBrowser();

		const cfg = this.plugin.settings;
		const saveFolder = this.plugin.rootPath(cfg.extractedExamFolder || "题目/识别试卷");
		await ensureFolder(this.app, saveFolder);
		const savedPaths: string[] = [];
		const savedSynced: { tags: string[]; label: string; path: string }[] = [];
		let totalQuestions = 0;

		for (let i = 0; i < files.length; i++) {
			if (this.aiCancelled) break;
			const file = files[i];
			if (!file) continue;
			this.examStatusText = "正在识别 (" + (i + 1) + "/" + files.length + ") " + file.name + "...";
			void this.renderExamBrowser();

			try {
				const content = await this.examSourceToText(file);
				if (!content || content.trim().length === 0) continue;

				let allQuestionsText = "";
				if (isImageFile(file.name)) {
					allQuestionsText = content;
				} else {
					const chunks: string[] = [];
					if (content.length <= MAX_EXAM_CHUNK_CHARS) {
						chunks.push(content);
					} else {
						this.examStatusText = "正在识别 (" + (i + 1) + "/" + files.length + ") " + file.name + "（内容较长，分" + Math.ceil(content.length / MAX_EXAM_CHUNK_CHARS) + "段识别）...";
						void this.renderExamBrowser();
						const overlap = EXAM_CHUNK_OVERLAP;
						for (let start = 0; start < content.length; start += MAX_EXAM_CHUNK_CHARS - overlap) {
							chunks.push(content.slice(start, start + MAX_EXAM_CHUNK_CHARS));
							if (start + MAX_EXAM_CHUNK_CHARS >= content.length) break;
						}
					}

				for (let ci = 0; ci < chunks.length; ci++) {
					if (this.aiCancelled) break;
					const chunk = chunks[ci]!;
					if (chunks.length > 1) {
						this.examStatusText = "正在识别 (" + (i + 1) + "/" + files.length + ") " + file.name + " - 第" + (ci + 1) + "/" + chunks.length + "段...";
						void this.renderExamBrowser();
					}
					const prompt = buildExamExtractPrompt(chunk, ci + 1, chunks.length);
					const full = await this.callAIWithPrompt(prompt);
					if (full) allQuestionsText += "\n\n" + full;
				}
			}
			if (this.aiCancelled) break;
			if (!allQuestionsText.trim()) continue;

				const mergedText = mergeExamChunks(allQuestionsText);

				const questions = parseQuestions(mergedText);
				if (questions.length === 0) continue;
				totalQuestions += questions.length;

				const { cleanText } = parseAITagsFromResult(allQuestionsText);
				const aiTags = await this.aiSuggestTags(mergedText);
				const normalized = normalizeExamContent(fixSequentialNumbers(cleanText));
				const safeName = file.basename.replace(/[<>:"/\\|?*]/g, "_");
				const savePath = saveFolder + "/" + safeName + " - AI识别.md";
				const dateStr = new Date().toISOString().slice(0, 10);
				const allTags = ["试卷", "AI识别", ...aiTags.filter(t => t !== "试卷" && t !== "AI识别")];
				const sourceLink = "[[" + file.basename + "]]";
				const qIvls = parseReviewIntervals(this.plugin.settings.questionReviewIntervals, DEFAULT_QUESTION_INTERVALS);
				const nextReviewDate = new Date(); nextReviewDate.setDate(nextReviewDate.getDate() + qIvls[0]!);
				const fmB = buildFM({ source: sourceLink, sourcePath: file.path, date: dateStr, tags: allTags, nextReview: nextReviewDate.toISOString().slice(0, 10), interval: qIvls[0]!, correctCount: 0, wrongCount: 0 });
				const kTagsB = knowledgeTags(allTags.filter(t => t !== "试卷" && t !== "AI识别"));
				const knowledgeLinksB = kTagsB.length > 0 ? "\n\n---\n\n**知识点：** " + kTagsB.map(t => "[[" + t + "]]").join(" ") + "\n" : "";
				const saveContent = fmB + normalized + knowledgeLinksB;
				try { await this.app.vault.create(savePath, saveContent); }
				catch { await this.app.vault.create(saveFolder + "/" + safeName + " - AI识别_" + Date.now() + ".md", saveContent); }
				savedPaths.push(savePath);
				savedSynced.push({ tags: allTags, label: safeName, path: savePath });
			} catch (err) {
				if ((err as Error).name === "AbortError") {
					if (this.aiCancelled) break;
					this.examProcessing = false;
					this.examStatusText = "识别超时（3分钟）";
					void this.renderExamBrowser();
					return;
				}
			}
		}

		this.examProcessing = false;
		if (this.aiCancelled) {
			this.examStatusText = "已中止";
			void this.renderExamBrowser();
			return;
		}
		this.examStatusText = "";
		this.examSelected.clear();

		for (const item of savedSynced) this.syncToKnowledgeIndex(item.tags, item.label, item.path, "题目");
		this.plugin.emitDataChanged();

		if (savedPaths.length === 0) {
			this.examStatusText = "所有文件均未能识别出题目";
			void this.renderExamBrowser();
			return;
		}

		if (savedPaths.length === 1 && savedPaths[0]) {
			const savedFile = this.app.vault.getAbstractFileByPath(savedPaths[0]);
			if (savedFile && savedFile instanceof TFile) {
				const content2 = await this.app.vault.read(savedFile);
				const clean2 = content2.replace(/^---[\s\S]*?---\s*/, "");
				new Notice("识别完成，共 " + totalQuestions + " 题，已保存至 " + savedPaths[0]);
				this.startAnswer(clean2, savedFile.basename, savedFile.path);
				return;
			}
		}

		let combined = "";
		const paths: string[] = [];
		for (const p of savedPaths) {
			const f = this.app.vault.getAbstractFileByPath(p);
			if (f && f instanceof TFile) {
				const c = await this.app.vault.read(f);
				combined += "\n\n---\n\n" + c.replace(/^---[\s\S]*?---\s*/, "");
				paths.push(p);
			}
		}
		new Notice("识别完成，共 " + totalQuestions + " 题，已保存 " + savedPaths.length + " 个文件");
		this.startGenerate(normalizeExamContent(combined.trim()), savedPaths.length + "个识别试卷", paths.join(","));
	}

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
			const prompt = buildExamExtractPrompt("（试卷图片已随请求提供，请识别图片中的全部内容并提取所有题目）");
			new Notice("图片识别：请确认当前模型支持多模态（视觉）能力");
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
	async renderTaggerView() {
		if (!this.innerContentEl) return;
		if (this.homeView !== "tagger") return;
		const el = this.innerContentEl;
		el.empty();

		const backBtn = el.createEl("button", { text: "← 返回", attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:19px;margin-bottom:12px;" } });
		backBtn.addEventListener("click", () => { this.cancelAI(); this.fpSelected.clear(); this.taggerStatusText = ""; this.homeView = "default"; void this.renderHomeTab(); });
		el.createDiv({ text: "AI添加标签", attr: { style: "font-size:21px;font-weight:bold;margin-bottom:4px;" } });
		el.createDiv({ text: "AI识别文档中的知识点，自动写入frontmatter，用于Obsidian知识图谱", attr: { style: "color:var(--text-muted);font-size:17px;margin-bottom:12px;" } });

		const modeRow = el.createDiv({ attr: { style: "display:flex;gap:4px;margin-bottom:12px;" } });
		const modes: { key: "current" | "folder"; label: string }[] = [
			{ key: "current", label: "当前文件" },
			{ key: "folder", label: "从文件夹选择" },
		];
		for (const m of modes) {
			const btn = modeRow.createEl("button", { text: m.label, attr: { style: "padding:4px 12px;border-radius:3px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:" + (this.taggerMode === m.key ? "var(--interactive-accent);color:var(--text-on-accent);" : "var(--background-secondary);color:var(--text-muted);") } });
			btn.addEventListener("click", () => { this.taggerMode = m.key; this.fpSelected.clear(); void this.renderTaggerView(); });
		}

		if (this.taggerMode === "current") {
			const activeFile = this.app.workspace.getActiveFile();
			if (!activeFile || activeFile.extension !== "md") {
				el.createDiv({ text: "请先打开一个Markdown文件", attr: { style: "color:var(--text-muted);text-align:center;padding:30px 0;font-size:19px;" } });
			} else {
				const info = el.createDiv({ attr: { style: "padding:8px 10px;border-radius:6px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);margin-bottom:12px;font-size:17px;" } });
				info.createSpan({ text: "当前文件：" });
				info.createSpan({ text: activeFile.path, attr: { style: "color:var(--interactive-accent);" } });
				info.createDiv({ text: this.fileSizeInfo(activeFile), attr: { style: "color:var(--text-muted);margin-top:2px;" } });
				const btnRow = el.createDiv({ attr: { style: "display:flex;gap:8px;align-items:center;" } });
				const processBtn = btnRow.createEl("button", { text: this.taggerProcessing ? "处理中..." : "🤖 开始识别标签", attr: { style: "padding:8px 20px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--interactive-accent);background:var(--interactive-accent);color:var(--text-on-accent);" + (this.taggerProcessing ? "opacity:0.5;pointer-events:none;" : "") } });
				processBtn.addEventListener("click", () => { void this.runAITagging([activeFile]); });
				if (this.taggerProcessing) {
					const stopBtn = btnRow.createEl("button", { text: "⏹ 停止", attr: { style: "padding:8px 20px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--color-red);background:var(--background-secondary);color:var(--color-red);" } });
					stopBtn.addEventListener("click", () => this.cancelAI());
				}
			}
		} else {
			this.loadTaggerFiles();
			const infoEl = el.createDiv({ attr: { style: "color:var(--text-muted);font-size:18px;margin-bottom:6px;" } });
			infoEl.setText(this.selectInfoText(this.fpAllFiles, this.fpSelected));

			const searchInput = el.createEl("input", { attr: { type: "text", placeholder: "搜索文件名...", style: "width:100%;padding:6px 8px;border-radius:4px;border:1px solid var(--background-modifier-border);margin-bottom:8px;" } });

			const toolBar = el.createDiv({ attr: { style: "margin-bottom:8px;display:flex;gap:6px;" } });
			const toolBtn = (label: string, cb: () => void) => {
				const b = toolBar.createEl("button", { text: label, attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
				b.addEventListener("click", cb);
			};

			const listEl = el.createDiv({ attr: { style: "max-height:420px;overflow-y:auto;" } });
			const btnRow = el.createDiv({ attr: { style: "margin-top:12px;display:flex;gap:8px;" } });
			const procBtn = btnRow.createEl("button", { text: (this.taggerProcessing ? "处理中..." : "🤖 开始识别标签（0个）"), attr: { style: "flex:1;padding:8px 16px;border-radius:4px;font-size:19px;cursor:pointer;border:1px solid var(--interactive-accent);background:var(--interactive-accent);color:var(--text-on-accent);opacity:0.5;pointer-events:none;" } });
			procBtn.addEventListener("click", () => {
				const files = this.fpAllFiles.filter(f => this.fpSelected.has(f.path));
				void this.runAITagging(files);
			});
			const clearBtn = btnRow.createEl("button", { text: "清空选择", attr: { style: "padding:8px 16px;border-radius:4px;font-size:19px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
			clearBtn.addEventListener("click", () => { this.fpSelected.clear(); rerender(); });
			if (this.taggerProcessing) {
				const stopBtn = btnRow.createEl("button", { text: "⏹ 停止", attr: { style: "padding:8px 16px;border-radius:4px;font-size:19px;cursor:pointer;border:1px solid var(--color-red);background:var(--background-secondary);color:var(--color-red);" } });
				stopBtn.addEventListener("click", () => this.cancelAI());
			}
			const updateConfirm = () => {
				const size = this.fpSelected.size;
				procBtn.setText(this.taggerProcessing ? "处理中..." : "🤖 开始识别标签（" + size + "个）");
				const disabled = this.taggerProcessing || size === 0;
				procBtn.style.opacity = disabled ? "0.5" : "1";
				procBtn.style.pointerEvents = disabled ? "none" : "auto";
			};
			const rerender = () => { this.renderSelectTree(listEl, searchInput, infoEl, this.fpAllFiles, this.fpSelected, rerender, updateConfirm, this.taggerExpanded); updateConfirm(); };
			toolBtn("全选", () => { this.fpAllFiles.forEach(f => this.fpSelected.add(f.path)); rerender(); });
			toolBtn("取消全选", () => { this.fpSelected.clear(); rerender(); });
			searchInput.addEventListener("input", debounce(() => rerender(), SEARCH_DEBOUNCE_MS));
			rerender();
		}

		if (this.taggerStatusText) {
			el.createDiv({ text: this.taggerStatusText, attr: { style: "margin-top:10px;padding:8px 10px;border-radius:6px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);font-size:17px;color:var(--text-muted);" } });
		}
	}

	async runAITagging(files: TFile[]) {
		if (files.length === 0 || this.taggerProcessing) return;
		this.taggerProcessing = true;
		this.resetAI();
		this.taggerStatusText = "准备处理 " + files.length + " 个文件...";
		void this.renderTaggerView();

		const existingTags = await this.plugin.loadExistingKnowledgeTags();

		let successCount = 0;
		let failCount = 0;

		for (let i = 0; i < files.length; i++) {
			if (this.aiCancelled) break;
			const file = files[i]!;
			this.taggerStatusText = "正在识别 (" + (i + 1) + "/" + files.length + ") " + file.basename + "...";
			void this.renderTaggerView();

			try {
				const content = await this.app.vault.read(file);
				if (!content || content.trim().length === 0) { failCount++; continue; }

				const prompt = buildTaggingPrompt(content, existingTags);

				const full = await this.callAIWithPrompt(prompt);
				if (!full) { failCount++; continue; }

				const tags = parseTaggedResult(full);
				if (tags.length === 0) { failCount++; continue; }

				const { meta, body } = parseFM(content);
				const oldTags = Array.isArray(meta.tags) ? meta.tags : [];
				const mergedTags = [...new Set([...oldTags, ...tags])];
				const newFM = { ...meta, tags: mergedTags };
				const newContent = buildFM(newFM) + body;
				await this.app.vault.modify(file, newContent);
				successCount++;
			} catch (err) {
				if ((err as Error).name === "AbortError") {
					if (this.aiCancelled) break;
					failCount++;
					continue;
				}
				console.error("[question-generator] AI标签失败:", file.path, err);
				failCount++;
			}
		}

		this.taggerProcessing = false;
		this.taggerStatusText = (this.aiCancelled ? "已中止" : "完成") + "！成功 " + successCount + " 个，失败 " + failCount + " 个";
		void this.renderTaggerView();
		new Notice((this.aiCancelled ? "AI标签已中止：" : "AI标签完成：") + "成功 " + successCount + "，失败 " + failCount);
	}

	// ===================== NOTE GENERATION =====================
	async renderNoteGenView() {
		if (!this.innerContentEl) return;
		if (this.homeView !== "noteGen") return;
		const el = this.innerContentEl;
		el.empty();

		const backBtn = el.createEl("button", { text: "← 返回", attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:19px;margin-bottom:12px;" } });
		backBtn.addEventListener("click", () => {
			this.cancelAI();
			if (this.noteGenMode === "preview" && this.noteGenResultText) {
				this.noteGenMode = "picker";
				void this.renderNoteGenView();
				return;
			}
			this.noteGenSelected.clear();
			this.noteGenResultText = "";
			this.noteGenIsGenerating = false;
			this.noteGenMode = "picker";
			this.homeView = "default";
			void this.renderHomeTab();
		});

		if (this.noteGenIsGenerating && this.noteGenMode === "picker") {
			const status = el.createDiv({ attr: { style: "text-align:center;padding:40px 0;font-size:18px;color:var(--text-muted);" } });
			status.createDiv({ text: "🤖 正在批量生成笔记..." });
			status.createDiv({ text: "点击停止可中断，已完成的笔记会被保留", attr: { style: "font-size:15px;margin-top:8px;color:var(--text-faint);" } });
			const stopBtn = status.createEl("button", { text: "⏹ 停止", attr: { style: "margin-top:14px;padding:6px 18px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--color-red);background:var(--background-secondary);color:var(--color-red);" } });
			stopBtn.addEventListener("click", () => this.cancelAI());
			return;
		}

		el.createDiv({ text: "🤖 AI生成笔记", attr: { style: "font-size:21px;font-weight:bold;margin-bottom:4px;" } });
		el.createDiv({ text: "AI按原文结构浓缩生成知识点笔记（标题序号原样保留、正文精华缩写），自动识别标签并存入笔记库", attr: { style: "color:var(--text-muted);font-size:17px;margin-bottom:12px;" } });

		if (this.noteGenMode === "preview") {
			this.renderNoteGenPreview(el);
			return;
		}

		const typeRow = el.createDiv({ attr: { style: "display:flex;gap:4px;margin-bottom:12px;" } });
		const types: { key: NoteGenSourceType; label: string }[] = [
			{ key: "current", label: "当前文件" },
			{ key: "doc", label: "文件/文档" },
			{ key: "question", label: "题目" },
			{ key: "wrong", label: "错题" },
			{ key: "note", label: "现有笔记" },
		];
		for (const t of types) {
			const btn = typeRow.createEl("button", { text: t.label, attr: { style: "padding:4px 10px;border-radius:3px;cursor:pointer;font-size:16px;border:1px solid var(--background-modifier-border);background:" + (this.noteGenSourceType === t.key ? "var(--interactive-accent);color:var(--text-on-accent);" : "var(--background-secondary);color:var(--text-muted);") } });
			btn.addEventListener("click", () => { this.noteGenSourceType = t.key; this.noteGenSelected.clear(); this.noteGenResultText = ""; void this.renderNoteGenView(); });
		}

		const listWrap = el.createDiv({});

		if (this.noteGenSourceType === "current") {
			this.noteGenFiles = [];
			const activeFile = this.app.workspace.getActiveFile();
			const activeExt = activeFile ? activeFile.extension.toLowerCase() : "";
			if (!activeFile || (activeExt !== "md" && !EXAM_SOURCE_EXTS.includes(activeExt))) {
				listWrap.createDiv({ text: "请先打开一个文档（md/txt/rtf/docx/pdf/图片）", attr: { style: "color:var(--text-muted);text-align:center;padding:30px 0;font-size:19px;" } });
			} else {
				const info = listWrap.createDiv({ attr: { style: "padding:8px 10px;border-radius:6px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);margin-bottom:12px;font-size:17px;" } });
				info.createSpan({ text: "当前文件：" });
				info.createSpan({ text: activeFile.path, attr: { style: "color:var(--interactive-accent);" } });
				info.createDiv({ text: this.fileSizeInfo(activeFile), attr: { style: "color:var(--text-muted);margin-top:2px;" } });
				const genCurBtn = listWrap.createEl("button", { text: "🤖 基于当前文件生成笔记", attr: { style: "padding:8px 20px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--interactive-accent);background:var(--interactive-accent);color:var(--text-on-accent);" } });
				genCurBtn.addEventListener("click", () => {
					void (async () => {
						const f = this.app.workspace.getActiveFile();
						if (!f) return;
						const text = await this.noteSourceToText(f);
						if (!text || text.trim().length === 0) { new Notice("未能读取文件内容"); return; }
						await this.noteGenStartDirect(f.basename, text, f.path);
					})();
				});
			}
			return;
		}

		const btnRow = el.createDiv({ attr: { style: "margin-top:12px;display:flex;gap:8px;" } });
		const genBtn = btnRow.createEl("button", { text: "🤖 生成笔记（0篇）", attr: { style: "flex:1;padding:8px 16px;border-radius:4px;font-size:19px;cursor:pointer;border:1px solid var(--interactive-accent);background:var(--interactive-accent);color:var(--text-on-accent);opacity:0.5;pointer-events:none;" } });
		genBtn.addEventListener("click", () => {
			const keys = [...this.noteGenSelected];
			if (keys.length === 0) return;
			if (keys.length === 1) void this.noteGenGenerateOne(keys[0]!);
			else void this.noteGenGenerateBatch();
		});
		const clearBtn = btnRow.createEl("button", { text: "清空选择", attr: { style: "padding:8px 16px;border-radius:4px;font-size:19px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
		clearBtn.addEventListener("click", () => { this.noteGenSelected.clear(); void this.renderNoteGenView(); });
		const updateConfirm = () => {
			const size = this.noteGenSelected.size;
			genBtn.setText("🤖 生成笔记（" + size + "篇）");
			const disabled = size === 0;
			genBtn.style.opacity = disabled ? "0.5" : "1";
			genBtn.style.pointerEvents = disabled ? "none" : "auto";
		};

		if (this.noteGenSourceType === "wrong") {
			this.noteGenWrongNotes = await this.plugin.loadAllWrongNotes();
			if (this.noteGenWrongNotes.length === 0) {
				listWrap.createDiv({ text: "暂无错题记录", attr: { style: "color:var(--text-faint);text-align:center;padding:30px 0;font-size:19px;" } });
			} else {
				const infoEl = listWrap.createDiv({ attr: { style: "color:var(--text-muted);font-size:18px;margin-bottom:6px;" } });
				const listEl = listWrap.createDiv({ attr: { style: "max-height:360px;overflow-y:auto;border:1px solid var(--background-modifier-border);border-radius:6px;padding:6px 8px;" } });
				for (const note of this.noteGenWrongNotes) {
					const key = note.filePath;
					const row = listEl.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;padding:4px 2px;cursor:pointer;border-radius:4px;font-size:19px;" } });
					const cb = row.createEl("input", { attr: { type: "checkbox" } });
					cb.checked = this.noteGenSelected.has(key);
					const sync = () => {
						cb.checked ? this.noteGenSelected.add(key) : this.noteGenSelected.delete(key);
						infoEl.setText("共 " + this.noteGenWrongNotes.length + " 条错题，已选 " + this.noteGenSelected.size + " 条");
						updateConfirm();
					};
					row.createSpan({ text: (note.sourceFile || note.baseName).replace(/\[\[|\]\]/g, ""), attr: { style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" } });
					row.addEventListener("click", (e) => {
						if ((e.target as HTMLElement).tagName === "INPUT") return;
						cb.checked = !cb.checked;
						sync();
					});
					cb.addEventListener("change", sync);
				}
				infoEl.setText("共 " + this.noteGenWrongNotes.length + " 条错题，已选 " + this.noteGenSelected.size + " 条");
			}
			this.noteGenFiles = [];
		} else {
			if (this.noteGenSourceType === "doc") this.noteGenFiles = this.loadSourceFiles();
			else if (this.noteGenSourceType === "question") this.noteGenFiles = await this.listQuestionFiles(this.plugin.rootPath(this.plugin.settings.questionFolder));
			else this.noteGenFiles = await this.listNoteViewFiles(this.plugin.rootPath(this.plugin.settings.noteViewFolder));

			const infoEl = listWrap.createDiv({ attr: { style: "color:var(--text-muted);font-size:18px;margin-bottom:6px;" } });
			const searchInput = listWrap.createEl("input", { attr: { type: "text", placeholder: "搜索文件名...", style: "width:100%;padding:6px 8px;border-radius:4px;border:1px solid var(--background-modifier-border);margin-bottom:8px;" } });

			const toolBar = listWrap.createDiv({ attr: { style: "margin-bottom:8px;display:flex;gap:6px;" } });
			const toolBtn = (label: string, cb: () => void) => {
				const b = toolBar.createEl("button", { text: label, attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
				b.addEventListener("click", cb);
			};

			const listEl = listWrap.createDiv({ attr: { style: "max-height:360px;overflow-y:auto;" } });
			const rerender = () => { this.renderSelectTree(listEl, searchInput, infoEl, this.noteGenFiles, this.noteGenSelected, rerender, updateConfirm, this.noteGenExpanded); updateConfirm(); };
			toolBtn("全选", () => { this.noteGenFiles.forEach(f => this.noteGenSelected.add(f.path)); rerender(); });
			toolBtn("取消全选", () => { this.noteGenSelected.clear(); rerender(); });
			searchInput.addEventListener("input", debounce(() => rerender(), SEARCH_DEBOUNCE_MS));
			rerender();
		}

		updateConfirm();
	}

	renderNoteGenPreview(el: HTMLElement) {
		if (this.noteGenIsGenerating) {
			const status = el.createDiv({ attr: { style: "text-align:center;padding:40px 0;font-size:18px;color:var(--text-muted);" } });
			status.createSpan({ text: "🤖 正在生成笔记..." });
			status.createDiv({ text: "根据「" + (this.noteGenTargetName || "") + "」生成中，请稍候", attr: { style: "font-size:16px;margin-top:8px;color:var(--text-faint);" } });
			const stopBtn = status.createEl("button", { text: "⏹ 停止", attr: { style: "margin-top:14px;padding:6px 18px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--color-red);background:var(--background-secondary);color:var(--color-red);" } });
			stopBtn.addEventListener("click", () => this.cancelAI());
			return;
		}

		el.createDiv({ text: "生成预览", attr: { style: "font-size:20px;font-weight:bold;margin-bottom:4px;" } });
		el.createDiv({ text: "来源：" + (this.noteGenTargetName || ""), attr: { style: "color:var(--text-muted);font-size:17px;margin-bottom:8px;" } });
		el.createDiv({ text: "内容（可编辑）：", attr: { style: "font-size:18px;margin-bottom:4px;" } });
		const textArea = el.createEl("textarea", { attr: { style: "width:100%;height:300px;font-family:monospace;font-size:18px;line-height:1.5;resize:vertical;" } });
		textArea.value = this.noteGenResultText;
		textArea.addEventListener("input", () => { this.noteGenResultText = textArea.value; });

		el.createDiv({ text: "知识点标签（可编辑）：", attr: { style: "font-size:18px;margin:8px 0 4px;" } });
		const tagsInput = el.createEl("input", { attr: { type: "text", value: this.noteGenResultTags.join(", "), placeholder: "标签之间用逗号分隔", style: "width:100%;padding:6px 8px;border-radius:4px;border:1px solid var(--background-modifier-border);font-size:18px;" } });
		tagsInput.addEventListener("input", () => { this.noteGenResultTags = tagsInput.value.split(/[,，、;；]/).map(s => s.trim().replace(/^#+/, "")).filter(Boolean); });

		el.createDiv({ text: "保存后文件名：" + safeName(this.noteGenTargetName || "AI笔记") + "_笔记_日期.md", attr: { style: "color:var(--text-faint);font-size:15px;margin:8px 0;" } });

		const btnRow = el.createDiv({ attr: { style: "margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;" } });
		const cta = (label: string, cb: () => void) => {
			const b = btnRow.createEl("button", { text: label, attr: { class: "mod-cta", style: "padding:5px 14px;border-radius:4px;cursor:pointer;font-size:18px;" } });
			b.addEventListener("click", cb);
		};
		const plain = (label: string, cb: () => void) => {
			const b = btnRow.createEl("button", { text: label, attr: { style: "padding:5px 12px;border-radius:4px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
			b.addEventListener("click", cb);
		};
		cta("保存到笔记库", () => { void this.noteGenSaveSingle(); });
		plain("重新生成", () => {
			if (this.noteGenTargetKey) void this.noteGenGenerateOne(this.noteGenTargetKey);
			else if (this.noteGenSourceText) void this.noteGenStartDirect(this.noteGenTargetName, this.noteGenSourceText, this.noteGenTargetPath);
		});
		plain("取消返回", () => { this.noteGenResultText = ""; this.noteGenMode = "picker"; void this.renderNoteGenView(); });
	}

	noteGenFindItem(key: string): { name: string; sourcePath: string; file?: TFile; wrongNote?: WrongAnswerNote } | null {
		if (this.noteGenSourceType === "wrong") {
			const n = this.noteGenWrongNotes.find(n => n.filePath === key);
			if (n) return { name: (n.sourceFile || n.baseName).replace(/\[\[|\]\]/g, ""), sourcePath: n.sourcePath || n.filePath, wrongNote: n };
			return null;
		}
		const f = this.noteGenFiles.find(f => f.path === key);
		if (f) return { name: f.basename, sourcePath: f.path, file: f };
		return null;
	}

	async noteGenItemContent(item: { name: string; sourcePath: string; file?: TFile; wrongNote?: WrongAnswerNote }): Promise<string> {
		if (item.wrongNote) return item.wrongNote.resultText;
		if (item.file) return await this.noteSourceToText(item.file);
		return "";
	}

	async noteSourceToText(file: TFile): Promise<string> {
		if (isImageFile(file.name)) {
			const b64 = await this.readFileAsBase64(file);
			new Notice("图片识别：请确认当前模型支持多模态（视觉）能力");
			return await this.callAIWithPrompt("请识别并转录图片中的全部文字内容，保持原有结构与顺序，直接输出转录结果，不要任何多余说明。", [b64]);
		}
		if (file.extension === "md") {
			const text = isAbs(file.path) ? readFileStr(file.path) : await this.app.vault.read(file);
			return text.replace(/^---[\s\S]*?---\s*/, "");
		}
		return await this.examSourceToText(file);
	}

	async noteGenStartDirect(name: string, content: string, sourcePath: string) {
		if (this.noteGenIsGenerating) return;
		if (!content || content.trim().length === 0) { new Notice("内容为空，无法生成笔记"); return; }
		this.activeSection = "home";
		this.homeView = "noteGen";
		this.noteGenMode = "preview";
		this.noteGenTargetName = name;
		this.noteGenTargetPath = sourcePath;
		this.noteGenTargetKey = "";
		this.noteGenSourceText = content;
		this.noteGenResultText = "";
		this.noteGenResultTags = [];
		this.resetAI();
		this.noteGenIsGenerating = true;
		void this.render();
		try {
			const full = await this.callAIWithPrompt(buildNotePrompt(content, name));
			const { tags, body } = parseNoteResult(full || "");
			if (body) {
				this.noteGenResultText = body;
				this.noteGenResultTags = tags;
			} else {
				new Notice("笔记生成失败：AI返回内容为空");
			}
		} catch (err) {
			if ((err as Error).name === "AbortError") new Notice("已中止");
			else new Notice("笔记生成失败：" + (err as Error).message);
		} finally {
			this.noteGenIsGenerating = false;
			if (!this.noteGenResultText) this.noteGenMode = "picker";
			void this.renderHomeTab();
		}
	}

	async noteGenGenerateOne(key: string) {
		if (this.noteGenIsGenerating) return;
		const item = this.noteGenFindItem(key);
		if (!item) { new Notice("找不到所选内容"); return; }
		const content = await this.noteGenItemContent(item);
		await this.noteGenStartDirect(item.name, content, item.sourcePath);
		this.noteGenTargetKey = key;
	}

	async noteGenGenerateBatch() {
		const keys = [...this.noteGenSelected];
		if (keys.length === 0 || this.noteGenIsGenerating) return;
		this.noteGenIsGenerating = true;
		this.resetAI();
		void this.renderNoteGenView();
		let ok = 0;
		let fail = 0;
		try {
			for (let i = 0; i < keys.length; i++) {
				if (this.aiCancelled) break;
				const key = keys[i]!;
				try {
					const item = this.noteGenFindItem(key);
					if (!item) { fail++; continue; }
					const content = await this.noteGenItemContent(item);
					if (!content || content.trim().length === 0) { fail++; new Notice("内容为空，已跳过：" + item.name); continue; }
					const full = await this.callAIWithPrompt(buildNotePrompt(content, item.name));
					const { tags, body } = parseNoteResult(full || "");
					if (!body) { fail++; new Notice("生成失败：" + item.name); continue; }
					const saved = await this.noteGenWriteNote(body, tags, item.name, item.sourcePath);
					if (saved) ok++; else fail++;
				} catch (err) {
					if ((err as Error).name === "AbortError") {
						if (this.aiCancelled) break;
						fail++;
						continue;
					}
					console.error("[question-generator] 批量生成笔记失败:", err);
					fail++;
				}
				new Notice("笔记生成中：" + (i + 1) + "/" + keys.length + "（成功 " + ok + "，失败 " + fail + "）");
			}
			new Notice(this.aiCancelled ? "已中止：成功 " + ok + "，失败 " + fail : "笔记生成完成：成功 " + ok + "，失败 " + fail);
		} finally {
			this.noteGenIsGenerating = false;
			if (!this.aiCancelled) this.noteGenSelected.clear();
			void this.renderNoteGenView();
		}
	}

	async noteGenSaveSingle() {
		const body = this.noteGenResultText;
		if (!body || body.trim().length === 0) { new Notice("内容为空，无法保存"); return; }
		const ok = await this.noteGenWriteNote(body, this.noteGenResultTags, this.noteGenTargetName, this.noteGenTargetPath);
		if (ok) {
			new Notice("笔记已保存");
			this.noteGenResultText = "";
			this.noteGenResultTags = [];
			this.noteGenTargetKey = "";
			this.noteGenSourceText = "";
			this.noteGenMode = "picker";
			this.noteGenSelected.clear();
			void this.renderNoteGenView();
		}
	}

	async noteGenWriteNote(body: string, tags: string[], sourceName: string, sourcePath: string): Promise<boolean> {
		const folder = this.plugin.rootPath(this.plugin.settings.noteViewFolder);
		if (!folder) { new Notice("请先在设置中配置笔记文件夹"); return false; }
		try {
			await ensureFolder(this.app, folder);
			const dateStr = new Date().toISOString().slice(0, 10);
			const fm = buildNoteFrontmatter(sourceName, sourcePath, tags);
			const knowledgeLinks = buildKnowledgeLinks(tags);
			const content = fm + body + knowledgeLinks;
			const baseName = safeName(sourceName || "AI笔记");
			const fileName = baseName + "_笔记_" + dateStr + ".md";
			if (isAbs(folder)) {
				const filePath = joinPath(folder, fileName);
				try { writeFileStr(filePath, content); }
				catch { writeFileStr(joinPath(folder, baseName + "_笔记_" + Date.now() + ".md"), content); }
			} else {
				const filePath = folder + "/" + fileName;
				try { await this.app.vault.create(filePath, content); }
				catch { await this.app.vault.create(folder + "/" + baseName + "_笔记_" + Date.now() + ".md", content); }
			}
			this.plugin.emitDataChanged();
			this.syncToKnowledgeIndex(tags, fileName.replace(/\.md$/, ""), joinPath(folder, fileName), "笔记");
			return true;
		} catch (err) { new Notice("保存失败：" + (err as Error).message); console.error("[question-generator] 保存笔记失败:", err); return false; }
	}

	// ===================== KNOWLEDGE MANAGER =====================
	private knowledgeFolders(): { path: string; label: string }[] {
		return [
			{ path: this.plugin.rootPath(this.plugin.settings.knowledgeFolder), label: "知识点索引" },
		].filter(f => !!f.path);
	}

	private async readIndexFileContent(absOrVaultPath: string): Promise<string> {
		if (isAbs(absOrVaultPath)) {
			try { return readFileStr(absOrVaultPath); } catch { return ""; }
		}
		const f = this.app.vault.getAbstractFileByPath(absOrVaultPath);
		if (f instanceof TFile) {
			try { return await this.app.vault.read(f); } catch { return ""; }
		}
		return "";
	}

	private extractIndexLinks(content: string): string[] {
		const links: string[] = [];
		const re = /\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(content)) !== null) links.push(m[1]!.trim());
		return links;
	}

	private async listKnowledgeManagerTags(): Promise<{ tag: string; indexFiles: { file: string; sourceLabel: string }[] }[]> {
		const map: Record<string, { file: string; sourceLabel: string }[]> = {};
		for (const { path: folder } of this.knowledgeFolders()) {
			if (!folder) continue;
			if (isAbs(folder)) {
				if (!fs.existsSync(folder)) continue;
				for (const f of listMdFiles(folder)) {
					const tag = f.replace(/\.md$/, "");
					const content = await this.readIndexFileContent(joinPath(folder, f));
					const secs = this.indexFileSections(content);
					for (const label of secs) (map[tag] || (map[tag] = [])).push({ file: joinPath(folder, f), sourceLabel: label });
				}
			} else {
				const folderObj = this.app.vault.getAbstractFileByPath(folder);
				if (!(folderObj instanceof TFolder)) continue;
				for (const child of folderObj.children) {
					if (child instanceof TFile && child.extension === "md") {
						const content = await this.readIndexFileContent(child.path);
						const secs = this.indexFileSections(content);
						for (const label of secs) (map[child.basename] || (map[child.basename] = [])).push({ file: child.path, sourceLabel: label });
					}
				}
			}
		}
		return Object.entries(map)
			.map(([tag, indexFiles]) => ({ tag, indexFiles: indexFiles.sort((a, b) => a.sourceLabel.localeCompare(b.sourceLabel, "zh-Hans-CN")) }))
			.sort((a, b) => a.tag.localeCompare(b.tag, "zh-Hans-CN"));
	}

	private indexFileSections(content: string): string[] {
		const labels: string[] = [];
		let current: string | null = null;
		for (const line of content.split("\n")) {
			const h = line.trim();
			if (h === "## 相关题目") { current = "题目索引"; continue; }
			if (h === "## 相关笔记") { current = "笔记索引"; continue; }
			if (h === "## 相关错题") { current = "错题索引"; continue; }
			if (current && line.match(/\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/)) {
				if (!labels.includes(current)) labels.push(current);
			}
		}
		return labels;
	}

	private knowledgeManagerTagFiles(tag: string): { folder: string }[] {
		const hits: { folder: string }[] = [];
		for (const { path: folder } of this.knowledgeFolders()) {
			if (!folder) continue;
			if (isAbs(folder)) {
				if (!fs.existsSync(folder)) continue;
				for (const f of listMdFiles(folder)) {
					if (f.replace(/\.md$/, "") === tag) hits.push({ folder: joinPath(folder, f) });
				}
			} else {
				const folderObj = this.app.vault.getAbstractFileByPath(folder);
				if (!(folderObj instanceof TFolder)) continue;
				for (const child of folderObj.children) {
					if (child instanceof TFile && child.extension === "md" && child.basename === tag) hits.push({ folder: child.path });
				}
			}
		}
		return hits;
	}

	private async deleteKnowledgeIndexFile(filePath: string): Promise<void> {
		if (isAbs(filePath)) {
			deleteFileAbs(filePath);
		} else {
			const f = this.app.vault.getAbstractFileByPath(filePath);
			if (f instanceof TFile) await this.app.fileManager.trashFile(f);
		}
	}

	async renderKnowledgeManager() {
		if (!this.innerContentEl) return;
		if (this.homeView !== "knowledgeManager") return;
		const el = this.innerContentEl;
		el.empty();

		const backBtn = el.createEl("button", { text: "← 返回", attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:19px;margin-bottom:12px;" } });
		backBtn.addEventListener("click", () => { this.homeView = "default"; void this.renderHomeTab(); });

		el.createDiv({ text: "知识点管理", attr: { style: "font-size:21px;font-weight:bold;margin-bottom:4px;" } });
		el.createDiv({ text: "可多选/全选，删除会同时删除知识点索引文件", attr: { style: "color:var(--text-muted);font-size:15px;margin-bottom:14px;" } });

		const list = await this.listKnowledgeManagerTags();
		const selectedSet = new Set<string>();

		const toolbar = el.createDiv({ attr: { style: "display:flex;gap:6px;margin-bottom:12px;" } });
		const searchInput = toolbar.createEl("input", { attr: { type: "text", placeholder: "搜索知识点...", style: "flex:1;padding:6px 8px;border-radius:4px;border:1px solid var(--background-modifier-border);" } });
		const refreshBtn = toolbar.createEl("button", { text: "刷新", attr: { style: "padding:6px 14px;border-radius:4px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
		refreshBtn.addEventListener("click", () => { this.plugin.invalidateCache(); void this.renderKnowledgeManager(); });

		const bulkBar = el.createDiv({ attr: { style: "display:flex;align-items:center;gap:10px;margin-bottom:10px;" } });
		const selectAllCb = bulkBar.createEl("input", { attr: { type: "checkbox", title: "全选" } });
		bulkBar.createSpan({ text: "全选", attr: { style: "color:var(--text-muted);font-size:16px;cursor:pointer;user-select:none;" } }).addEventListener("click", () => { selectAllCb.checked = !selectAllCb.checked; selectAllCb.checked ? selectAll() : clearSel(); });
		const bulkCount = bulkBar.createDiv({ text: "已选 0 个", attr: { style: "flex:1;color:var(--text-muted);font-size:16px;" } });
		const bulkDelBtn = bulkBar.createEl("button", { text: "删除选中", attr: { style: "padding:6px 16px;border-radius:6px;cursor:pointer;font-size:16px;border:1px solid var(--color-red);color:var(--color-red);background:transparent;opacity:0.5;pointer-events:none;" } });

		const summaryEl = el.createDiv({ text: "共 " + list.length + " 个知识点", attr: { style: "color:var(--text-muted);font-size:16px;margin-bottom:8px;" } });

		const wrap = el.createDiv({ attr: { style: "display:flex;flex-direction:column;gap:8px;padding-bottom:20px;" } });

		let currentFiltered: { tag: string; indexFiles: { file: string; sourceLabel: string }[] }[] = [];

		const updateBulk = () => {
			const n = selectedSet.size;
			bulkCount.setText("已选 " + n + " 个");
			bulkDelBtn.style.opacity = n === 0 ? "0.5" : "1";
			bulkDelBtn.style.pointerEvents = n === 0 ? "none" : "auto";
			if (currentFiltered.length > 0) {
				const allSel = currentFiltered.every(i => selectedSet.has(i.tag));
				selectAllCb.checked = allSel;
				selectAllCb.indeterminate = !allSel && currentFiltered.some(i => selectedSet.has(i.tag));
			} else {
				selectAllCb.checked = false;
				selectAllCb.indeterminate = false;
			}
		};

		const selectAll = () => { currentFiltered.forEach(i => selectedSet.add(i.tag)); rerenderCheckboxes(); updateBulk(); };
		const clearSel = () => { selectedSet.clear(); rerenderCheckboxes(); updateBulk(); };
		const rerenderCheckboxes = () => {
			wrap.querySelectorAll("input[type=checkbox].km-row-cb").forEach(cb => {
				const tag = (cb as HTMLInputElement).dataset.tag || "";
				(cb as HTMLInputElement).checked = selectedSet.has(tag);
			});
		};
		selectAllCb.addEventListener("change", () => {
			selectAllCb.checked ? selectAll() : clearSel();
		});

		bulkDelBtn.addEventListener("click", () => {
			void (async () => {
				if (selectedSet.size === 0) return;
				const targets = list.filter(i => selectedSet.has(i.tag));
				const allPaths = targets.flatMap(i => i.indexFiles.map(s => s.file));
				const names = targets.map(i => i.tag);
				const confirmed = await confirmKnowledgeDelete(this.app, names.join("、"), allPaths, true);
				if (!confirmed) return;
				let ok = 0;
				for (const tag of names) {
					const files = this.knowledgeManagerTagFiles(tag);
					for (const f of files) {
						await this.deleteKnowledgeIndexFile(f.folder);
						ok++;
					}
				}
				new Notice("已删除 " + ok + " 处知识点索引文件");
				this.plugin.invalidateCache();
				await this.renderKnowledgeManager();
			})();
		});

		const renderFiltered = (query: string) => {
			wrap.empty();
			const q = query.trim().toLowerCase();
			const filtered = q ? list.filter(i => i.tag.toLowerCase().includes(q) || i.indexFiles.some(s => s.sourceLabel.toLowerCase().includes(q))) : list;
			currentFiltered = filtered;
			summaryEl.setText("共 " + list.length + " 个知识点" + (q ? "，筛选出 " + filtered.length + " 个" : ""));
			if (filtered.length === 0) {
				wrap.createDiv({ text: q ? "未找到匹配的知识点" : "暂无知识点索引文件", attr: { style: "color:var(--text-muted);padding:20px 0;text-align:center;" } });
				updateBulk();
				return;
			}
			for (const item of filtered) {
				const row = wrap.createDiv({ attr: { style: "border-radius:12px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);overflow:hidden;" } });
				const head = row.createDiv({ attr: { style: "display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;" } });
				const checkbox = head.createEl("input", { cls: "km-row-cb", attr: { type: "checkbox" } });
				checkbox.dataset.tag = item.tag;
				checkbox.checked = selectedSet.has(item.tag);
				checkbox.addEventListener("click", (e) => e.stopPropagation());
				checkbox.addEventListener("change", () => {
					checkbox.checked ? selectedSet.add(item.tag) : selectedSet.delete(item.tag);
					updateBulk();
				});
				const arrow = head.createSpan({ text: "▸", attr: { style: "font-size:16px;min-width:14px;color:var(--text-muted);flex-shrink:0;" } });
				const info = head.createDiv({ attr: { style: "flex:1;min-width:0;" } });
				info.createDiv({ text: item.tag, attr: { style: "font-size:17px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" } });
				const typeInfo = head.createDiv({ attr: { style: "color:var(--text-muted);font-size:15px;flex-shrink:0;margin-right:6px;" } });
				const qCount = item.indexFiles.filter(s => s.sourceLabel === "题目索引").length;
				const nCount = item.indexFiles.filter(s => s.sourceLabel === "笔记索引").length;
				const wCount = item.indexFiles.filter(s => s.sourceLabel === "错题索引").length;
				const parts: string[] = [];
				if (qCount > 0) parts.push("题" + qCount);
				if (nCount > 0) parts.push("记" + nCount);
				if (wCount > 0) parts.push("错" + wCount);
				typeInfo.setText(parts.join(" ") || "0 处索引");
				head.addEventListener("click", (e) => {
					if ((e.target as HTMLElement).tagName === "BUTTON") return;
					if ((e.target as HTMLElement).tagName === "INPUT") return;
					detail.style.display = detail.style.display === "none" ? "block" : "none";
					arrow.setText(detail.style.display === "none" ? "▸" : "▾");
				});
				const detail = row.createDiv({ attr: { style: "display:none;border-top:1px solid var(--background-modifier-border);padding:10px 12px;font-size:15px;" } });
				detail.createDiv({ text: "索引文件：", attr: { style: "font-weight:600;color:var(--text-muted);margin-bottom:6px;" } });
				for (const s of item.indexFiles) {
					const line = detail.createDiv({ attr: { style: "display:flex;gap:6px;align-items:flex-start;margin-bottom:6px;" } });
					line.createSpan({ text: s.sourceLabel + "：", attr: { style: "flex-shrink:0;color:var(--interactive-accent);" } });
					line.createDiv({ text: s.file, attr: { style: "flex:1;word-break:break-all;color:var(--text-muted);" } });
				}
				detail.createDiv({ text: "……（点击下方查看索引条目）", attr: { style: "color:var(--text-muted);font-size:14px;margin:4px 0;" } });
				const peekBtn = detail.createEl("button", { text: "🡕 查看索引条目", attr: { style: "padding:5px 12px;border-radius:6px;cursor:pointer;font-size:15px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);margin-top:4px;" } });
				peekBtn.addEventListener("click", () => {
					void (async () => {
						peekBtn.setText("加载中...");
						peekBtn.disabled = true;
						const linkSet = new Set<string>();
						for (const s of item.indexFiles) {
							const content = await this.readIndexFileContent(s.file);
							for (const l of this.extractIndexLinks(content)) linkSet.add(l);
						}
						peekBtn.setText("🡕 查看索引条目");
						peekBtn.disabled = false;
						linksEl.empty();
						linksEl.show();
						const links = [...linkSet];
						if (links.length === 0) {
							linksEl.createDiv({ text: "该知识点暂无关联条目", attr: { style: "color:var(--text-muted);" } });
						} else {
							linksEl.createDiv({ text: "关联条目（" + links.length + "）：", attr: { style: "font-weight:600;color:var(--text-muted);margin-bottom:6px;" } });
							for (const l of links) {
								const linkRow = linksEl.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;padding:2px 0;line-height:1.5;cursor:pointer;" } });
								linkRow.createSpan({ text: l, attr: { style: "flex:1;word-break:break-all;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" } });
								linkRow.classList.add("qg-hover-bg");
								linkRow.setAttribute("title", "打开：" + l);
								linkRow.addEventListener("click", () => this.openLinkedFile(l));
							}
						}
					})();
				});
				const linksEl = detail.createDiv({ attr: { style: "display:none;margin-top:8px;border-top:1px solid var(--background-modifier-border);padding-top:8px;" } });
			}
			updateBulk();
		};
		renderFiltered("");
		searchInput.addEventListener("input", () => renderFiltered(searchInput.value));
	}


	// ===================== GENERATE (inline) =====================
	startGenerate(sourceText: string, name: string, sourcePath: string = "") {
		this.genSourceText = sourceText;
		this.genFileName = name.replace(".md", "");
		this.genSourcePath = sourcePath;
		this.genResultText = "";
		this.genCurrentTags = [];
		if (this.activeSection !== "home") this.activeSection = "home";
		this.homeView = "generate";
		void this.renderHomeTab();
	}

	renderGenerateView() {
		if (!this.innerContentEl) return;
		const el = this.innerContentEl;
		el.empty();

		const backBtn = el.createEl("button", { text: "← 返回", attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:19px;margin-bottom:12px;" } });
		backBtn.addEventListener("click", () => { this.cancelAI(); this.genIsGenerating = false; this.homeView = "default"; void this.renderHomeTab(); });

		if (this.genResultText) {
			this.genRenderResult();
			return;
		}

		el.createDiv({ text: "题目设置", attr: { style: "font-size:21px;font-weight:bold;margin-bottom:10px;" } });

		const cleanedText = cleanSourceText(this.genSourceText);
		const tokenEst = estimateTokens(cleanedText);
		const charCount = cleanedText.length;

		const infoEl = el.createDiv({ attr: { style: "padding:10px 14px;margin-bottom:14px;border-radius:8px;background:var(--background-secondary);font-size:18px;line-height:1.8;" } });
		infoEl.createDiv({ text: "当前文档：" + this.genFileName, attr: { style: "font-weight:600;" } });
		infoEl.createDiv({ text: "清洗后字符数：" + charCount.toLocaleString() + "　预估Token：" + tokenEst.toLocaleString(), attr: { style: "color:var(--text-muted);" } });
		if (tokenEst > TOKEN_WARN_THRESHOLD) infoEl.createDiv({ text: "⚠️ 内容较长，建议分段生成题目", attr: { style: "color:var(--color-orange);margin-top:4px;" } });

		const cfg = this.plugin.settings;
		const savedEnabled = cfg.lastEnabledTypes.split(",").filter(Boolean);
		const types: { label: string; key: keyof PluginSettings; count: number; enabled: boolean }[] = [
			{ label: "单选题", key: "countSingle", count: cfg.countSingle, enabled: savedEnabled.length === 0 || savedEnabled.includes("single") },
			{ label: "多选题", key: "countMulti", count: cfg.countMulti, enabled: savedEnabled.length === 0 || savedEnabled.includes("multi") },
			{ label: "判断题", key: "countJudge", count: cfg.countJudge, enabled: savedEnabled.length === 0 || savedEnabled.includes("judge") },
			{ label: "填空题", key: "countBlank", count: cfg.countBlank, enabled: savedEnabled.length === 0 || savedEnabled.includes("blank") },
			{ label: "简答题", key: "countEssay", count: cfg.countEssay, enabled: savedEnabled.length === 0 || savedEnabled.includes("essay") },
		];
		const activeTypes = types.filter(t => t.count > 0);

		if (activeTypes.length === 1) {
			const only = activeTypes[0]!;
			el.createDiv({ text: "题型：" + only.label + " " + only.count + " 题", attr: { style: "font-size:18px;margin-bottom:14px;padding:8px 12px;border-radius:6px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);" } });
		} else {
			const toggleArea = el.createDiv({ attr: { style: "display:flex;flex-direction:column;gap:6px;margin-bottom:14px;" } });
			for (const t of types) {
				const row = toggleArea.createDiv({ attr: { style: "display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:6px;border:1px solid var(--background-modifier-border);" } });
				const cb = row.createEl("input", { attr: { type: "checkbox" } });
				cb.checked = t.enabled;
				row.createSpan({ text: t.label, attr: { style: "min-width:60px;font-size:18px;" } });
				const countInput = row.createEl("input", { attr: { type: "number", min: "0", max: "50", value: String(t.count), style: "width:50px;padding:4px 6px;border-radius:4px;border:1px solid var(--background-modifier-border);text-align:center;font-size:18px;" } });
				countInput.addEventListener("change", () => { t.count = parseInt(countInput.value) || 0; (cfg[t.key] as number) = t.count; });
				row.createSpan({ text: "题", attr: { style: "font-size:17px;color:var(--text-muted);" } });
				cb.addEventListener("change", () => { t.enabled = cb.checked; });
			}
		}

		el.createDiv({ text: "知识点标签（逗号分隔）：", attr: { style: "margin-bottom:4px;font-size:18px;" } });
		const tagsInput = el.createEl("input", { attr: { type: "text", placeholder: "例如：微积分, 导数", value: cfg.lastTags, style: "width:100%;padding:6px;margin-bottom:14px;border-radius:4px;border:1px solid var(--background-modifier-border);font-size:18px;" } });

		const autoSaveRow = el.createDiv({ attr: { style: "display:flex;align-items:center;gap:8px;margin-bottom:14px;" } });
		const autoSaveCb = autoSaveRow.createEl("input", { attr: { type: "checkbox" } });
		autoSaveCb.checked = cfg.autoSave;
		autoSaveCb.addEventListener("change", () => { cfg.autoSave = autoSaveCb.checked; });
		autoSaveRow.createSpan({ text: "生成后自动保存到题库", attr: { style: "font-size:18px;" } });

		const startBtn = el.createDiv({ attr: { style: "text-align:center;" } });
		const sb = startBtn.createEl("button", { text: "开始生成", attr: { class: "mod-cta", style: "padding:8px 24px;border-radius:4px;cursor:pointer;font-size:20px;" } });
		sb.addEventListener("click", () => {
			const enabledTypes = types.filter(t => t.enabled && t.count > 0);
			if (enabledTypes.length === 0) { new Notice("请至少选择一种题型且数量大于0"); return; }
			this.genCurrentTags = tagsInput.value.split(",").map(s => s.trim()).filter(Boolean);
			cfg.lastTags = tagsInput.value;
			cfg.lastEnabledTypes = types.filter(t => t.enabled).map(t => t.key.replace("count", "").toLowerCase()).join(",");
			void this.plugin.saveSettings();
			const counts: string[] = [];
			for (const t of enabledTypes) { if (t.count > 0) counts.push(t.label + t.count); }
			this.genStartGenerate(counts.join("、"));
		});
	}

	genStartGenerate(typeStr: string) {
		const el = this.innerContentEl;
		if (!el) return;
		el.empty();

		const backBtn = el.createEl("button", { text: "← 返回设置", attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:19px;margin-bottom:12px;" } });
		backBtn.addEventListener("click", () => { this.cancelAI(); this.genIsGenerating = false; this.genResultText = ""; this.renderGenerateView(); });

		const progressEl = el.createDiv({ attr: { style: "text-align:center;padding:14px;margin-bottom:10px;border-radius:8px;background:var(--background-secondary);" } });
		const spinner = progressEl.createDiv({ text: "⏳ 正在生成试题...", attr: { style: "font-size:20px;font-weight:600;line-height:1.6;" } });
		const subText = progressEl.createDiv({ text: "预计需要 10-60 秒", attr: { style: "font-size:17px;color:var(--text-muted);margin-top:4px;" } });

		const textArea = el.createEl("textarea", { attr: { style: "width:100%;height:300px;font-family:monospace;font-size:18px;line-height:1.5;" } });
		const update = (txt: string) => { this.genResultText = txt; textArea.value = txt; textArea.scrollTop = textArea.scrollHeight; };

		const btnRow = el.createDiv({ attr: { style: "margin-top:8px;display:flex;gap:6px;" } });
		const cancelBtn = btnRow.createEl("button", { text: "⏹ 中止", attr: { style: "padding:5px 12px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--color-red);background:var(--background-secondary);color:var(--color-red);" } });
		cancelBtn.addEventListener("click", () => { this.cancelAI(); this.genIsGenerating = false; spinner.setText("已中止"); subText.setText("已获取的内容已保留"); });

		void this.genRunGenerate(update, typeStr, spinner, subText);
	}

	async genRunGenerate(onChunk: (s: string) => void, typeStr: string, spinner: HTMLElement, subText: HTMLElement) {
		if (this.genIsGenerating) { new Notice("正在生成中，请等待完成"); return; }
		const cfg = this.plugin.settings;
		const existingTags = await this.plugin.loadExistingKnowledgeTags();
		const prompt = buildGeneratePrompt(this.genSourceText, typeStr, existingTags);
		let full = "";
		this.resetAI();
		this.genIsGenerating = true;

		try {
			full = await this.callAIWithPrompt(prompt, undefined, { system: "你是一个出题助手，严格按照指定格式输出题目。" });

			if (!full) { onChunk("接口返回内容为空，请检查模型名称和接口地址配置是否正确。"); return; }

			const { tags: aiTags, cleanText } = parseAITagsFromResult(full);
			full = fixSequentialNumbers(cleanText);
			onChunk(full);

			const questions = parseQuestions(full);
			const gradableCount = questions.filter(q => q.type !== "essay" && q.type !== "blank").length;
			spinner.setText("✅ 生成完成");
			const tagInfo = aiTags.length > 0 ? " | 知识点：" + aiTags.join(", ") : "";
			subText.setText("共解析出 " + questions.length + " 题（客观题 " + gradableCount + " 题）" + tagInfo + (questions.length === 0 ? " ⚠️ 请检查AI输出格式" : ""));

			const entry: HistoryEntry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), timestamp: Date.now(), fileName: this.genFileName, sourceSnippet: this.genSourceText.slice(0, MAX_HISTORY_SNIPPET), resultText: full, sourcePath: this.genSourcePath };
			await this.plugin.addHistory(entry);
			if (cfg.autoSave && full) await this.genSaveToVault();
		} catch (err) {
			if ((err as Error).name === "AbortError") {
				spinner.setText("⚠️ 已中止");
				subText.setText(this.aiCancelled ? "本次生成已停止，未保存任何内容" : "请求超时（3分钟）");
				return;
			}
			spinner.setText("❌ 生成失败");
			onChunk("接口调用失败：" + (err as Error).message + "\n\n请检查：\n1. 接口地址\n2. API服务是否运行\n3. 模型名称");
		} finally {
			this.genIsGenerating = false;
		}
	}

	genRenderResult() {
		if (!this.innerContentEl) return;
		const el = this.innerContentEl;
		el.empty();

		const backBtn = el.createEl("button", { text: "← 返回设置", attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:19px;margin-bottom:10px;" } });
		backBtn.addEventListener("click", () => { this.genResultText = ""; this.renderGenerateView(); });

		el.createDiv({ text: "生成结果", attr: { style: "font-size:20px;font-weight:bold;margin-bottom:8px;" } });
		const textArea = el.createEl("textarea", { attr: { style: "width:100%;height:300px;font-family:monospace;font-size:18px;line-height:1.5;" } });
		textArea.value = this.genResultText;
		textArea.addEventListener("input", () => { this.genResultText = textArea.value; });

		const btnRow = el.createDiv({ attr: { style: "margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;" } });
		const actBtn = (label: string, cb: () => void) => {
			const b = btnRow.createEl("button", { text: label, attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
			b.addEventListener("click", cb);
		};
		actBtn("导出MD", () => { void this.genExportMd(); });
		actBtn("导出Word", () => { void this.genExportWord(); });
		actBtn("导出PDF", () => { void this.genExportPdf(); });
		actBtn("无答案版", () => { void this.genExportNoAnswer(); });

		const btnRow2 = el.createDiv({ attr: { style: "margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;" } });
		const ctaBtn = (label: string, cb: () => void) => {
			const b = btnRow2.createEl("button", { text: label, attr: { class: "mod-cta", style: "padding:5px 14px;border-radius:4px;cursor:pointer;font-size:18px;" } });
			b.addEventListener("click", cb);
		};
		ctaBtn("保存到知识库", () => { void (async () => { await this.genSaveToVault(); })(); });
		actBtn("开始答题", () => { if (!this.genResultText) { new Notice("请先生成试题"); return; } this.startAnswer(this.genResultText, this.genFileName, this.genSourcePath); });
	}

	async genSaveToVault() {
		if (!this.genResultText) { new Notice("还没有生成试题内容"); return; }
		this.resetAI();
		try {
			await ensureFolder(this.app, this.plugin.rootPath(this.plugin.settings.questionFolder));
			const dateStr = new Date().toISOString().slice(0, 10);
			const autoTags = await this.aiSuggestTags(this.genResultText);
			const allTags = ["题目", ...this.genCurrentTags, ...autoTags.filter(t => !this.genCurrentTags.includes(t))];
			const sourceLink = this.genFileName ? "[[" + this.genFileName + "]]" : "";
			const qIvls = parseReviewIntervals(this.plugin.settings.questionReviewIntervals, DEFAULT_QUESTION_INTERVALS);
			const nextReviewDate = new Date(); nextReviewDate.setDate(nextReviewDate.getDate() + qIvls[0]!);
			const fm = buildFM({ source: sourceLink, sourcePath: this.genSourcePath, date: dateStr, tags: allTags, nextReview: nextReviewDate.toISOString().slice(0, 10), interval: qIvls[0]!, correctCount: 0, wrongCount: 0 });
			const kTags = knowledgeTags(allTags);
			const knowledgeLinks = kTags.length > 0 ? "\n\n---\n\n**知识点：** " + kTags.map(t => "[[" + t + "]]").join(" ") + "\n" : "";
			const content = fm + normalizeExamContent(this.genResultText) + knowledgeLinks;
			const fileName = safeName(this.genFileName) + "_试题_" + dateStr + ".md";
			if (isAbs(this.plugin.rootPath(this.plugin.settings.questionFolder))) {
				const filePath = joinPath(this.plugin.rootPath(this.plugin.settings.questionFolder), fileName);
				try { writeFileStr(filePath, content); }
				catch { writeFileStr(joinPath(this.plugin.rootPath(this.plugin.settings.questionFolder), safeName(this.genFileName) + "_试题_" + Date.now() + ".md"), content); }
			} else {
				const filePath = this.plugin.rootPath(this.plugin.settings.questionFolder) + "/" + fileName;
				try { await this.app.vault.create(filePath, content); }
				catch { await this.app.vault.create(this.plugin.rootPath(this.plugin.settings.questionFolder) + "/" + safeName(this.genFileName) + "_试题_" + Date.now() + ".md", content); }
			}
			new Notice("已保存到 " + this.plugin.rootPath(this.plugin.settings.questionFolder));
			this.plugin.emitDataChanged();
			this.syncToKnowledgeIndex(allTags, fileName.replace(/\.md$/, ""), joinPath(this.plugin.rootPath(this.plugin.settings.questionFolder), fileName), "题目");
		} catch (err) { new Notice("保存失败：" + (err as Error).message); }
	}

	async genExportMd() {
		try {
			if (!this.genResultText) { new Notice("还没有生成试题内容"); return; }
			
			const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: this.genFileName + "_试题.md", filters: [{ name: "Markdown", extensions: ["md"] }] });
			if (r.canceled || !r.filePath) return;
			const dateStr = new Date().toISOString().slice(0, 10);
			fs.writeFileSync(r.filePath, "# " + this.genFileName + " 配套试题\n\n> 来源：" + this.genFileName + "　|　日期：" + dateStr + "\n\n" + stripAnswerSummarySection(this.genResultText), "utf-8");
			new Notice("Md已保存");
		} catch (err) { new Notice("导出失败：" + (err as Error).message); }
	}

	async genExportWord() {
		try {
			if (!this.genResultText) { new Notice("还没有生成试题内容"); return; }
			
			const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: this.genFileName + "_试题.docx", filters: [{ name: "Word", extensions: ["docx"] }] });
			if (r.canceled || !r.filePath) return;
			const dateStr = new Date().toISOString().slice(0, 10);
			const children = buildWordParagraphs(this.genResultText, this.genFileName + " 配套试题", this.genFileName + " " + dateStr);
			const doc = new Document({ sections: [{ properties: {}, children }] });
			const buffer = await Packer.toBuffer(doc);
			fs.writeFileSync(r.filePath, Buffer.from(buffer));
			new Notice("Word已保存");
		} catch (err) { new Notice("导出失败：" + (err as Error).message); }
	}

	async genExportPdf() {
		try {
			if (!this.genResultText) { new Notice("还没有生成试题内容"); return; }
			
			const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: this.genFileName + "_试题.pdf", filters: [{ name: "PDF", extensions: ["pdf"] }] });
			if (r.canceled || !r.filePath) return;
			await exportPdfDirect(r.filePath, this.genResultText, this.genFileName + " 配套试题", this.genFileName);
			new Notice("PDF已保存");
		} catch (err) { new Notice("导出失败：" + (err as Error).message); }
	}

	async genExportNoAnswer() {
		try {
			if (!this.genResultText) { new Notice("还没有生成试题内容"); return; }
			const noAnswerText = stripAnswersForExport(this.genResultText);
			
			const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: this.genFileName + "_试题_无答案.md", filters: [{ name: "Markdown", extensions: ["md"] }] });
			if (r.canceled || !r.filePath) return;
			const dateStr = new Date().toISOString().slice(0, 10);
			fs.writeFileSync(r.filePath, "# " + this.genFileName + " 配套试题（无答案版）\n\n> 来源：" + this.genFileName + "　|　日期：" + dateStr + "\n\n" + noAnswerText, "utf-8");
			new Notice("无答案版已保存");
		} catch (err) { new Notice("导出失败：" + (err as Error).message); }
	}

	async generateFromWeakPoints() {
		const wp = await this.plugin.getWeakPoints();
		if (wp.length === 0) { new Notice("暂无薄弱知识点数据"); return; }
		const notes = await this.plugin.loadAllWrongNotes();
		const sources: string[] = [];
		const paths: string[] = [];
		for (const note of notes) {
			const srcName = note.sourceFile.replace(/\[\[|\]\]/g, "");
			const src = this.app.vault.getFiles().find(f => f.basename === srcName || f.name === srcName);
			if (src) { sources.push(await this.app.vault.read(src)); paths.push(src.path); }
			else if (isAbs(this.plugin.rootPath(this.plugin.settings.questionFolder))) {
				const qDir = this.plugin.rootPath(this.plugin.settings.questionFolder);
				if (fs.existsSync(qDir)) { for (const f of fs.readdirSync(qDir)) { if (f.includes(srcName) && f.endsWith(".md")) { sources.push(readFileStr(joinPath(qDir, f))); paths.push(joinPath(qDir, f)); break; } } }
			}
		}
		if (sources.length === 0) { new Notice("没有可用的源文件"); return; }
		const weakPrompt = "【出题要求 - 请重点关注以下薄弱知识点】\n" + wp.map(w => "- " + w.tag + "（错题" + w.count + "次）").join("\n") + "\n\n对于上述薄弱知识点，每类至少出2-3题。\n\n";
		this.startGenerate(weakPrompt + sources.join("\n\n---\n\n"), "薄弱点定向生成", paths.join(","));
	}

	// ===================== ANSWER (inline) =====================
	startAnswer(resultText: string, sourceName: string, sourcePath: string = "") {
		this.answerResultText = resultText;
		this.answerSourceName = sourceName;
		this.answerSourcePath = sourcePath;
		this.answerQuestions = parseQuestions(resultText);
		this.answerAnswers = new Map();
		this.answerWrongChecked = new Set();
		this.answerCurrentTags = [];
		if (this.activeSection !== "home") this.activeSection = "home";
		this.homeView = "answer";
		void this.renderHomeTab();
	}

	renderAnswerView() {
		if (!this.innerContentEl) return;
		const el = this.innerContentEl;
		el.empty();

		const backBtn = el.createEl("button", { text: "← 返回", attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:19px;margin-bottom:10px;" } });
		backBtn.addEventListener("click", () => { this.homeView = "default"; void this.renderHomeTab(); });

		if (this.answerQuestions.length === 0) {
			el.createEl("p", { text: "未能解析出可答题的题目。", attr: { style: "color:var(--text-muted);padding:20px 0;" } });
			return;
		}

		const typeLabels: Record<QuestionType, string> = { single: "单选", multi: "多选", judge: "判断", blank: "填空", essay: "简答" };
		const counts: Record<string, number> = {};
		for (const q of this.answerQuestions) { const k = typeLabels[q.type]; counts[k] = (counts[k] || 0) + 1; }
		const summary = Object.entries(counts).map(([k, v]) => k + " " + v).join(" / ");
		el.createDiv({ text: "共 " + this.answerQuestions.length + " 题：" + summary, cls: "qg-summary" });

		for (const q of this.answerQuestions) {
			const isGradable = q.type === "single" || q.type === "multi" || q.type === "judge";
			const qEl = el.createDiv({ attr: { style: "border:1px solid var(--background-modifier-border);border-radius:8px;padding:12px 14px;margin-bottom:10px;" } });

			const headerRow = qEl.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;margin-bottom:8px;" } });
			headerRow.createSpan({ text: typeLabels[q.type], attr: { style: "font-size:16px;padding:2px 6px;border-radius:4px;background:var(--interactive-accent);color:var(--text-on-accent);font-weight:500;" } });
			headerRow.createSpan({ text: "第 " + q.number + " 题", attr: { style: "font-size:17px;color:var(--text-muted);" } });
			if (!isGradable) headerRow.createSpan({ text: "(仅参考)", attr: { style: "font-size:16px;color:var(--text-faint);" } });

			const qTextRow = qEl.createDiv({ attr: { style: "font-weight:600;line-height:1.7;font-size:19px;margin-bottom:8px;" } });
			qTextRow.createSpan({ text: q.number + ". ", attr: { style: "font-weight:700;" } });
			qTextRow.createSpan({ text: q.text });

			if (q.type === "single" || q.type === "judge") {
				const optsEl = qEl.createDiv({ cls: "qg-opts-col" });
				for (const opt of q.options) {
					const optRow = optsEl.createDiv({ cls: "qg-option-row" });
					const radio = optRow.createEl("input", { attr: { type: "radio", name: "q" + q.number, value: opt.label } });
					optRow.createSpan({ text: opt.label + ". " + opt.text, cls: "qg-option-text" });
					radio.addEventListener("change", () => { this.answerAnswers.set(q.number, opt.label); });
					optRow.addEventListener("click", () => { radio.checked = true; this.answerAnswers.set(q.number, opt.label); });
				}
			} else if (q.type === "multi") {
				const optsEl = qEl.createDiv({ cls: "qg-opts-col" });
				const selected = new Set<string>();
				for (const opt of q.options) {
					const optRow = optsEl.createDiv({ cls: "qg-option-row" });
					const cb = optRow.createEl("input", { attr: { type: "checkbox", value: opt.label } });
					optRow.createSpan({ text: opt.label + ". " + opt.text, cls: "qg-option-text" });
					const updateMulti = () => { this.answerAnswers.set(q.number, [...selected].sort().join("")); };
					cb.addEventListener("change", () => { cb.checked ? selected.add(opt.label) : selected.delete(opt.label); updateMulti(); });
					optRow.addEventListener("click", (e) => { if ((e.target as HTMLElement).tagName !== "INPUT") { cb.checked = !cb.checked; cb.checked ? selected.add(opt.label) : selected.delete(opt.label); updateMulti(); } });
				}
			} else if (q.type === "blank") {
				const input = qEl.createEl("input", { cls: "qg-input-wide", attr: { type: "text", placeholder: "填写答案..." } });
				input.addEventListener("input", () => { this.answerAnswers.set(q.number, input.value.trim()); });
			} else if (q.type === "essay") {
				const ta = qEl.createEl("textarea", { attr: { style: "width:100%;min-height:80px;padding:8px;border-radius:4px;border:1px solid var(--background-modifier-border);resize:vertical;font-size:19px;line-height:1.7;box-sizing:border-box;", placeholder: "输入你的答案..." } });
				ta.addEventListener("input", () => { this.answerAnswers.set(q.number, ta.value.trim()); });
			}
		}

		const submitBtn = el.createDiv({ attr: { style: "margin-top:10px;text-align:center;" } });
		const sb = submitBtn.createEl("button", { text: "提交答卷", attr: { class: "mod-cta", style: "padding:8px 24px;border-radius:4px;cursor:pointer;font-size:20px;" } });
		sb.addEventListener("click", () => this.answerSubmit());
	}

	answerSubmit() {
		if (!this.innerContentEl) return;
		const el = this.innerContentEl;
		el.empty();

		const backBtn = el.createEl("button", { text: "← 重新答题", attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:19px;margin-bottom:10px;" } });
		backBtn.addEventListener("click", () => { this.answerAnswers = new Map(); this.answerWrongChecked = new Set(); this.renderAnswerView(); });

		const gradable = this.answerQuestions.filter(q => q.type === "single" || q.type === "multi" || q.type === "judge");
		const nonGradable = this.answerQuestions.filter(q => q.type === "blank" || q.type === "essay");

		let correct = 0;
		const wrongList: ParsedQuestion[] = [];
		for (const q of gradable) {
			const userAnswer = this.answerAnswers.get(q.number) || "";
			let isCorrect = false;
			if (q.type === "single" || q.type === "judge") isCorrect = userAnswer.toUpperCase() === q.answer.toUpperCase();
			else if (q.type === "multi") isCorrect = userAnswer.split("").sort().join("").toUpperCase() === q.answer.toUpperCase();
			if (isCorrect) correct++;
			else wrongList.push(q);
		}

		const totalGradable = gradable.length;
		const score = totalGradable > 0 ? Math.round((correct / totalGradable) * 100) : -1;

		const scoreCard = el.createDiv({ attr: { style: "text-align:center;padding:16px;margin-bottom:14px;border-radius:8px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);" } });
		if (score >= 0) {
			const scoreColor = score >= 80 ? "var(--color-green)" : score >= 60 ? "var(--color-yellow)" : "var(--color-red)";
			scoreCard.createDiv({ text: score + " 分", attr: { style: "font-size:36px;font-weight:bold;color:" + scoreColor + ";line-height:1.2;" } });
			scoreCard.createDiv({ text: "客观题 " + totalGradable + " 题：正确 " + correct + " / 错误 " + wrongList.length, attr: { style: "color:var(--text-muted);margin-top:6px;font-size:19px;" } });
		}
		if (nonGradable.length > 0) scoreCard.createDiv({ text: "主观题 " + nonGradable.length + " 题：请对照参考答案自查", attr: { style: "color:var(--text-faint);margin-top:4px;font-size:18px;" } });

		const selectRow = el.createDiv({ attr: { style: "display:flex;align-items:center;gap:8px;margin:4px 0 6px;" } });
		selectRow.createSpan({ text: "勾选要加入错题本的题目：", attr: { style: "color:var(--text-muted);font-size:17px;" } });
		const selectBtn = selectRow.createEl("button", { text: "全选", attr: { style: "padding:3px 14px;border-radius:4px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
		const checkboxes: HTMLInputElement[] = [];
		const updateSelectBtn = () => {
			const allChecked = checkboxes.length > 0 && checkboxes.every(c => c.checked);
			selectBtn.setText(allChecked ? "取消全选" : "全选");
		};
		selectBtn.addEventListener("click", () => {
			const allChecked = checkboxes.length > 0 && checkboxes.every(c => c.checked);
			this.answerWrongChecked.clear();
			for (const cb of checkboxes) {
				cb.checked = !allChecked;
				if (cb.checked) this.answerWrongChecked.add(Number(cb.dataset.num));
			}
			updateSelectBtn();
		});

		const typeLabels: Record<QuestionType, string> = { single: "单选", multi: "多选", judge: "判断", blank: "填空", essay: "简答" };

		if (gradable.length > 0) {
			el.createDiv({ text: "客观题详情", attr: { style: "font-size:19px;font-weight:600;margin:12px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--background-modifier-border);" } });
			for (const q of gradable) {
				const userAnswer = this.answerAnswers.get(q.number) || "";
				let isCorrect = false;
				if (q.type === "single" || q.type === "judge") isCorrect = userAnswer.toUpperCase() === q.answer.toUpperCase();
				else if (q.type === "multi") isCorrect = userAnswer.split("").sort().join("").toUpperCase() === q.answer.toUpperCase();

				const borderColor = isCorrect ? "var(--color-green)" : "var(--color-red)";
				const qEl = el.createDiv({ attr: { style: "border:1px solid " + borderColor + ";border-radius:8px;padding:10px 12px;margin-bottom:8px;" } });

				const qHeader = qEl.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;margin-bottom:6px;" } });
				const wCb = qHeader.createEl("input", { attr: { type: "checkbox" } });
				wCb.dataset.num = String(q.number);
				wCb.checked = this.answerWrongChecked.has(q.number);
				wCb.addEventListener("change", () => { wCb.checked ? this.answerWrongChecked.add(q.number) : this.answerWrongChecked.delete(q.number); updateSelectBtn(); });
				checkboxes.push(wCb);
				qHeader.createSpan({ text: isCorrect ? "✓ 正确" : "✗ 错误", attr: { style: "font-size:17px;padding:2px 6px;border-radius:4px;font-weight:600;" + (isCorrect ? "background:color-mix(in srgb, var(--color-green) 15%, transparent);color:var(--color-green);" : "background:color-mix(in srgb, var(--color-red) 15%, transparent);color:var(--color-red);") } });
				qHeader.createSpan({ text: typeLabels[q.type], attr: { style: "font-size:16px;color:var(--text-muted);" } });

				const qTextRow = qEl.createDiv({ attr: { style: "font-weight:600;line-height:1.7;font-size:19px;margin-bottom:6px;" } });
				qTextRow.createSpan({ text: q.number + ". ", attr: { style: "font-weight:700;" } });
				qTextRow.createSpan({ text: q.text });
 
 				for (const opt of q.options) {
					const isUserChoice = q.type === "multi" ? userAnswer.includes(opt.label) : opt.label === userAnswer;
					const isCorrectOpt = q.type === "multi" ? q.answer.includes(opt.label) : opt.label === q.answer;
					let optStyle = "padding:2px 0;font-size:19px;line-height:1.5;";
					if (isCorrectOpt) optStyle += "color:var(--color-green);font-weight:600;";
					else if (isUserChoice && !isCorrect) optStyle += "color:var(--color-red);text-decoration:line-through;";
					qEl.createDiv({ text: opt.label + ". " + opt.text, attr: { style: optStyle } });
				}

				if (q.answer) {
					const refLabel = qEl.createDiv({ attr: { style: "margin-top:4px;" } });
					refLabel.createDiv({ text: "参考答案", attr: { style: "font-size:18px;font-weight:700;color:#2E7D32;margin-bottom:2px;" } });
					const steps = splitAnswerContent(q.answer);
					for (const step of steps) qEl.createDiv({ text: step, attr: { style: "font-size:18px;line-height:1.6;" } });
				}
				if (q.explanation) {
					const expLabel = qEl.createDiv({ attr: { style: "margin-top:4px;" } });
					expLabel.createDiv({ text: "考点解析", attr: { style: "font-size:18px;font-weight:700;color:#1565C0;margin-bottom:2px;" } });
					const expLines = splitAnswerContent(q.explanation);
					for (const line of expLines) qEl.createDiv({ text: line, attr: { style: "font-size:17px;line-height:1.6;color:var(--text-muted);" } });
				}
			}
		}

		if (nonGradable.length > 0) {
			el.createDiv({ text: "主观题参考答案", attr: { style: "font-size:19px;font-weight:600;margin:12px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--background-modifier-border);" } });
			for (const q of nonGradable) {
				const userAnswer = this.answerAnswers.get(q.number) || "";
				const qEl = el.createDiv({ attr: { style: "border:1px solid var(--interactive-accent);border-radius:8px;padding:10px 12px;margin-bottom:8px;" } });
				const qHeader = qEl.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;margin-bottom:6px;" } });
				const wCb = qHeader.createEl("input", { attr: { type: "checkbox" } });
				wCb.dataset.num = String(q.number);
				wCb.checked = this.answerWrongChecked.has(q.number);
				wCb.addEventListener("change", () => { wCb.checked ? this.answerWrongChecked.add(q.number) : this.answerWrongChecked.delete(q.number); updateSelectBtn(); });
				checkboxes.push(wCb);
				qHeader.createSpan({ text: typeLabels[q.type], attr: { style: "font-size:16px;padding:2px 6px;border-radius:4px;background:var(--interactive-accent);color:var(--text-on-accent);" } });

				const qTextRow = qEl.createDiv({ attr: { style: "font-weight:600;line-height:1.7;font-size:19px;margin-bottom:6px;" } });
				qTextRow.createSpan({ text: q.number + ". ", attr: { style: "font-weight:700;" } });
				qTextRow.createSpan({ text: q.text });
 				if (userAnswer) {
					qEl.createDiv({ text: "你的答案：", attr: { style: "font-size:17px;color:var(--text-muted);margin-bottom:2px;" } });
					qEl.createDiv({ text: userAnswer, attr: { style: "padding:6px 10px;border-radius:4px;background:var(--background-secondary);font-size:19px;line-height:1.7;white-space:pre-wrap;" } });
				}
				if (q.answer) {
					const refAns = qEl.createDiv({ attr: { style: "margin-top:6px;" } });
					refAns.createDiv({ text: "参考答案", attr: { style: "font-size:17px;color:#2E7D32;font-weight:700;margin-bottom:2px;" } });
					const steps = splitAnswerContent(q.answer);
					for (const step of steps) refAns.createDiv({ text: step, attr: { style: "padding:3px 10px;border-radius:4px;background:color-mix(in srgb, var(--color-green) 8%, transparent);font-size:19px;line-height:1.7;" } });
				}
				if (q.explanation) {
					const expEl = qEl.createDiv({ cls: "qg-exp-top" });
					expEl.createDiv({ text: "考点解析", cls: "qg-exp-title" });
					const expLines = splitAnswerContent(q.explanation);
					for (const line of expLines) expEl.createDiv({ text: line, cls: "qg-exp-line" });
				}
			}
		}

		if (this.answerQuestions.length > 0) {
			const wrongBtnRow = el.createDiv({ cls: "qg-mt10" });
			const wrongBtn = wrongBtnRow.createEl("button", { text: "加入错题本", attr: { class: "mod-cta" }, cls: "qg-wrong-btn" });
			const wrongArea = el.createDiv({ cls: "qg-wrong-area qg-hidden" });
			const questionsText = this.answerQuestions.map(q => q.text).join("\n");
			wrongArea.createDiv({ text: "知识点标签（可编辑）：", cls: "qg-label-text" });
			const tagsInput = wrongArea.createEl("input", { attr: { type: "text", value: "", placeholder: "AI识别中，点击“加入错题本”后自动识别", style: "width:100%;padding:6px;border-radius:4px;border:1px solid var(--background-modifier-border);margin-bottom:6px;font-size:18px;" } });
			wrongArea.createDiv({ text: "备注：", attr: { style: "font-size:18px;margin-bottom:4px;" } });
			const noteArea = wrongArea.createEl("textarea", { attr: { style: "width:100%;height:40px;border-radius:4px;border:1px solid var(--background-modifier-border);font-size:18px;", placeholder: "例如：第3、7题做错了" } });
			const confirmWrongBtn = wrongArea.createEl("button", { text: "确认加入", attr: { class: "mod-cta", style: "padding:5px 14px;border-radius:4px;cursor:pointer;font-size:18px;margin-top:4px;" } });
			confirmWrongBtn.addEventListener("click", () => {
				void (async () => {
					this.answerCurrentTags = tagsInput.value.split(",").map(s => s.trim()).filter(Boolean);
					const checked = this.answerWrongChecked.size > 0 ? this.answerQuestions.filter(q => this.answerWrongChecked.has(q.number)) : wrongList;
					if (checked.length === 0) { new Notice("请先勾选要加入错题本的题目"); return; }
					await this.answerSaveWrongToBook(checked, noteArea.value);
					wrongArea.classList.add("qg-hidden");
				})();
			});
			let tagsSuggested = false;
			wrongBtn.addEventListener("click", () => {
				wrongArea.classList.toggle("qg-hidden");
				if (!tagsSuggested) {
					tagsSuggested = true;
					tagsInput.placeholder = "AI识别知识点中...";
					this.resetAI();
					void this.aiSuggestTags(questionsText).then(tags => {
						if (tagsInput.value.trim() === "") tagsInput.value = tags.join(", ");
					});
				}
			});
		}

		const homeBtn = el.createDiv({ cls: "qg-home-btn" });
		const hb = homeBtn.createEl("button", { text: "返回首页", cls: "qg-btn-home" });
		hb.addEventListener("click", () => { this.homeView = "default"; void this.renderHomeTab(); });
	}

	async answerSaveWrongToBook(wrongList: ParsedQuestion[], noteText: string) {
		this.resetAI();
		const typeLabels: Record<QuestionType, string> = { single: "单选题", multi: "多选题", judge: "判断题", blank: "填空题", essay: "简答题" };
		const fmtPoints = (label: string, content: string): string => {
			const lines = content.split("\n").map(s => s.trim()).filter(Boolean);
			if (lines.length > 1 || /\(\d+\)/.test(content)) {
				return label + "：\n" + lines.join("\n");
			}
			return label + "：" + content;
		};
		const groups: Partial<Record<QuestionType, ParsedQuestion[]>> = {};
		for (const q of wrongList) (groups[q.type] ??= []).push(q);
		let wrongText = "";
		let seq = 0;
		for (const [type, questions] of Object.entries(groups) as [QuestionType, ParsedQuestion[]][]) {
			wrongText += "## " + typeLabels[type] + "\n";
			for (const q of questions) {
				seq++;
				wrongText += "**" + seq + ".** " + q.text + "\n";
				for (const opt of q.options) wrongText += opt.label + ". " + opt.text + "\n";
				wrongText += fmtPoints("答案", q.answer) + "\n";
				if (q.explanation) wrongText += fmtPoints("解析", q.explanation) + "\n";
				wrongText += "\n";
			}
		}
		const autoTags = await this.aiSuggestTags(wrongText);
		const tags = ["错题", ...this.answerCurrentTags, ...autoTags.filter(t => !this.answerCurrentTags.includes(t))];
		const knowledgeLinks = buildKnowledgeLinks(tags);
		try {
			await ensureFolder(this.app, this.plugin.rootPath(this.plugin.settings.wrongBookFolder));
			const dateStr = new Date().toISOString().slice(0, 10);
			const sourceLink = this.answerSourceName ? "[[" + this.answerSourceName + "]]" : "";
			const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
			const fm = buildFM({ source: sourceLink, sourcePath: this.answerSourcePath, date: dateStr, tags, note: noteText || "答题模式加入（" + wrongList.length + "题错误）", nextReview: tomorrow.toISOString().slice(0, 10), interval: 1, correctCount: 0, wrongCount: wrongList.length });
			const content = fm + normalizeExamContent(wrongText) + knowledgeLinks;
			const fileName = safeName(this.answerSourceName) + "_错题_" + dateStr + ".md";
			if (isAbs(this.plugin.rootPath(this.plugin.settings.wrongBookFolder))) {
				const dir = this.plugin.rootPath(this.plugin.settings.wrongBookFolder);
				try { writeFileStr(joinPath(dir, fileName), content); }
				catch { writeFileStr(joinPath(dir, safeName(this.answerSourceName) + "_错题_" + Date.now() + ".md"), content); }
			} else {
				try { await this.app.vault.create(this.plugin.rootPath(this.plugin.settings.wrongBookFolder) + "/" + fileName, content); }
				catch { await this.app.vault.create(this.plugin.rootPath(this.plugin.settings.wrongBookFolder) + "/" + safeName(this.answerSourceName) + "_错题_" + Date.now() + ".md", content); }
			}
			new Notice("已自动将 " + wrongList.length + " 道错题加入错题本");
			this.plugin.emitDataChanged();
			this.syncToKnowledgeIndex(tags, fileName.replace(/\.md$/, ""), joinPath(this.plugin.rootPath(this.plugin.settings.wrongBookFolder), fileName), "错题");
		} catch (err) { new Notice("加入错题本失败：" + (err as Error).message); console.error("[question-generator] 加入错题本失败:", err); }
	}

	// ===================== HELPERS =====================
	private openLinkedFile(linkText: string) {
		const clean = linkText.replace(/\.(md|txt|rtf|docx|pdf)$/i, "").trim();
		const dest = this.app.metadataCache?.getFirstLinkpathDest(linkText, "") ?? this.app.metadataCache?.getFirstLinkpathDest(clean, "");
		if (dest) { this.app.workspace.openLinkText(dest.path, "", false).catch(() => {}); return; }
		if (isAbs(linkText)) {
			const file = this.app.vault.getAbstractFileByPath(linkText);
			if (file instanceof TFile) { this.app.workspace.openLinkText(file.path, "", false).catch(() => {}); return; }
		}
		const byName = this.app.vault.getFiles().find(f => f.basename === clean || f.name === linkText || f.path === linkText);
		if (byName) { this.app.workspace.openLinkText(byName.path, "", false).catch(() => {}); return; }
		new Notice("找不到文件：" + linkText);
	}

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

	renderHistoryView() {
		if (!this.innerContentEl) return;
		const el = this.innerContentEl;
		el.empty();

		const backBtn = el.createEl("button", { text: "← 返回", attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:19px;margin-bottom:12px;" } });
		backBtn.addEventListener("click", () => { this.homeView = "default"; void this.renderHomeTab(); });

		const headerRow = el.createDiv({ attr: { style: "display:flex;align-items:center;gap:8px;margin-bottom:10px;" } });
		headerRow.createDiv({ text: "生成历史记录", attr: { style: "font-size:20px;font-weight:bold;flex:1;" } });

		const entries = this.plugin.history.slice().sort((a, b) => b.timestamp - a.timestamp);
		if (entries.length === 0) {
			el.createDiv({ text: "暂无生成历史", attr: { style: "color:var(--text-muted);text-align:center;padding:40px 0;font-size:18px;" } });
			return;
		}

		const clearBtn = headerRow.createEl("button", { text: "清空历史", attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;font-size:17px;border:1px solid var(--color-red);background:var(--background-secondary);color:var(--color-red);" } });
		clearBtn.addEventListener("click", () => { this.plugin.history = []; void this.plugin.saveHistory(); void this.renderHistoryView(); });

		const listEl = el.createDiv({ attr: { style: "display:flex;flex-direction:column;gap:8px;" } });
		for (const entry of entries) {
			const card = listEl.createDiv({ attr: { style: "border:1px solid var(--background-modifier-border);border-radius:8px;overflow:hidden;" } });
			const head = card.createDiv({ attr: { style: "display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;background:var(--background-secondary);" } });
			head.createSpan({ text: entry.fileName, attr: { style: "font-weight:600;font-size:17px;flex:1;word-break:break-all;" } });
			head.createSpan({ text: new Date(entry.timestamp).toLocaleString(), attr: { style: "color:var(--text-faint);font-size:15px;flex-shrink:0;" } });
			if (entry.sourcePath) {
				card.createDiv({ text: "来源：" + entry.sourcePath, attr: { style: "padding:0 10px 6px;color:var(--text-muted);font-size:16px;word-break:break-all;" } });
			}
			const body = card.createDiv({ attr: { style: "display:none;border-top:1px solid var(--background-modifier-border);padding:8px 10px;" } });
			const ta = body.createEl("textarea", { attr: { style: "width:100%;height:180px;font-family:monospace;font-size:17px;line-height:1.5;" } });
			ta.value = entry.resultText;
			ta.readOnly = true;
			head.addEventListener("click", () => {
				body.style.display = body.style.display === "none" ? "block" : "none";
			});
		}
	}

	openGeneratePicker(folder?: string) {
		this.genPickerMode = folder ? "folder" : "current";
		this.genPickerFolder = folder ? folder.replace(/\\/g, "/") : "";
		this.fpSelected.clear();
		this.fpAllFiles = [];
		this.homeView = "filePicker";
		void this.renderHomeTab();
	}

	async openCurrentFileExtract(file?: TFile) {
		const target = file ?? this.app.workspace.getActiveFile();
		const ext = target ? target.extension.toLowerCase() : "";
		if (!target || (ext !== "md" && !EXAM_SOURCE_EXTS.includes(ext))) { new Notice("请打开一个支持的试卷文件（md/txt/rtf/docx/pdf/图片）"); return; }

		const cfg = this.plugin.settings;
		const saveFolder = this.plugin.rootPath(cfg.extractedExamFolder || "题目/识别试卷");
		await ensureFolder(this.app, saveFolder);

		this.examProcessing = true;
		this.resetAI();
		this.examStatusText = "正在识别当前文件 " + target.name + "...";
		this.homeView = "examBrowser";
		void this.renderHomeTab();

		try {
			const content = await this.examSourceToText(target);
			if (!content || content.trim().length === 0) { new Notice("未能读取文件内容"); return; }

			let allQuestionsText = "";
			if (isImageFile(target.name)) {
				allQuestionsText = content;
			} else if (content.length <= MAX_EXAM_CHUNK_CHARS) {
				const full = await this.callAIWithPrompt(buildExamExtractPrompt(content));
				if (full) allQuestionsText = full;
			} else {
				const chunks: string[] = [];
				for (let start = 0; start < content.length; start += MAX_EXAM_CHUNK_CHARS - EXAM_CHUNK_OVERLAP) {
					chunks.push(content.slice(start, start + MAX_EXAM_CHUNK_CHARS));
					if (start + MAX_EXAM_CHUNK_CHARS >= content.length) break;
				}
			for (let ci = 0; ci < chunks.length; ci++) {
				if (this.aiCancelled) break;
				this.examStatusText = "正在识别当前文件 " + target.name + " - 第" + (ci + 1) + "/" + chunks.length + "段...";
				void this.renderHomeTab();
				const full = await this.callAIWithPrompt(buildExamExtractPrompt(chunks[ci]!, ci + 1, chunks.length));
				if (full) allQuestionsText += "\n\n" + full;
			}
			if (this.aiCancelled) return;
		}
		if (!allQuestionsText.trim()) { new Notice("未能识别出题目"); return; }

			const mergedText = mergeExamChunks(allQuestionsText);

			const questions = parseQuestions(mergedText);
			if (questions.length === 0) { new Notice("未能识别出题目"); return; }

			const { cleanText } = parseAITagsFromResult(allQuestionsText);
			const aiTags = await this.aiSuggestTags(mergedText);
			const normalized = normalizeExamContent(fixSequentialNumbers(cleanText));
			const safeBase = target.basename.replace(/[<>:"/\\|?*]/g, "_");
			const savePath = saveFolder + "/" + safeBase + " - AI识别.md";
			const dateStr = new Date().toISOString().slice(0, 10);
			const allTags = ["试卷", "AI识别", ...aiTags.filter(t => t !== "试卷" && t !== "AI识别")];
			const sourceLink = "[[" + target.basename + "]]";
			const qIvls = parseReviewIntervals(this.plugin.settings.questionReviewIntervals, DEFAULT_QUESTION_INTERVALS);
			const nextReviewDate = new Date(); nextReviewDate.setDate(nextReviewDate.getDate() + qIvls[0]!);
			const fm = buildFM({ source: sourceLink, sourcePath: target.path, date: dateStr, tags: allTags, nextReview: nextReviewDate.toISOString().slice(0, 10), interval: qIvls[0]!, correctCount: 0, wrongCount: 0 });
			const kTags = knowledgeTags(allTags.filter(t => t !== "试卷" && t !== "AI识别"));
			const knowledgeLinks = kTags.length > 0 ? "\n\n---\n\n**知识点：** " + kTags.map(t => "[[" + t + "]]").join(" ") + "\n" : "";
			const saveContent = fm + normalized + knowledgeLinks;
			try { await this.app.vault.create(savePath, saveContent); }
			catch { await this.app.vault.create(saveFolder + "/" + safeBase + " - AI识别_" + Date.now() + ".md", saveContent); }
			this.syncToKnowledgeIndex(aiTags, path.basename(savePath).replace(/\.md$/, ""), savePath, "题目");

			this.examSelected.clear();
			this.examStatusText = "";
			new Notice("识别完成，共 " + questions.length + " 题，已保存至 " + saveFolder);
			this.startAnswer(normalized, target.basename + " - AI识别", savePath);
		} catch (err) {
			if ((err as Error).name === "AbortError") {
				if (this.aiCancelled) this.examStatusText = "已中止";
			} else {
				new Notice("识别失败：" + (err as Error).message);
			}
		} finally {
			this.examProcessing = false;
			if (this.homeView === "examBrowser") void this.renderHomeTab();
		}
	}

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

class KnowledgeDeleteConfirmModal extends Modal {
	confirmed = false;
	constructor(
		app: App,
		private title: string,
		private indexFiles: string[],
		private isBulk: boolean,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.classList.add("qg-confirm-modal");

		contentEl.createDiv({ text: this.isBulk ? "删除选中的 " + this.indexFiles.length + " 个索引文件" : "删除知识点： " + this.title, attr: { style: "font-size:18px;font-weight:700;margin-bottom:12px;" } });
		if (this.isBulk) {
			contentEl.createDiv({ text: "将删除以下知识点： " + this.title, attr: { style: "font-size:15px;color:var(--text-muted);margin-bottom:8px;word-break:break-all;line-height:1.6;" } });
		}
		contentEl.createDiv({ text: "将同时删除以下 " + this.indexFiles.length + " 个索引文件：", attr: { style: "font-size:15px;color:var(--text-muted);margin-bottom:8px;" } });

		const listEl = contentEl.createDiv({ attr: { style: "max-height:200px;overflow:auto;background:var(--background-secondary);border:1px solid var(--background-modifier-border);border-radius:8px;padding:10px 12px;margin-bottom:16px;font-size:14px;line-height:1.8;" } });
		for (const f of this.indexFiles) listEl.createDiv({ text: "· " + f, attr: { style: "word-break:break-all;" } });
		contentEl.createDiv({ text: "此操作不可恢复，是否继续？", attr: { style: "font-size:15px;color:var(--text-accent);margin-bottom:24px;" } });

		const btnRow = contentEl.createDiv({ attr: { style: "display:flex;justify-content:flex-end;gap:8px;" } });
		const cancelBtn = btnRow.createEl("button", { text: "取消", attr: { style: "padding:6px 16px;border-radius:6px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:15px;" } });
		cancelBtn.addEventListener("click", () => this.close());
		const okBtn = btnRow.createEl("button", { text: "删除", attr: { style: "padding:6px 16px;border-radius:6px;cursor:pointer;border:1px solid var(--color-red);background:var(--color-red);color:var(--text-on-accent);font-size:15px;" } });
		okBtn.addEventListener("click", () => { this.confirmed = true; this.close(); });
	}

	onClose() {
		this.contentEl.empty();
	}
}

function confirmKnowledgeDelete(app: App, title: string, indexFiles: string[], isBulk = false): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const modal = new KnowledgeDeleteConfirmModal(app, title, indexFiles, isBulk);
		modal.open();
		const origClose = modal.close.bind(modal);
		modal.close = () => { origClose(); resolve(modal.confirmed); };
	});
}
