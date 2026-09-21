import { Notice, TFile } from "obsidian";
import { Document, Packer } from "docx";
import * as fs from "fs";

import type { MainSidebarView } from "../sidebarView";
import type { WrongAnswerNote } from "../../types";
import { MAX_UNTAGGED_DISPLAY, SEARCH_DEBOUNCE_MS } from "../../constants";
import { isDueForReview } from "../../utils/review";
import { debounce } from "../../utils/debounce";
import { stripAnswerSummarySection } from "../../utils/layout";
import { extractAnswersForExport } from "../../utils/text";
import { buildWordParagraphs, exportPdfDirect } from "../../utils/exporter";
import { getElectronRemote } from "../../utils/electron";
import { isAbs, joinPath, trashFileAbs, readFileStr, daysUntil } from "../../utils/fs-utils";
import { knowledgeTags } from "../../utils/frontmatter";
import { matchQuery } from "../../utils/list";
import { groupBySource, groupByTag } from "../../utils/listView";
import { segBar, statsBadges, emptyState, searchField, collapseGroup, backButton } from "./shared/ui";
import { openConfirm } from "../ui/modals";
import { t, tf } from "../../i18n/index";
import { localDateStr } from "../../utils/date";
import { QUALITY } from "../../utils/sm2";
import { AddWrongModal } from "../addWrongModal";

export async function renderWrongTab(view: MainSidebarView) {
		if (!view.innerContentEl) return;
		if (view.wrongView === "detail" && view.wrongCurrentNote) {
			view.renderWrongDetail();
		} else {
			await view.renderWrongList();
		}
}

export async function renderWrongList(view: MainSidebarView) {
		if (!view.innerContentEl) return;
		const el = view.innerContentEl;
		el.empty();

		const allNotes = await view.plugin.loadAllWrongNotes();
		const query = (view.listQuery || "").trim();
		const notes = query
			? allNotes.filter(n => matchQuery(query, [n.baseName, n.sourceFile, n.sourcePath, ...n.tags, n.resultText.slice(0, 300)]))
			: allNotes;
		view.wrongNotes = allNotes;
		const dueNotes = notes.filter((n: WrongAnswerNote) => isDueForReview(n));

		statsBadges(el, [
			{ text: tf("{label} {n}", { label: t("错题"), n: notes.length }), tone: "danger" },
			{ text: tf("{label} {n}", { label: t("待复习"), n: dueNotes.length }), tone: "warn" },
		]);

		const sortModes: { key: "default" | "source" | "tag" | "time"; label: string }[] = [
			{ key: "default", label: t("默认") },
			{ key: "source", label: t("按源文件") },
			{ key: "tag", label: t("按知识点") },
			{ key: "time", label: t("按时间") },
		];
		segBar(el, sortModes.map(m => ({ key: m.key, label: m.label })), key => view.wrongSortMode === key, key => {
			view.wrongSortMode = key as "default" | "source" | "tag" | "time";
			void view.renderWrongTab();
		});

		searchField(el, t("搜索错题（文件名/来源/知识点/内容）..."), view.listQuery || "", debounce((v: string) => {
			view.listQuery = v;
			void view.renderWrongTab();
		}, SEARCH_DEBOUNCE_MS));

		const addRow = el.createDiv({ attr: { style: "display:flex;gap:6px;margin-bottom:10px;" } });
		const addBtn = addRow.createEl("button", { text: t("＋ 添加错题"), attr: { style: "padding:5px 12px;border-radius:4px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
		addBtn.addEventListener("click", () => { new AddWrongModal(view.app, view).open(); });

		if (dueNotes.length > 0) {
			const dueBtn = el.createDiv({ attr: { style: "padding:10px;margin-bottom:10px;border-radius:6px;border:2px solid var(--interactive-accent);background:color-mix(in srgb, var(--interactive-accent) 5%, transparent);cursor:pointer;text-align:center;font-weight:600;font-size:19px;" } });
			dueBtn.setText(tf("开始今日复习 ({n}题)", { n: dueNotes.length }));
			dueBtn.addEventListener("click", () => { view.wrongView = "detail"; view.wrongCurrentNote = dueNotes[0]!; void view.renderWrongTab(); });
		}

		const listEl = el.createDiv({});

		view.adminBatchUpdate = view.renderAdminBatchBar(el, notes.map(n => n.filePath), () => {
			void (async () => {
				const selected = notes.filter(n => view.adminSelected.has(n.filePath)).map(n => n.filePath);
				if (selected.length === 0) return;
				const ok = await openConfirm(view.app, { text: tf("确定删除选中的 {n} 个错题记录？此操作不可撤销。", { n: selected.length }) });
				if (!ok) return;
				// 批量删除时跳过逐条重建，循环结束后统一重建一次索引
				for (const p of selected) { try { await view.plugin.deleteWrongNote(p, true); } catch { /* skip */ } }
				try { await view.plugin.rebuildKnowledgeIndex(); } catch { /* skip */ }
				for (const p of selected) view.adminSelected.delete(p);
				new Notice(tf("已删除 {n} 个错题记录", { n: selected.length }));
				void view.renderWrongTab();
			})();
		}, () => {
			const selected = notes.filter(n => view.adminSelected.has(n.filePath)).map(n => n.filePath);
			void view.adminExportFiles(selected, view.plugin.rootPath(view.plugin.settings.wrongBookFolder), t("错题批量导出"));
		});

		if (view.wrongSortMode === "default") {
			for (const note of notes) view.renderWrongNoteItem(listEl, note);
		} else if (view.wrongSortMode === "time") {
			const sorted = [...notes].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
			for (const note of sorted) view.renderWrongNoteItem(listEl, note);
		} else if (view.wrongSortMode === "source") {
			const { groups, noSource } = groupBySource(notes, n => n.sourceFile || "");
			for (const g of groups) collapseGroup(listEl, { title: g.key, countText: tf("{n}题", { n: g.items.length }) }, body => {
				for (const note of g.items) view.renderWrongNoteItem(body, note);
			});
			if (noSource.length > 0) collapseGroup(listEl, { title: t("未分类"), countText: tf("{n}题", { n: noSource.length }) }, body => {
				for (const note of noSource) view.renderWrongNoteItem(body, note);
			});
		} else {
			const { groups, untagged } = groupByTag(notes, n => knowledgeTags(n.tags));
			for (const g of groups) collapseGroup(listEl, { title: "#" + g.key, countText: tf("{n}题", { n: g.items.length }) }, body => {
				for (const note of g.items) view.renderWrongNoteItem(body, note);
			});
			if (untagged.length > 0) collapseGroup(listEl, { title: t("未分类"), countText: tf("{n}题", { n: Math.min(untagged.length, MAX_UNTAGGED_DISPLAY) }) }, body => {
				for (const note of untagged.slice(0, MAX_UNTAGGED_DISPLAY)) view.renderWrongNoteItem(body, note);
				if (untagged.length > MAX_UNTAGGED_DISPLAY) body.createDiv({ text: tf("还有{n}题...", { n: untagged.length - MAX_UNTAGGED_DISPLAY }), attr: { style: "font-size:17px;color:var(--text-muted);text-align:center;padding:6px;" } });
			});
		}

	if (notes.length === 0) {
		emptyState(el, t("暂无错题记录"));
	}
}

export function renderWrongNoteItem(view: MainSidebarView, container: HTMLElement, note: WrongAnswerNote) {
		const item = container.createDiv({ cls: "qg-list-item", attr: { style: "display:flex;align-items:center;gap:6px;padding:6px 8px;margin-bottom:4px;border-radius:4px;border:1px solid var(--background-modifier-border);font-size:18px;cursor:pointer;transition:background 0.15s;" } });
		const cb = item.createEl("input", { attr: { type: "checkbox", style: "flex-shrink:0;width:14px;height:14px;cursor:pointer;" } });
		cb.checked = view.adminSelected.has(note.filePath);
		cb.addEventListener("change", (e) => {
			e.stopPropagation();
			if (cb.checked) view.adminSelected.add(note.filePath); else view.adminSelected.delete(note.filePath);
			view.adminBatchUpdate?.();
		});
		const nameText = (note.sourceFile || note.baseName).replace(/\[\[|\]\]/g, "");
		const nameEl = item.createSpan({ text: nameText, attr: { style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--interactive-accent);cursor:pointer;" } });
		nameEl.addEventListener("click", (e) => {
			e.stopPropagation();
			const noteFile = view.app.vault.getFiles().find(f => f.path === note.filePath || f.basename === note.baseName);
			if (noteFile) { view.app.workspace.openLinkText(noteFile.path, "", false).catch(() => {}); return; }
			const srcFile = view.app.vault.getFiles().find(f => f.basename === nameText || f.name === nameText);
			if (srcFile) view.app.workspace.openLinkText(srcFile.path, "", false).catch(() => {});
			else new Notice(tf("找不到文件：{name}", { name: nameText }));
		});
		if (note.tags.length > 0) {
			const kTags = knowledgeTags(note.tags);
			view.renderKnowledgeTags(item, kTags);
		}
		if ((note.wrongCount || 0) > 0) item.createSpan({ text: tf("错{n}次", { n: note.wrongCount }), attr: { style: "font-size:16px;color:var(--qg-danger);min-width:36px;text-align:right;flex-shrink:0;" } });
		// 到期（含尚未排期的「新条目」）显示「已到期」；只有排在未来才显示剩余天数。
		if (isDueForReview(note)) {
			item.createSpan({ text: t("已到期"), attr: { style: "font-size:16px;color:var(--interactive-accent);font-weight:600;min-width:40px;text-align:right;flex-shrink:0;" } });
		} else if (note.nextReview) {
			item.createSpan({ text: tf("{d}天后", { d: daysUntil(note.nextReview) }), attr: { style: "font-size:16px;color:var(--text-faint);min-width:40px;text-align:right;flex-shrink:0;" } });
		}
		const genBtn = item.createSpan({ text: "📒", attr: { title: t("生成笔记"), style: "padding:1px 4px;border-radius:3px;cursor:pointer;font-size:16px;color:var(--interactive-accent);flex-shrink:0;" } });
		genBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			void view.noteGenStartDirect((note.sourceFile || note.baseName).replace(/\[\[|\]\]/g, ""), note.resultText, note.sourcePath || note.filePath);
		});
		const delBtn = item.createSpan({ text: "×", cls: "qg-note-del" });
		delBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			void (async () => {
				const ok = await openConfirm(view.app, { text: t("确定从错题本移除？") });
				if (!ok) return;
				await view.plugin.deleteWrongNote(note.filePath);
				void view.renderWrongTab();
			})();
		});
		item.classList.add("qg-hover-bg");
}

export function renderWrongDetail(view: MainSidebarView) {
		if (!view.innerContentEl || !view.wrongCurrentNote) return;
		const el = view.innerContentEl;
		el.empty();
		const note = view.wrongCurrentNote;

		backButton(el, () => { view.wrongView = "list"; view.wrongCurrentNote = null; void view.renderWrongTab(); }, t("← 返回列表"));

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
			const noteFile = view.app.vault.getFiles().find(f => f.path === note.filePath || f.basename === note.baseName);
			if (noteFile) { view.app.workspace.openLinkText(noteFile.path, "", false).catch(() => {}); }
			else new Notice(t("找不到错题文件"));
		});
		actBtn(t("开始答题"), "", () => {
			if (!note.resultText) { new Notice(t("无题目内容")); return; }
			view.startAnswer(note.resultText, note.sourceFile || note.baseName, note.sourcePath || "");
		});
		actBtn(t("基于原文重新生成"), "", () => { void view.wrongRePracticeSingle(note); });
		actBtn(t("导出MD"), "", () => { void view.wrongExportNote(note, "md"); });
		actBtn(t("导出Word"), "", () => { void view.wrongExportNote(note, "word"); });
		actBtn(t("导出PDF"), "", () => { void view.wrongExportNote(note, "pdf"); });
		actBtn(t("导出仅答案"), "", () => { void view.wrongExportAnswerOnly(note); });
		actBtn(t("删除"), "mod-warning", () => { void view.wrongDeleteNote(note); });

		const due = isDueForReview(note);
		const reviewSection = el.createDiv({ attr: { style: "margin-top:12px;padding:12px;border-radius:8px;border:1px solid " + (due ? "var(--interactive-accent)" : "var(--background-modifier-border)") + ";background:" + (due ? "color-mix(in srgb, var(--interactive-accent) 5%, transparent)" : "var(--background-secondary)") + ";" } });
		const dueInfo = due ? t("已到复习时间") : tf("下次复习: {d}", { d: note.nextReview || t("未设置") });
		const correctCount = note.correctCount || 0;
		const wrongCount = note.wrongCount || 0;
		reviewSection.createDiv({ text: dueInfo + tf("　间隔: {i}天　答对{c}次　答错{w}次", { i: note.interval, c: correctCount, w: wrongCount }), attr: { style: "font-size:18px;color:var(--text-muted);margin-bottom:8px;" } });
		reviewSection.createDiv({ text: t("评分（决定下次复习间隔）："), attr: { style: "font-size:19px;font-weight:600;margin-bottom:8px;" } });
		const qRow = reviewSection.createDiv({ attr: { style: "display:flex;gap:8px;flex-wrap:wrap;" } });
		const qualityBtn = (label: string, q: number, color: string) => {
			const b = qRow.createEl("button", { text: label, attr: { style: "padding:6px 14px;border-radius:4px;cursor:pointer;font-size:18px;border:2px solid " + color + ";background:var(--background-secondary);color:" + color + ";font-weight:600;" } });
			b.addEventListener("click", () => { void view.wrongUpdateScheduling(note, q); });
		};
		qualityBtn(t("忘记"), QUALITY.forgot, "var(--qg-danger)");
		qualityBtn(t("困难"), QUALITY.hard, "var(--qg-warn)");
		qualityBtn(t("一般"), QUALITY.good, "var(--qg-success)");
		qualityBtn(t("简单"), QUALITY.easy, "var(--qg-info)");
}

export async function wrongDeleteNote(view: MainSidebarView, note: WrongAnswerNote) {
		const ok = await openConfirm(view.app, { text: t("确定删除这条错题记录？此操作不可撤销。") });
		if (!ok) return;
		if (isAbs(note.filePath)) await trashFileAbs(note.filePath);
		else { const file = view.app.vault.getAbstractFileByPath(note.filePath); if (file instanceof TFile) await view.app.fileManager.trashFile(file); }
		new Notice(t("已删除"));
		view.plugin.emitDataChanged();
		view.wrongView = "list";
		view.wrongCurrentNote = null;
		await view.renderWrongTab();
}

export async function wrongRePracticeSingle(view: MainSidebarView, note: WrongAnswerNote) {
		const srcName = note.sourceFile.replace(/\[\[|\]\]/g, "");
		let sourceText = "";
		let found = false;
		let srcPath = "";
		const src = view.app.vault.getFiles().find(f => f.basename === srcName || f.name === srcName);
		if (src) { sourceText = await view.app.vault.read(src); found = true; srcPath = src.path; }
		else if (isAbs(view.plugin.rootPath(view.plugin.settings.questionFolder))) {
			const qDir = view.plugin.rootPath(view.plugin.settings.questionFolder);
			if (fs.existsSync(qDir)) {
				for (const f of fs.readdirSync(qDir)) {
					if (f.includes(srcName) && f.endsWith(".md")) { sourceText = readFileStr(joinPath(qDir, f)); found = true; srcPath = joinPath(qDir, f); break; }
				}
			}
		}
		if (found) { view.startGenerate(sourceText, srcName, srcPath); }
		else new Notice(t("源文件不存在"));
}

export async function wrongRePracticeDue(view: MainSidebarView) {
		const dueNotes = view.wrongNotes.filter(n => isDueForReview(n));
		const sources: string[] = [];
		const paths: string[] = [];
		for (const note of dueNotes) {
			const srcName = note.sourceFile.replace(/\[\[|\]\]/g, "");
			const src = view.app.vault.getFiles().find(f => f.basename === srcName || f.name === srcName);
			if (src) { sources.push(await view.app.vault.read(src)); paths.push(src.path); }
			else if (isAbs(view.plugin.rootPath(view.plugin.settings.questionFolder))) {
				const qDir = view.plugin.rootPath(view.plugin.settings.questionFolder);
				if (fs.existsSync(qDir)) { for (const f of fs.readdirSync(qDir)) { if (f.includes(srcName) && f.endsWith(".md")) { sources.push(readFileStr(joinPath(qDir, f))); paths.push(joinPath(qDir, f)); break; } } }
			}
		}
		if (sources.length === 0) { new Notice(t("没有可用的源文件")); return; }
		view.startGenerate(sources.join("\n\n---\n\n"), t("今日待复习题目"), paths.join(","));
}

export async function wrongExportNote(view: MainSidebarView, note: WrongAnswerNote, format: "md" | "word" | "pdf") {
		try {
			
			const dateStr = note.date || localDateStr();
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

export async function wrongExportAnswerOnly(view: MainSidebarView, note: WrongAnswerNote) {
	try {
		const answerText = extractAnswersForExport(note.resultText);
		if (!answerText) { new Notice(t("没有可提取的答案")); return; }
		const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: note.baseName + "_仅答案.md", filters: [{ name: "Markdown", extensions: ["md"] }] });
		if (r.canceled || !r.filePath) return;
		fs.writeFileSync(r.filePath, "# " + note.baseName + t(" 仅答案") + "\n\n" + answerText, "utf-8");
		new Notice(t("仅答案版已保存"));
	} catch (err) { new Notice(tf("导出失败：{msg}", { msg: (err as Error).message })); }
}
