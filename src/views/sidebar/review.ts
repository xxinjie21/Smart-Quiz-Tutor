import { Notice } from "obsidian";

import type { MainSidebarView } from "../sidebarView";
import type { WrongAnswerNote } from "../../types";
import { isDueForReview } from "../../utils/review";
import { daysUntil } from "../../utils/fs-utils";
import { knowledgeTags } from "../../utils/frontmatter";
import { groupBySource, groupByTag } from "../../utils/listView";
import { QUALITY } from "../../utils/sm2";
import { segBar, emptyState, collapseGroup } from "./shared/ui";
import { t, tf } from "../../i18n/index";

export async function renderReviewTab(view: MainSidebarView) {
	if (!view.innerContentEl) return;
	const el = view.innerContentEl;
	el.empty();

	const wrongNotes = await view.plugin.loadAllWrongNotes();
	const questionFiles = await view.plugin.loadAllQuestionFilesForReview();
	const vaultNotes = await view.plugin.loadAllVaultNotesForReview();

	type ReviewItem = { note: WrongAnswerNote; source: "wrong" | "question" | "note" };
	const allItems: ReviewItem[] = [
		...wrongNotes.map(n => ({ note: n, source: "wrong" as const })),
		...questionFiles.map(n => ({ note: n, source: "question" as const })),
		...vaultNotes.map(n => ({ note: n, source: "note" as const })),
	];
	const dueItems = allItems.filter(i => isDueForReview(i.note));

	const filterOpts: { key: "all" | "wrong" | "question" | "note"; label: string }[] = [
		{ key: "all", label: t("全部") },
		{ key: "wrong", label: t("错题") },
		{ key: "question", label: t("题目") },
		{ key: "note", label: t("笔记") },
	];
	segBar(el, filterOpts.map(opt => ({ key: opt.key, label: opt.label + " (" + (opt.key === "all" ? dueItems.length : dueItems.filter(i => i.source === opt.key).length) + ")" })), key => view.reviewFilterType === key, key => {
		view.reviewFilterType = key as "all" | "wrong" | "question" | "note";
		void view.renderReviewTab();
	});

	const sortOpts: { key: "default" | "source" | "tag" | "time"; label: string }[] = [
		{ key: "default", label: t("默认") },
		{ key: "source", label: t("按源文件") },
		{ key: "tag", label: t("按知识点") },
		{ key: "time", label: t("按时间") },
	];
	segBar(el, sortOpts, key => view.reviewSortBy === key, key => {
		view.reviewSortBy = key as "default" | "source" | "tag" | "time";
		void view.renderReviewTab();
	});

	if (dueItems.length === 0) {
		emptyState(el, t("今日暂无待复习内容，继续学习积累吧！"));
		return;
	}

	const filteredDue = view.reviewFilterType === "all" ? dueItems : dueItems.filter(i => i.source === view.reviewFilterType);

	const sourceLabel: Record<string, string> = { wrong: t("错题"), question: t("题目"), note: t("笔记") };
	const sourceColor: Record<string, string> = { wrong: "var(--qg-danger)", question: "var(--interactive-accent)", note: "var(--qg-success)" };

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
	if (view.reviewSortBy === "source") {
		sortedDue.sort((a, b) => (a.note.sourceFile || a.note.baseName).localeCompare(b.note.sourceFile || b.note.baseName));
	} else if (view.reviewSortBy === "tag") {
		sortedDue.sort((a, b) => (knowledgeTags(a.note.tags)[0] || "").localeCompare(knowledgeTags(b.note.tags)[0] || ""));
	} else if (view.reviewSortBy === "time") {
		sortedDue.sort((a, b) => (a.note.nextReview || "").localeCompare(b.note.nextReview || ""));
	} else {
		const priority: Record<string, number> = { wrong: 0, question: 1, note: 2 };
		sortedDue.sort((a, b) => priority[a.source]! - priority[b.source]!);
	}

	const renderItems = (list: ReviewItem[], body: HTMLElement) => {
		for (const item of list) renderReviewRow(view, body, item, sourceLabel, sourceColor);
	};

	if (view.reviewSortBy === "source") {
		const { groups } = groupBySource(sortedDue, i => i.note.sourceFile || i.note.baseName);
for (const g of groups) collapseGroup(el, { title: g.key, countText: tf("{n}项", { n: g.items.length }) }, body => renderItems(g.items, body));
		} else if (view.reviewSortBy === "tag") {
			const { groups, untagged } = groupByTag(sortedDue, i => knowledgeTags(i.note.tags));
			for (const g of groups) collapseGroup(el, { title: g.key, countText: tf("{n}项", { n: g.items.length }) }, body => renderItems(g.items, body));
		if (untagged.length > 0) collapseGroup(el, { title: t("无标签"), countText: tf("{n}项", { n: untagged.length }) }, body => renderItems(untagged, body));
	} else {
		renderItems(sortedDue, el);
	}
}

function renderReviewRow(view: MainSidebarView, container: HTMLElement, item: { note: WrongAnswerNote; source: string }, sourceLabel: Record<string, string>, sourceColor: Record<string, string>) {
	const row = container.createDiv({ cls: "qg-list-item", attr: { style: "display:flex;align-items:center;gap:6px;padding:6px 8px;margin-bottom:4px;border-radius:4px;border:1px solid var(--background-modifier-border);font-size:18px;transition:background 0.15s;" } });
	row.classList.add("qg-hover-bg");
	row.createSpan({ text: sourceLabel[item.source] || item.source, attr: { style: "min-width:32px;font-size:13px;padding:1px 5px;border-radius:3px;background:" + (sourceColor[item.source] || "var(--text-muted)") + ";color:var(--qg-on-chip, var(--text-on-accent));" } });
	const nameText = (item.note.sourceFile || item.note.baseName).replace(/\[\[|\]\]/g, "");
	row.createSpan({ text: nameText, attr: { style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--interactive-accent);" } });
	const kp = knowledgeTags(item.note.tags);
	view.renderKnowledgeTags(row, kp);
	if (item.source === "wrong" && (item.note.wrongCount || 0) > 0) row.createSpan({ text: tf("错{n}次", { n: item.note.wrongCount }), attr: { style: "font-size:15px;color:var(--qg-danger);min-width:36px;text-align:right;flex-shrink:0;" } });
	// 到期（含尚未排期的「新条目」）显示「已到期」；只有排在未来才显示剩余天数。
	if (isDueForReview(item.note)) {
		row.createSpan({ text: t("已到期"), attr: { style: "font-size:15px;color:var(--interactive-accent);font-weight:600;min-width:44px;text-align:right;" } });
	} else if (item.note.nextReview) {
		row.createSpan({ text: tf("{d}天后", { d: daysUntil(item.note.nextReview) }), attr: { style: "font-size:15px;color:var(--text-faint);min-width:44px;text-align:right;" } });
	}
	const qualityBtn = (label: string, q: number, color: string) => {
		const b = row.createEl("button", { text: label, attr: { style: "padding:2px 7px;border-radius:3px;cursor:pointer;font-size:15px;border:1px solid " + color + ";background:transparent;color:" + color + ";white-space:nowrap;flex-shrink:0;" } });
		b.addEventListener("click", (e) => { e.stopPropagation(); void markReviewQuality(view, item.note, item.source as "wrong" | "question" | "note", q); });
	};
	qualityBtn(t("忘记"), QUALITY.forgot, "var(--qg-danger)");
	qualityBtn(t("困难"), QUALITY.hard, "var(--qg-warn)");
	qualityBtn(t("一般"), QUALITY.good, "var(--qg-success)");
	qualityBtn(t("简单"), QUALITY.easy, "var(--qg-info)");
	row.addEventListener("click", () => {
		if (item.source === "wrong") { view.wrongView = "detail"; view.wrongCurrentNote = item.note; view.activeSection = "wrong"; void view.render(); }
		else { void view.app.workspace.openLinkText(item.note.baseName, "", false); }
	});
}

async function markReviewQuality(view: MainSidebarView, note: WrongAnswerNote, source: "wrong" | "question" | "note", quality: number) {
	try {
		const result = await view.updateReviewSchedule(note, source, quality);
		if (quality >= 3) new Notice(tf("已记录！下次复习 {d}（间隔{i}天）", { d: result.nextReview, i: result.interval }));
		else new Notice(t("已记录错误，明天复习"));
		void view.renderReviewTab();
	} catch (err) {
		new Notice(tf("更新复习计划失败：{msg}", { msg: (err as Error).message }));
	}
}
