import { Notice, TFile, TFolder } from "obsidian";
import * as fs from "fs";
import * as path from "path";

import type { MainSidebarView } from "../sidebarView";
import type { FileMeta } from "../../types";
import { SEARCH_DEBOUNCE_MS } from "../../constants";
import { debounce } from "../../utils/debounce";
import { isAbs, isExcludedPath, ensureFolder, readFileStr, joinPath, writeFileStr } from "../../utils/fs-utils";
import { safeName } from "../../utils/text";
import { buildFM, knowledgeTags } from "../../utils/frontmatter";
import { matchQuery } from "../../utils/list";
import { groupBySource, groupByTag, formatDateShort } from "../../utils/listView";
import { segBar, statsBadges, emptyState, searchField, collapseGroup, backButton } from "./shared/ui";
import { openConfirm } from "../ui/modals";
import { t, tf } from "../../i18n/index";
import { localDateStr, addDaysStr } from "../../utils/date";
import { clampEase } from "../../utils/sm2";

export async function renderNotesTab(view: MainSidebarView) {
		if (!view.innerContentEl) return;
		const el = view.innerContentEl;
		el.empty();

		if (view.notePickerActive) {
			view.renderNotePicker(el);
			return;
		}

		const folder = view.plugin.rootPath(view.plugin.settings.noteViewFolder);
		if (!folder) { el.createDiv({ text: t("请在设置中配置笔记文件夹"), attr: { style: "color:var(--text-muted);text-align:center;padding:30px 0;font-size:20px;" } }); return; }

		const files = await view.listNoteViewFiles(folder);

		const allTags = new Set<string>();
		const fileData: { file: FileMeta; tags: string[]; source: string }[] = [];
		for (const file of files) {
			try {
				const content = await view.readFileText(file);
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

		statsBadges(el, [
			{ text: tf("{label} {n}", { label: t("笔记"), n: files.length }), tone: "success" },
			{ text: tf("{label} {n}", { label: t("知识点"), n: allTags.size }), tone: "accent" },
		]);

		const actionRow = el.createDiv({ attr: { style: "display:flex;gap:6px;margin-bottom:10px;" } });
		const createBtn = actionRow.createEl("button", { text: t("从文件创建笔记"), attr: { style: "padding:5px 12px;border-radius:4px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
		createBtn.addEventListener("click", () => { view.notePickerActive = true; void view.renderNotesTab(); });

		const sortModes: { key: "default" | "source" | "tag" | "time"; label: string }[] = [
			{ key: "default", label: t("默认") },
			{ key: "source", label: t("按源文件") },
			{ key: "tag", label: t("按知识点") },
			{ key: "time", label: t("按时间") },
		];
		segBar(el, sortModes.map(m => ({ key: m.key, label: m.label })), key => view.notesSortMode === key, key => {
			view.notesSortMode = key as "default" | "source" | "tag" | "time";
			void view.renderNotesTab();
		});

		if (files.length === 0) {
			emptyState(el, t("暂无笔记文件"));
			return;
		}

		searchField(el, t("搜索文件名..."), view.listQuery || "", debounce((v: string) => {
			view.listQuery = v;
			renderList(v);
		}, SEARCH_DEBOUNCE_MS));
		view.adminBatchUpdate = view.renderAdminBatchBar(el, fileData.map(fd => fd.file.path), () => {
			const selected = fileData.filter(fd => view.adminSelected.has(fd.file.path)).map(fd => fd.file.path);
			void view.adminDeleteFiles(selected, folder, () => void view.renderNotesTab());
		}, () => {
			const selected = fileData.filter(fd => view.adminSelected.has(fd.file.path)).map(fd => fd.file.path);
			void view.adminExportFiles(selected, folder, t("笔记批量导出"));
		});
		const listEl = el.createDiv({});

		const renderList = (query: string) => {
			listEl.empty();
			const q = query.toLowerCase();
			const filtered = q ? fileData.filter(fd => matchQuery(q, [fd.file.name, fd.file.basename, fd.file.path, fd.source, ...fd.tags])) : fileData;

			const renderFileItem = (container: HTMLElement, fd: { file: FileMeta; tags: string[]; source: string }) => {
				const file = fd.file;
				const item = container.createDiv({ cls: "qg-list-item", attr: { style: "display:flex;align-items:center;gap:4px;padding:6px 8px;margin-bottom:4px;font-size:18px;cursor:pointer;transition:background 0.15s;" } });
				item.classList.add("qg-hover-bg");
				const cb = item.createEl("input", { attr: { type: "checkbox", style: "flex-shrink:0;width:14px;height:14px;cursor:pointer;" } });
				cb.checked = view.adminSelected.has(file.path);
				cb.addEventListener("change", () => { if (cb.checked) view.adminSelected.add(file.path); else view.adminSelected.delete(file.path); view.adminBatchUpdate?.(); });
				const nameEl = item.createSpan({ text: file.name, attr: { style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--interactive-accent);" } });
				nameEl.addEventListener("click", () => { void view.app.workspace.openLinkText(file.path, "", false); });
				const kp = knowledgeTags(fd.tags);
				view.renderKnowledgeTags(item, kp);
				item.createSpan({ text: formatDateShort(file.stat.mtime), attr: { style: "font-size:16px;color:var(--text-muted);flex-shrink:0;" } });
				const actRow = item.createDiv({ cls: "qg-seg-bar", attr: { style: "display:flex;gap:2px;flex-shrink:0;" } });
				const actBtn = (label: string, tip: string, cb: () => void) => {
					const b = actRow.createSpan({ text: label, attr: { title: tip, style: "padding:1px 4px;border-radius:3px;cursor:pointer;font-size:16px;" } });
					b.addEventListener("click", (e) => { e.stopPropagation(); cb(); });
				};
				actBtn("📖", t("打开"), () => { void view.app.workspace.openLinkText(file.path, "", false).catch(() => {}); });
				actBtn("📒", t("生成笔记"), () => {
					void (async () => {
						const content = await view.readFileText(file);
						await view.noteGenStartDirect(file.basename, content.replace(/^---[\s\S]*?---\s*/, ""), file.path);
					})();
				});
				actBtn("🗑", t("删除"), () => {
					void (async () => {
						const ok = await openConfirm(view.app, { text: tf("确定删除笔记「{name}」？", { name: file.basename }) });
						if (!ok) return;
						try {
							await view.trashListFile(file);
							new Notice(t("已删除"));
							void view.renderNotesTab();
						} catch (err) { new Notice(tf("删除失败：{msg}", { msg: (err as Error).message })); }
					})();
				});
			};

			if (view.notesSortMode === "default") {
				for (const fd of filtered) renderFileItem(listEl, fd);
			} else if (view.notesSortMode === "source") {
				const { groups, noSource } = groupBySource(filtered, fd => fd.source || fd.file.basename);
				for (const g of groups) collapseGroup(listEl, { title: g.key, countText: tf("{n}篇", { n: g.items.length }) }, body => {
					for (const fd of g.items) renderFileItem(body, fd);
				});
				if (noSource.length > 0) collapseGroup(listEl, { title: t("未分类"), countText: tf("{n}篇", { n: noSource.length }) }, body => {
					for (const fd of noSource) renderFileItem(body, fd);
				});
			} else if (view.notesSortMode === "tag") {
				const { groups, untagged } = groupByTag(filtered, fd => knowledgeTags(fd.tags));
				for (const g of groups) collapseGroup(listEl, { title: "#" + g.key, countText: tf("{n}篇", { n: g.items.length }) }, body => {
					for (const fd of g.items) renderFileItem(body, fd);
				});
				if (untagged.length > 0) collapseGroup(listEl, { title: t("未分类"), countText: tf("{n}篇", { n: untagged.length }) }, body => {
					for (const fd of untagged) renderFileItem(body, fd);
				});
			} else if (view.notesSortMode === "time") {
				const sorted = [...filtered].sort((a, b) => (b.file.stat.mtime || 0) - (a.file.stat.mtime || 0));
				for (const fd of sorted) renderFileItem(listEl, fd);
			}
		};
		renderList("");
}

export function renderNotePicker(view: MainSidebarView, el: HTMLDivElement) {
		backButton(el, () => { view.notePickerActive = false; void view.renderNotesTab(); }, t("← 返回笔记列表"));
		el.createDiv({ text: t("选择要加入笔记库的文件"), attr: { style: "font-size:21px;font-weight:bold;margin-bottom:8px;" } });

		const excludeList = view.buildExcludeList();
		view.fpAllFiles = view.app.vault.getFiles().filter(f => {
			if (f.extension !== "md") return false;
			const lowerPath = f.path.toLowerCase();
			for (const ex of excludeList) {
				if (lowerPath.includes(ex.toLowerCase() + "/") || lowerPath.startsWith(ex.toLowerCase())) return false;
			}
			return true;
		});

		const infoEl = el.createDiv({ attr: { style: "color:var(--text-muted);font-size:18px;margin-bottom:8px;" } });
		infoEl.setText(tf("共 {a} 个文档，已选 {b} 个", { a: view.fpAllFiles.length, b: view.fpSelected.size }));

		const searchDiv = el.createDiv({ attr: { style: "margin-bottom:8px;" } });
		const searchInput = searchDiv.createEl("input", { attr: { type: "text", placeholder: t("搜索文件名..."), style: "width:100%;padding:6px 8px;border-radius:4px;border:1px solid var(--background-modifier-border);" } });

		const toolBar = el.createDiv({ attr: { style: "margin-bottom:8px;display:flex;gap:6px;" } });
		const toolBtn = (label: string, cb: () => void) => {
			const b = toolBar.createEl("button", { text: label, attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
			b.addEventListener("click", cb);
		};
		toolBtn(t("全选"), () => { view.fpAllFiles.forEach(f => view.fpSelected.add(f.path)); rerender(); });
		toolBtn(t("取消全选"), () => { view.fpSelected.clear(); rerender(); });

		const listEl = el.createDiv({ attr: { style: "max-height:450px;overflow-y:auto;" } });
		const btnRow = el.createDiv({ attr: { style: "margin-top:12px;display:flex;gap:8px;" } });
		const confirmBtn = btnRow.createEl("button", { text: tf("创建笔记 ({n}个)", { n: 0 }), attr: { class: "mod-cta", style: "padding:6px 16px;border-radius:4px;cursor:pointer;font-size:19px;" } });
		const updateConfirm = () => { confirmBtn.setText(tf("创建笔记 ({n}个)", { n: view.fpSelected.size })); };
		const rerender = () => { view.renderSelectTree(listEl, searchInput, infoEl, view.fpAllFiles, view.fpSelected, rerender, updateConfirm, view.notePickerExpanded); updateConfirm(); };
		searchInput.addEventListener("input", debounce(() => rerender(), SEARCH_DEBOUNCE_MS));
		rerender();
		confirmBtn.addEventListener("click", () => {
			void (async () => {
				const chosen = view.fpAllFiles.filter(f => view.fpSelected.has(f.path));
				if (chosen.length === 0) { new Notice(t("请至少选择一个文件")); return; }
				const noteFolder = view.plugin.rootPath(view.plugin.settings.noteViewFolder);
				await ensureFolder(view.app, noteFolder);
				const useFs = isAbs(noteFolder);
				let count = 0;
				for (const f of chosen) {
					const content = useFs ? readFileStr(f.path) : await view.app.vault.read(f);
					const dateStr = localDateStr();
					const fm = buildFM({ source: "[[" + f.basename + "]]", sourcePath: f.path, date: dateStr, tags: [], nextReview: addDaysStr(dateStr, 1), interval: 1, correctCount: 0, wrongCount: 0, easeFactor: clampEase(view.plugin.settings.noteEaseFactor), repetitions: 0, lapses: 0 });
					const noteFileName = safeName(f.basename) + "_笔记_" + dateStr + ".md";
					if (useFs) {
						const fp = joinPath(noteFolder, noteFileName);
						try { writeFileStr(fp, fm + content); count++; }
						catch { try { writeFileStr(joinPath(noteFolder, safeName(f.basename) + "_笔记_" + Date.now() + ".md"), fm + content); count++; } catch { /* skip */ } }
					} else {
						const notePath = noteFolder + "/" + noteFileName;
						try { await view.app.vault.create(notePath, fm + content); count++; }
						catch { try { await view.app.vault.create(noteFolder + "/" + safeName(f.basename) + "_笔记_" + Date.now() + ".md", fm + content); count++; } catch { /* skip */ } }
					}
				}
				new Notice(tf("已创建 {n} 个笔记", { n: count }));
				view.notePickerActive = false;
				view.fpSelected.clear();
				void view.renderNotesTab();
			})();
		});
}

export async function listNoteViewFiles(view: MainSidebarView, folder: string): Promise<FileMeta[]> {
		const excludeCfg = view.plugin.settings.excludeFolders || "";
		if (isAbs(folder)) {
			try {
				if (!fs.existsSync(folder)) return [];
				const files = fs.readdirSync(folder).filter((f: string) => f.endsWith(".md"));
				return files.map((f: string) => {
					const fp = path.join(folder, f);
					const stat = fs.statSync(fp);
					return { name: f, path: fp, basename: f.replace(/\.md$/, ""), extension: "md", stat: { mtime: stat.mtimeMs, size: stat.size } };
				}).filter(f => !isExcludedPath(f.path, excludeCfg)).sort((a, b) => (b.stat.mtime || 0) - (a.stat.mtime || 0));
			} catch { return []; }
		}
		try {
			const tfolder = view.app.vault.getAbstractFileByPath(folder);
			if (!tfolder || !(tfolder instanceof TFolder)) return [];
			return tfolder.children.filter((f): f is TFile => f instanceof TFile && f.name.endsWith(".md") && !isExcludedPath(f.path, excludeCfg)).sort((a, b) => (b.stat.mtime || 0) - (a.stat.mtime || 0));
		} catch { return []; }
}
