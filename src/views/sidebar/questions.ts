import { Notice, TFile } from "obsidian";
import { Document, Packer } from "docx";
import * as fs from "fs";
import * as path from "path";

import type { MainSidebarView } from "../sidebarView";
import { SEARCH_DEBOUNCE_MS } from "../../constants";
import { buildWordParagraphs, exportPdfDirect } from "../../utils/exporter";
import { getElectronRemote } from "../../utils/electron";
import { isAbs, readFileStr, listMdFilesRecursive, isExcludedPath, joinPath } from "../../utils/fs-utils";
import { debounce } from "../../utils/debounce";
import { knowledgeTags } from "../../utils/frontmatter";
import { t, tf } from "../../i18n/index";

export async function listQuestionFiles(view: MainSidebarView, folder: string) {
		const excludes = [view.plugin.rootPath(view.plugin.settings.knowledgeFolder)].filter(Boolean);
		const excludeCfg = view.plugin.settings.excludeFolders || "";
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
			return view.app.vault.getFiles().filter(f => f.path.startsWith(prefix) && f.extension === "md" && !exclPrefixes.some(e => f.path.startsWith(e)) && !isExcludedPath(f.path, excludeCfg)).sort((a, b) => (b.stat.mtime || 0) - (a.stat.mtime || 0));
		} catch { return []; }
}

export async function renderQuestionsTab(view: MainSidebarView) {
		if (!view.innerContentEl) return;
		const el = view.innerContentEl;
		el.empty();

		const folder = view.plugin.rootPath(view.plugin.settings.questionFolder);
		if (!folder) { el.createDiv({ text: t("请在设置中配置题目文件夹"), attr: { style: "color:var(--text-muted);text-align:center;padding:30px 0;font-size:20px;" } }); return; }

		const files = await view.listQuestionFiles(folder);

		const allTags = new Set<string>();
		const fileData: { file: TFile; tags: string[] }[] = [];
		for (const file of files) {
			try {
				let content = "";
				if (isAbs(folder)) { content = readFileStr(file.path); } else { content = await view.app.vault.read(file); }
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

		const sortBar = el.createDiv({ cls: "qg-seg-bar", attr: { style: "display:flex;gap:2px;margin-bottom:10px;" } });
		const sortModes: { key: "default" | "source" | "tag" | "time"; label: string }[] = [
			{ key: "default", label: t("默认") },
			{ key: "source", label: t("按源文件") },
			{ key: "tag", label: t("按知识点") },
			{ key: "time", label: t("按时间") },
		];
		for (const m of sortModes) {
			const mb = sortBar.createEl("button", { text: m.label, attr: { style: "padding:3px 8px;border-radius:3px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:" + (view.questionsSortMode === m.key ? "var(--interactive-accent);color:var(--text-on-accent);" : "var(--background-secondary);color:var(--text-muted);") } });
			mb.addEventListener("click", () => { view.questionsSortMode = m.key; void view.renderQuestionsTab(); });
		}

		if (files.length === 0) {
			el.createDiv({ text: t("暂无题目文件"), attr: { style: "color:var(--text-faint);text-align:center;padding:20px 0;font-size:19px;" } });
			return;
		}

		const searchEl = el.createEl("input", { attr: { type: "text", placeholder: t("搜索文件名..."), style: "width:100%;padding:5px 8px;border-radius:4px;border:1px solid var(--background-modifier-border);font-size:18px;margin-bottom:8px;" } });
		view.adminBatchUpdate = view.renderAdminBatchBar(el, fileData.map(fd => fd.file.path), () => {
			const selected = fileData.filter(fd => view.adminSelected.has(fd.file.path)).map(fd => fd.file.path);
			void view.adminDeleteFiles(selected, folder, () => void view.renderQuestionsTab());
		}, () => {
			const selected = fileData.filter(fd => view.adminSelected.has(fd.file.path)).map(fd => fd.file.path);
			void view.adminExportFiles(selected, folder, t("题目批量导出"));
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
				cb.checked = view.adminSelected.has(file.path);
				cb.addEventListener("change", () => { if (cb.checked) view.adminSelected.add(file.path); else view.adminSelected.delete(file.path); view.adminBatchUpdate?.(); });
				const nameEl = item.createSpan({ text: file.name, attr: { style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--interactive-accent);" } });
				nameEl.addEventListener("click", () => { void view.app.workspace.openLinkText(file.path, "", false); });
				const kp = knowledgeTags(fd.tags);
				view.renderKnowledgeTags(item, kp);
				item.createSpan({ text: Math.round(file.stat.size / 1024) + "KB", attr: { style: "font-size:16px;color:var(--text-muted);flex-shrink:0;" } });
				const d = new Date(file.stat.mtime);
				item.createSpan({ text: (d.getMonth() + 1) + "/" + d.getDate(), attr: { style: "font-size:16px;color:var(--text-muted);flex-shrink:0;" } });
				const actRow = item.createDiv({ cls: "qg-seg-bar", attr: { style: "display:flex;gap:2px;flex-shrink:0;" } });
				const actBtn = (label: string, tip: string, cb: () => void) => {
					const b = actRow.createSpan({ text: label, attr: { title: tip, style: "padding:1px 4px;border-radius:3px;cursor:pointer;font-size:16px;" } });
					b.addEventListener("click", (e) => { e.stopPropagation(); cb(); });
				};
				actBtn("📖", t("打开"), () => { void view.app.workspace.openLinkText(file.path, "", false).catch(() => {}); });
				actBtn("✏️", t("答题"), () => {
					void (async () => {
						const content = isAbs(folder) ? readFileStr(file.path) : await view.app.vault.read(file);
						const clean = content.replace(/^---[\s\S]*?---\s*/, "");
						view.startAnswer(clean, file.basename, file.path);
					})();
				});
				actBtn("📒", t("生成笔记"), () => {
					void (async () => {
						const content = isAbs(folder) ? readFileStr(file.path) : await view.app.vault.read(file);
						await view.noteGenStartDirect(file.basename, content.replace(/^---[\s\S]*?---\s*/, ""), file.path);
					})();
				});
				actBtn("📤", t("导出"), () => {
					void (async () => {
						const content = isAbs(folder) ? readFileStr(file.path) : await view.app.vault.read(file);
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
								await view.app.vault.rename(file, newPath);
							}
							new Notice(t("已重命名"));
							void view.renderQuestionsTab();
						} catch (err) { new Notice(tf("重命名失败：{msg}", { msg: (err as Error).message })); }
					})();
				});
				actBtn("🗑", t("删除"), () => {
					void (async () => {
						if (!confirm(tf("确定删除题目文件「{name}」？", { name: file.basename }))) return;
						try {
							if (isAbs(folder)) { fs.unlinkSync(file.path); } else { await view.app.fileManager.trashFile(file); }
							new Notice(t("已删除"));
							void view.renderQuestionsTab();
						} catch (err) { new Notice(tf("删除失败：{msg}", { msg: (err as Error).message })); }
					})();
				});
			};

			if (view.questionsSortMode === "default") {
				for (const fd of filtered) renderFileItem(listEl, fd);
			} else if (view.questionsSortMode === "source") {
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
					const group = listEl.createDiv({ cls: "qg-clip", attr: { style: "margin-bottom:8px;border:1px solid var(--background-modifier-border);border-radius:6px;overflow:hidden;" } });
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
			} else if (view.questionsSortMode === "tag") {
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
					const group = listEl.createDiv({ cls: "qg-clip", attr: { style: "margin-bottom:8px;border:1px solid var(--background-modifier-border);border-radius:6px;overflow:hidden;" } });
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
			} else if (view.questionsSortMode === "time") {
				const sorted = [...filtered].sort((a, b) => (b.file.stat.mtime || 0) - (a.file.stat.mtime || 0));
				for (const fd of sorted) renderFileItem(listEl, fd);
			}
		};
		searchEl.addEventListener("input", debounce(() => renderList(searchEl.value), SEARCH_DEBOUNCE_MS));
		renderList("");
}
