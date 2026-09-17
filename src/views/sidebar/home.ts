import { Notice, TFile, TFolder } from "obsidian";
import * as fs from "fs";
import * as path from "path";

import type { MainSidebarView } from "../sidebarView";
import { PREVIEW_ITEMS_LIMIT } from "../../constants";
import { isAbs, isExcludedPath, listMdFilesRecursive } from "../../utils/fs-utils";
import { isDueForReview } from "../../utils/review";
import { t, tf } from "../../i18n/index";

export async function getActivityData(view: MainSidebarView) {
		const activity: Record<string, number> = {};
		const folders = [
			view.plugin.rootPath(view.plugin.settings.questionFolder),
			view.plugin.rootPath(view.plugin.settings.wrongBookFolder),
			view.plugin.rootPath(view.plugin.settings.noteViewFolder),
		];
		const excludes = [view.plugin.rootPath(view.plugin.settings.knowledgeFolder)].filter(Boolean);
		const exclPrefixes = excludes.map(p => (p.endsWith("/") ? p : p + "/"));
		const excludeCfg = view.plugin.settings.excludeFolders || "";
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
					const files = view.app.vault.getFiles().filter(f => f.path.startsWith(prefix) && f.extension === "md" && !exclPrefixes.some(e => f.path.startsWith(e)) && !isExcludedPath(f.path, excludeCfg));
					for (const child of files) {
						const day = new Date(child.stat.mtime).toISOString().slice(0, 10);
						activity[day] = (activity[day] || 0) + 1;
					}
				}
			} catch { /* skip */ }
		}
		return activity;
}

export function renderHeatmap(view: MainSidebarView, container: HTMLElement, activity: Record<string, number>, year: string) {
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
			view.heatmapYear = sel.value;
			view.renderHeatmap(container, activity, sel.value);
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

export async function renderHomeDefault(view: MainSidebarView) {
		if (!view.innerContentEl) return;
		const el = view.innerContentEl;
		el.empty();

		const stats = await view.getStats();

		const statsGrid = el.createDiv({ cls: "qg-stat-grid", attr: { style: "display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px;" } });
		const miniCard = (label: string, value: string, color?: string) => {
			const c = statsGrid.createDiv({ cls: "qg-stat-card", attr: { style: "text-align:center;padding:14px 6px;border-radius:12px;cursor:pointer;" } });
			c.createDiv({ text: value, attr: { style: "font-size:29px;font-weight:bold;" + (color ? "color:" + color + ";" : "") } });
			c.createDiv({ text: label, attr: { style: "color:var(--text-muted);font-size:17px;margin-top:2px;" } });
			return c;
		};
		const qCard = miniCard(t("题目"), String(stats.questionCount), stats.questionCount > 0 ? "var(--interactive-accent)" : undefined);
		qCard.addEventListener("click", () => { view.activeSection = "questions"; void view.render(); });
		const nCard = miniCard(t("笔记"), String(stats.noteCount), stats.noteCount > 0 ? "var(--color-green)" : undefined);
		nCard.addEventListener("click", () => { view.activeSection = "notes"; void view.render(); });
		const dueCard = miniCard(t("待复习"), String(stats.dueCount), stats.dueCount > 0 ? "var(--color-orange)" : undefined);
		dueCard.addEventListener("click", () => { view.activeSection = "review"; void view.render(); });
		const wCard = miniCard(t("错题"), String(stats.totalWrong), stats.totalWrong > 0 ? "var(--color-red)" : undefined);
		wCard.addEventListener("click", () => { view.activeSection = "wrong"; view.wrongView = "list"; void view.render(); });

		const heatmapSection = el.createDiv({ cls: "qg-section-card qg-clip", attr: { style: "margin-bottom:16px;padding:14px;border-radius:16px;overflow:hidden;" } });
		const heatmapData = await view.getActivityData();
		view.renderHeatmap(heatmapSection, heatmapData, view.heatmapYear);

		const actSection = el.createDiv({ attr: { style: "margin-bottom:14px;" } });
		actSection.createDiv({ text: t("快捷操作"), cls: "qg-section-heading", attr: { style: "font-size:18px;font-weight:600;color:var(--text-muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;" } });

		const actions = [
			{ label: t("💬 AI 助手"), desc: t("基于你的笔记知识库进行问答"), action: () => { void view.plugin.activateChat(); } },
			{ label: t("📝 选择文件生成题目"), desc: t("让AI根据文档内容创作新题目存入题库"), action: () => view.openGeneratePicker() },
			{ label: t("🎯 薄弱点生成题目"), desc: t("针对薄弱知识点"), badge: stats.weakCount > 0 ? String(stats.weakCount) : undefined, action: async () => { await view.generateFromWeakPoints(); } },
			{ label: t("📋 AI识别试卷"), desc: t("提取文档中已有题目，保存后直接答题"), action: () => { view.homeView = "examBrowser"; void view.renderHomeTab(); } },
			{ label: t("🏷️ AI添加标签"), desc: t("AI识别知识点并写入frontmatter，用于知识图谱"), action: () => { view.taggerMode = "current"; view.fpSelected.clear(); view.fpAllFiles = []; view.homeView = "tagger"; void view.renderHomeTab(); } },
			{ label: t("🤖 AI生成笔记"), desc: t("对当前文件或从文件/题目/错题/笔记生成浓缩知识点笔记"), action: () => { view.noteGenSourceType = "doc"; view.noteGenSelected.clear(); view.noteGenResultText = ""; view.noteGenMode = "picker"; view.homeView = "noteGen"; void view.renderHomeTab(); } },
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
			goBtn.addEventListener("click", () => { view.activeSection = "review"; void view.render(); });
			const dueNotes = await view.getDueNotes();
			const shown = dueNotes.slice(0, PREVIEW_ITEMS_LIMIT);
			shown.forEach((item, i) => {
				const note = item.note;
				const isLast = i === shown.length - 1;
				const row = reviewSection.createDiv({ attr: { style: "display:flex;align-items:center;gap:8px;padding:8px 0;" + (isLast ? "" : "border-bottom:1px solid color-mix(in srgb, var(--qg-border) 60%, transparent);") } });
				row.createSpan({ text: (note.sourceFile || note.baseName).replace(/\[\[|\]\]/g, ""), attr: { style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:16px;" } });
				const btn = row.createSpan({ text: t("复习"), attr: { style: "padding:3px 10px;border-radius:999px;background:var(--interactive-accent);color:var(--text-on-accent);cursor:pointer;font-size:14px;font-weight:600;flex-shrink:0;" } });
				btn.addEventListener("click", () => {
					if (item.source === "wrong") { view.activeSection = "wrong"; view.wrongView = "detail"; view.wrongCurrentNote = note; void view.render(); }
					else { void view.app.workspace.openLinkText(note.baseName, "", false); }
				});
			});
			if (stats.dueCount > shown.length) reviewSection.createDiv({ text: tf("还有 {n} 题...", { n: stats.dueCount - shown.length }), attr: { style: "font-size:14px;color:var(--text-muted);padding-top:8px;" } });
		}

		const toolsSection = el.createDiv({ attr: { style: "margin-top:10px;" } });
		toolsSection.createDiv({ text: t("数据维护"), cls: "qg-section-heading", attr: { style: "font-size:18px;font-weight:600;color:var(--text-muted);margin:12px 0 8px;text-transform:uppercase;letter-spacing:0.5px;" } });
		const kmRow = toolsSection.createDiv({ cls: "qg-action-row" });
		const kmInfo = kmRow.createDiv({ cls: "qg-action-info", attr: { style: "flex:1;min-width:0;" } });
		kmInfo.createDiv({ text: t("🧠 知识点管理"), cls: "qg-action-label" });
		kmInfo.createDiv({ text: t("查看并删除知识点及其对应的索引文件"), cls: "qg-action-desc" });
		kmRow.addEventListener("click", () => { view.homeView = "knowledgeManager"; void view.renderHomeTab(); });
		const rebuildRow = toolsSection.createDiv({ cls: "qg-action-row" });
		const rebuildInfo = rebuildRow.createDiv({ cls: "qg-action-info", attr: { style: "flex:1;min-width:0;" } });
		rebuildInfo.createDiv({ text: t("🔄 重建知识点索引"), cls: "qg-action-label" });
		rebuildInfo.createDiv({ text: t("扫描各文件夹的标签，重新生成关联的知识点索引文件"), cls: "qg-action-desc" });
		rebuildRow.addEventListener("click", () => { void (async () => {
			const report = await view.plugin.rebuildKnowledgeIndex();
			const extra: string[] = [];
			if (report.brokenLinks > 0) extra.push(tf("失效链接 {n} 处", { n: report.brokenLinks }));
			if (report.duplicates > 0) extra.push(tf("疑似重复文件 {n} 组", { n: report.duplicates }));
			new Notice(extra.length > 0 ? t("知识点索引已重建") + "：" + extra.join("，") : t("知识点索引已重建"));
		})(); });
		const cacheRow = toolsSection.createDiv({ cls: "qg-action-row" });
		const cacheInfo = cacheRow.createDiv({ cls: "qg-action-info", attr: { style: "flex:1;min-width:0;" } });
		cacheInfo.createDiv({ text: t("🧹 清除缓存"), cls: "qg-action-label" });
		cacheInfo.createDiv({ text: t("清空内存中的错题缓存，下次访问自动重新读取"), cls: "qg-action-desc" });
		cacheRow.addEventListener("click", () => { view.plugin.invalidateCache(); new Notice(t("缓存已清除")); });
}

export async function getStats(view: MainSidebarView) {
		const wrongNotes = await view.plugin.loadAllWrongNotes();
		const questionFiles = await view.plugin.loadAllQuestionFilesForReview();
		const vaultNotes = await view.plugin.loadAllVaultNotesForReview();
		const allReviewItems = [...wrongNotes, ...questionFiles, ...vaultNotes];
		const dueCount = allReviewItems.filter(n => isDueForReview(n)).length;
		const weakPoints = await view.plugin.getWeakPoints();
		const qFolder = view.plugin.rootPath(view.plugin.settings.questionFolder);
		const nFolder = view.plugin.rootPath(view.plugin.settings.noteViewFolder);
		let questionCount = 0;
		let noteCount = 0;
		const excludeCfg = view.plugin.settings.excludeFolders || "";
		if (qFolder) {
			const excludes = [view.plugin.rootPath(view.plugin.settings.knowledgeFolder)].filter(Boolean);
			if (isAbs(qFolder)) { try { if (fs.existsSync(qFolder)) questionCount = listMdFilesRecursive(qFolder, excludes).filter(fp => !isExcludedPath(fp, excludeCfg)).length; } catch { /* */ } }
			else { const prefix = qFolder.endsWith("/") ? qFolder : qFolder + "/"; const exclPrefixes = excludes.map(p => (p.endsWith("/") ? p : p + "/")); questionCount = view.app.vault.getFiles().filter(f => f.path.startsWith(prefix) && f.extension === "md" && !exclPrefixes.some(e => f.path.startsWith(e)) && !isExcludedPath(f.path, excludeCfg)).length; }
		}
		if (nFolder) {
			if (isAbs(nFolder)) { try { if (fs.existsSync(nFolder)) noteCount = fs.readdirSync(nFolder).filter((f: string) => f.endsWith(".md") && !isExcludedPath(path.join(nFolder, f), excludeCfg)).length; } catch { /* */ } }
			else { const tf = view.app.vault.getAbstractFileByPath(nFolder); if (tf instanceof TFolder) noteCount = tf.children.filter(f => f instanceof TFile && f.name.endsWith(".md") && !isExcludedPath(f.path, excludeCfg)).length; }
		}
		return {
			dueCount,
			totalWrong: wrongNotes.length,
			weakCount: weakPoints.length,
			questionCount,
			noteCount,
		};
}

export async function getDueNotes(view: MainSidebarView) {
		const wrongNotes = await view.plugin.loadAllWrongNotes();
		const questionFiles = await view.plugin.loadAllQuestionFilesForReview();
		const vaultNotes = await view.plugin.loadAllVaultNotesForReview();
		return [
			...wrongNotes.map(n => ({ note: n, source: "wrong" as const })),
			...questionFiles.map(n => ({ note: n, source: "question" as const })),
			...vaultNotes.map(n => ({ note: n, source: "note" as const })),
		].filter(i => isDueForReview(i.note));
}
