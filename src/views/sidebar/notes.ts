import { Notice, TFile, TFolder } from "obsidian";
import * as fs from "fs";
import * as path from "path";

import type { MainSidebarView } from "../sidebarView";
import { SEARCH_DEBOUNCE_MS } from "../../constants";
import { debounce } from "../../utils/debounce";
import { isAbs, isExcludedPath, ensureFolder, readFileStr, joinPath, writeFileStr } from "../../utils/fs-utils";
import { safeName } from "../../utils/text";
import { buildFM, knowledgeTags } from "../../utils/frontmatter";
import { matchQuery } from "../../utils/list";
import { t, tf } from "../../i18n/index";

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
		const fileData: { file: TFile; tags: string[]; source: string }[] = [];
		for (const file of files) {
			try {
				let content = "";
				if (isAbs(folder)) { content = readFileStr(file.path); } else { content = await view.app.vault.read(file); }
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
		createBtn.addEventListener("click", () => { view.notePickerActive = true; void view.renderNotesTab(); });

		const sortBar = el.createDiv({ cls: "qg-seg-bar", attr: { style: "display:flex;gap:2px;margin-bottom:10px;" } });
		const sortModes: { key: "default" | "source" | "tag" | "time"; label: string }[] = [
			{ key: "default", label: t("默认") },
			{ key: "source", label: t("按源文件") },
			{ key: "tag", label: t("按知识点") },
			{ key: "time", label: t("按时间") },
		];
		for (const m of sortModes) {
			const mb = sortBar.createEl("button", { text: m.label, attr: { style: "padding:3px 8px;border-radius:3px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:" + (view.notesSortMode === m.key ? "var(--interactive-accent);color:var(--text-on-accent);" : "var(--background-secondary);color:var(--text-muted);") } });
			mb.addEventListener("click", () => { view.notesSortMode = m.key; void view.renderNotesTab(); });
		}

		if (files.length === 0) {
			el.createDiv({ text: t("暂无笔记文件"), attr: { style: "color:var(--text-faint);text-align:center;padding:20px 0;font-size:19px;" } });
			return;
		}

		const searchEl = el.createEl("input", { attr: { type: "text", placeholder: t("搜索文件名..."), style: "width:100%;padding:5px 8px;border-radius:4px;border:1px solid var(--background-modifier-border);font-size:18px;margin-bottom:8px;" } });
		searchEl.value = view.listQuery || "";
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

			const renderFileItem = (container: HTMLElement, fd: { file: TFile; tags: string[]; source: string }) => {
				const file = fd.file;
				const item = container.createDiv({ attr: { style: "display:flex;align-items:center;gap:4px;padding:6px 4px;border-bottom:1px solid var(--background-modifier-border);font-size:18px;cursor:pointer;transition:background 0.15s;" } });
				item.classList.add("qg-hover-bg");
				const cb = item.createEl("input", { attr: { type: "checkbox", style: "flex-shrink:0;width:14px;height:14px;cursor:pointer;" } });
				cb.checked = view.adminSelected.has(file.path);
				cb.addEventListener("change", () => { if (cb.checked) view.adminSelected.add(file.path); else view.adminSelected.delete(file.path); view.adminBatchUpdate?.(); });
				const nameEl = item.createSpan({ text: file.name, attr: { style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--interactive-accent);" } });
				nameEl.addEventListener("click", () => { void view.app.workspace.openLinkText(file.path, "", false); });
				const kp = knowledgeTags(fd.tags);
				view.renderKnowledgeTags(item, kp);
				const d = new Date(file.stat.mtime);
				item.createSpan({ text: (d.getMonth() + 1) + "/" + d.getDate(), attr: { style: "font-size:16px;color:var(--text-muted);flex-shrink:0;" } });
				const actRow = item.createDiv({ cls: "qg-seg-bar", attr: { style: "display:flex;gap:2px;flex-shrink:0;" } });
				const actBtn = (label: string, tip: string, cb: () => void) => {
					const b = actRow.createSpan({ text: label, attr: { title: tip, style: "padding:1px 4px;border-radius:3px;cursor:pointer;font-size:16px;" } });
					b.addEventListener("click", (e) => { e.stopPropagation(); cb(); });
				};
				actBtn("📖", t("打开"), () => { void view.app.workspace.openLinkText(file.path, "", false).catch(() => {}); });
				actBtn("📒", t("生成笔记"), () => {
					void (async () => {
						const content = isAbs(folder) ? readFileStr(file.path) : await view.app.vault.read(file);
						await view.noteGenStartDirect(file.basename, content.replace(/^---[\s\S]*?---\s*/, ""), file.path);
					})();
				});
				actBtn("🗑", t("删除"), () => {
					void (async () => {
						if (!confirm(tf("确定删除笔记「{name}」？", { name: file.basename }))) return;
						try {
							if (isAbs(folder)) { fs.unlinkSync(file.path); } else { await view.app.fileManager.trashFile(file); }
							new Notice(t("已删除"));
							void view.renderNotesTab();
						} catch (err) { new Notice(tf("删除失败：{msg}", { msg: (err as Error).message })); }
					})();
				});
			};

			if (view.notesSortMode === "default") {
				for (const fd of filtered) renderFileItem(listEl, fd);
			} else if (view.notesSortMode === "source") {
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
					const group = listEl.createDiv({ cls: "qg-clip", attr: { style: "margin-bottom:8px;border:1px solid var(--background-modifier-border);border-radius:6px;overflow:hidden;" } });
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
			} else if (view.notesSortMode === "tag") {
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
					const group = listEl.createDiv({ cls: "qg-clip", attr: { style: "margin-bottom:8px;border:1px solid var(--background-modifier-border);border-radius:6px;overflow:hidden;" } });
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
			} else if (view.notesSortMode === "time") {
				const sorted = [...filtered].sort((a, b) => (b.file.stat.mtime || 0) - (a.file.stat.mtime || 0));
				for (const fd of sorted) renderFileItem(listEl, fd);
			}
		};
		searchEl.addEventListener("input", debounce(() => { view.listQuery = searchEl.value; renderList(searchEl.value); }, SEARCH_DEBOUNCE_MS));
		renderList("");
}

export function renderNotePicker(view: MainSidebarView, el: HTMLDivElement) {
		const backBtn = el.createEl("button", { text: t("← 返回笔记列表"), attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:19px;margin-bottom:12px;" } });
		backBtn.addEventListener("click", () => { view.notePickerActive = false; void view.renderNotesTab(); });
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
					const dateStr = new Date().toISOString().slice(0, 10);
					const fm = buildFM({ source: "[[" + f.basename + "]]", sourcePath: f.path, date: dateStr, tags: [] });
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

export async function listNoteViewFiles(view: MainSidebarView, folder: string) {
		const excludeCfg = view.plugin.settings.excludeFolders || "";
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
			const tfolder = view.app.vault.getAbstractFileByPath(folder);
			if (!tfolder || !(tfolder instanceof TFolder)) return [];
			return (tfolder.children as TFile[]).filter(f => f instanceof TFile && f.name.endsWith(".md") && !isExcludedPath(f.path, excludeCfg)).sort((a, b) => (b.stat.mtime || 0) - (a.stat.mtime || 0));
		} catch { return []; }
}
