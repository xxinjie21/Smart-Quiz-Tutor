import { Notice } from "obsidian";
import { Document, Packer } from "docx";
import * as fs from "fs";
import * as path from "path";

import type { MainSidebarView } from "../sidebarView";
import type { FileMeta } from "../../types";
import { SEARCH_DEBOUNCE_MS } from "../../constants";
import { buildWordParagraphs, exportPdfDirect } from "../../utils/exporter";
import { getElectronRemote } from "../../utils/electron";
import { isAbs, listMdFilesRecursive, isExcludedPath } from "../../utils/fs-utils";
import { debounce } from "../../utils/debounce";
import { knowledgeTags } from "../../utils/frontmatter";
import { safeName } from "../../utils/text";
import { matchQuery } from "../../utils/list";
import { groupBySource, groupByTag, formatFileSize, formatDateShort } from "../../utils/listView";
import { segBar, statsBadges, emptyState, searchField, collapseGroup } from "./shared/ui";
import { openInput, openConfirm } from "../ui/modals";
import { t, tf } from "../../i18n/index";

export async function listQuestionFiles(view: MainSidebarView, folder: string): Promise<FileMeta[]> {
		const excludes = [view.plugin.rootPath(view.plugin.settings.knowledgeFolder)].filter(Boolean);
		const excludeCfg = view.plugin.settings.excludeFolders || "";
		if (isAbs(folder)) {
			try {
				if (!fs.existsSync(folder)) return [];
				const files = listMdFilesRecursive(folder, excludes);
				return files.map((fp: string) => {
					const stat = fs.statSync(fp);
					return { name: path.basename(fp), path: fp, basename: path.basename(fp).replace(/\.md$/, ""), extension: "md", stat: { mtime: stat.mtimeMs, size: stat.size } };
				}).filter(f => !isExcludedPath(f.path, excludeCfg)).sort((a, b) => (b.stat.mtime || 0) - (a.stat.mtime || 0));
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
		const fileData: { file: FileMeta; tags: string[] }[] = [];
		for (const file of files) {
			try {
				const content = await view.readFileText(file);
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

		statsBadges(el, [
			{ text: tf("{label} {n}", { label: t("题目"), n: files.length }), tone: "accent" },
			{ text: tf("{label} {n}", { label: t("知识点"), n: allTags.size }), tone: "success" },
		]);

		const sortModes: { key: "default" | "source" | "tag" | "time"; label: string }[] = [
			{ key: "default", label: t("默认") },
			{ key: "source", label: t("按源文件") },
			{ key: "tag", label: t("按知识点") },
			{ key: "time", label: t("按时间") },
		];
		segBar(el, sortModes.map(m => ({ key: m.key, label: m.label })), key => view.questionsSortMode === key, key => {
			view.questionsSortMode = key as "default" | "source" | "tag" | "time";
			void view.renderQuestionsTab();
		});

		if (files.length === 0) {
			emptyState(el, t("暂无题目文件"));
			return;
		}

		searchField(el, t("搜索文件名..."), view.listQuery || "", debounce((v: string) => {
			view.listQuery = v;
			renderList(v);
		}, SEARCH_DEBOUNCE_MS));
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
			const filtered = q ? fileData.filter(fd => matchQuery(q, [fd.file.name, fd.file.basename, fd.file.path, ...fd.tags])) : fileData;

			const renderFileItem = (container: HTMLElement, fd: { file: FileMeta; tags: string[] }) => {
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
				item.createSpan({ text: formatFileSize(file.stat.size), attr: { style: "font-size:16px;color:var(--text-muted);flex-shrink:0;" } });
				item.createSpan({ text: formatDateShort(file.stat.mtime), attr: { style: "font-size:16px;color:var(--text-muted);flex-shrink:0;" } });
				const actRow = item.createDiv({ cls: "qg-seg-bar", attr: { style: "display:flex;gap:2px;flex-shrink:0;" } });
				const actBtn = (label: string, tip: string, cb: () => void) => {
					const b = actRow.createSpan({ text: label, attr: { title: tip, style: "padding:1px 4px;border-radius:3px;cursor:pointer;font-size:16px;" } });
					b.addEventListener("click", (e) => { e.stopPropagation(); cb(); });
				};
				actBtn("📖", t("打开"), () => { void view.app.workspace.openLinkText(file.path, "", false).catch(() => {}); });
				actBtn("✏️", t("答题"), () => {
					void (async () => {
						const content = await view.readFileText(file);
						const clean = content.replace(/^---[\s\S]*?---\s*/, "");
						view.startAnswer(clean, file.basename, file.path);
					})();
				});
				actBtn("📒", t("生成笔记"), () => {
					void (async () => {
						const content = await view.readFileText(file);
						await view.noteGenStartDirect(file.basename, content.replace(/^---[\s\S]*?---\s*/, ""), file.path);
					})();
				});
				actBtn("📤", t("导出"), () => {
					void (async () => {
						// remote 不可用 / 写盘失败 / PDF 打印失败都要给出提示，
						// 否则这个 `void (async () => …)()` 会留下未处理的 rejection。
						try {
							const content = await view.readFileText(file);
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
						} catch (err) { new Notice(tf("导出失败：{msg}", { msg: (err as Error).message })); }
					})();
				});
				actBtn("✏", t("重命名"), () => {
					void (async () => {
						const input = await openInput(view.app, { title: t("输入新文件名（不含扩展号）："), initial: file.basename });
						// 输入框内容是不可信的：先按 safeName 归一化，避免 `a/b` 把文件挪进子目录、
						// `../../x` 把它移出原目录（详见 renameListFile 的注释）。
						const newName = safeName((input ?? "").trim());
						if (!newName || newName === file.basename) return;
						try {
							await view.renameListFile(file, newName);
							new Notice(t("已重命名"));
							void view.renderQuestionsTab();
						} catch (err) { new Notice(tf("重命名失败：{msg}", { msg: (err as Error).message })); }
					})();
				});
				actBtn("🗑", t("删除"), () => {
					void (async () => {
						const ok = await openConfirm(view.app, { text: tf("确定删除题目文件「{name}」？", { name: file.basename }) });
						if (!ok) return;
						try {
							await view.trashListFile(file);
							new Notice(t("已删除"));
							void view.renderQuestionsTab();
						} catch (err) { new Notice(tf("删除失败：{msg}", { msg: (err as Error).message })); }
					})();
				});
			};

			if (view.questionsSortMode === "default") {
				for (const fd of filtered) renderFileItem(listEl, fd);
			} else if (view.questionsSortMode === "source") {
				const { groups, noSource } = groupBySource(filtered, fd => fd.file.basename.replace(/_试题.*$/, ""));
				for (const g of groups) collapseGroup(listEl, { title: g.key, countText: tf("{n}题", { n: g.items.length }) }, body => {
					for (const fd of g.items) renderFileItem(body, fd);
				});
				if (noSource.length > 0) collapseGroup(listEl, { title: t("未分类"), countText: tf("{n}题", { n: noSource.length }) }, body => {
					for (const fd of noSource) renderFileItem(body, fd);
				});
			} else if (view.questionsSortMode === "tag") {
				const { groups, untagged } = groupByTag(filtered, fd => knowledgeTags(fd.tags));
				for (const g of groups) collapseGroup(listEl, { title: "#" + g.key, countText: tf("{n}题", { n: g.items.length }) }, body => {
					for (const fd of g.items) renderFileItem(body, fd);
				});
				if (untagged.length > 0) collapseGroup(listEl, { title: t("未分类"), countText: tf("{n}题", { n: untagged.length }) }, body => {
					for (const fd of untagged) renderFileItem(body, fd);
				});
			} else if (view.questionsSortMode === "time") {
				const sorted = [...filtered].sort((a, b) => (b.file.stat.mtime || 0) - (a.file.stat.mtime || 0));
				for (const fd of sorted) renderFileItem(listEl, fd);
			}
		};
		renderList("");
}
