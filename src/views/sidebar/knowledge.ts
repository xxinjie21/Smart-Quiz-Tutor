import { App, Modal, Notice, TFile, TFolder } from "obsidian";
import * as fs from "fs";

import type { MainSidebarView } from "../sidebarView";
import { isAbs, readFileStr, listMdFiles, joinPath, deleteFileAbs } from "../../utils/fs-utils";
import { t, tf } from "../../i18n/index";

export function knowledgeFolders(view: MainSidebarView): { path: string; label: string }[] {
	return [
		{ path: view.plugin.rootPath(view.plugin.settings.knowledgeFolder), label: t("知识点索引") },
	].filter(f => !!f.path);
}

export async function readIndexFileContent(view: MainSidebarView, absOrVaultPath: string): Promise<string> {
	if (isAbs(absOrVaultPath)) {
		try { return readFileStr(absOrVaultPath); } catch { return ""; }
	}
	const f = view.app.vault.getAbstractFileByPath(absOrVaultPath);
	if (f instanceof TFile) {
		try { return await view.app.vault.read(f); } catch { return ""; }
	}
	return "";
}

export function extractIndexLinks(content: string): string[] {
	const links: string[] = [];
	const re = /\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) links.push(m[1]!.trim());
	return links;
}

export function indexFileSections(content: string): string[] {
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

export async function listKnowledgeManagerTags(view: MainSidebarView): Promise<{ tag: string; indexFiles: { file: string; sourceLabel: string }[] }[]> {
	const map: Record<string, { file: string; sourceLabel: string }[]> = {};
	for (const { path: folder } of knowledgeFolders(view)) {
		if (!folder) continue;
		if (isAbs(folder)) {
			if (!fs.existsSync(folder)) continue;
			for (const f of listMdFiles(folder)) {
				const tag = f.replace(/\.md$/, "");
				const content = await readIndexFileContent(view, joinPath(folder, f));
				const secs = indexFileSections(content);
				for (const label of secs) (map[tag] || (map[tag] = [])).push({ file: joinPath(folder, f), sourceLabel: label });
			}
		} else {
			const folderObj = view.app.vault.getAbstractFileByPath(folder);
			if (!(folderObj instanceof TFolder)) continue;
			for (const child of folderObj.children) {
				if (child instanceof TFile && child.extension === "md") {
					const content = await readIndexFileContent(view, child.path);
					const secs = indexFileSections(content);
					for (const label of secs) (map[child.basename] || (map[child.basename] = [])).push({ file: child.path, sourceLabel: label });
				}
			}
		}
	}
	return Object.entries(map)
		.map(([tag, indexFiles]) => ({ tag, indexFiles: indexFiles.sort((a, b) => a.sourceLabel.localeCompare(b.sourceLabel, "zh-Hans-CN")) }))
		.sort((a, b) => a.tag.localeCompare(b.tag, "zh-Hans-CN"));
}

export function knowledgeManagerTagFiles(view: MainSidebarView, tag: string): { folder: string }[] {
	const hits: { folder: string }[] = [];
	for (const { path: folder } of knowledgeFolders(view)) {
		if (!folder) continue;
		if (isAbs(folder)) {
			if (!fs.existsSync(folder)) continue;
			for (const f of listMdFiles(folder)) {
				if (f.replace(/\.md$/, "") === tag) hits.push({ folder: joinPath(folder, f) });
			}
		} else {
			const folderObj = view.app.vault.getAbstractFileByPath(folder);
			if (!(folderObj instanceof TFolder)) continue;
			for (const child of folderObj.children) {
				if (child instanceof TFile && child.extension === "md" && child.basename === tag) hits.push({ folder: child.path });
			}
		}
	}
	return hits;
}

export async function deleteKnowledgeIndexFile(view: MainSidebarView, filePath: string): Promise<void> {
	if (isAbs(filePath)) {
		deleteFileAbs(filePath);
	} else {
		const f = view.app.vault.getAbstractFileByPath(filePath);
		if (f instanceof TFile) await view.app.fileManager.trashFile(f);
	}
}

export function openLinkedFile(view: MainSidebarView, linkText: string) {
	const clean = linkText.replace(/\.(md|txt|rtf|docx|pdf)$/i, "").trim();
	const dest = view.app.metadataCache?.getFirstLinkpathDest(linkText, "") ?? view.app.metadataCache?.getFirstLinkpathDest(clean, "");
	if (dest) { view.app.workspace.openLinkText(dest.path, "", false).catch(() => {}); return; }
	if (isAbs(linkText)) {
		const file = view.app.vault.getAbstractFileByPath(linkText);
		if (file instanceof TFile) { view.app.workspace.openLinkText(file.path, "", false).catch(() => {}); return; }
	}
	const byName = view.app.vault.getFiles().find(f => f.basename === clean || f.name === linkText || f.path === linkText);
	if (byName) { view.app.workspace.openLinkText(byName.path, "", false).catch(() => {}); return; }
	new Notice(tf("找不到文件：{name}", { name: linkText }));
}

export async function renderKnowledgeManager(view: MainSidebarView) {
	if (!view.innerContentEl) return;
	if (view.homeView !== "knowledgeManager") return;
	const el = view.innerContentEl;
	el.empty();

	const backBtn = el.createEl("button", { text: t("← 返回"), attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:19px;margin-bottom:12px;" } });
	backBtn.addEventListener("click", () => { view.homeView = "default"; void view.renderHomeTab(); });

	el.createDiv({ text: t("知识点管理"), attr: { style: "font-size:21px;font-weight:bold;margin-bottom:4px;" } });
	el.createDiv({ text: t("可多选/全选，删除会同时删除知识点索引文件"), attr: { style: "color:var(--text-muted);font-size:15px;margin-bottom:14px;" } });

	const list = await listKnowledgeManagerTags(view);
	const selectedSet = new Set<string>();

	const toolbar = el.createDiv({ attr: { style: "display:flex;gap:6px;margin-bottom:12px;" } });
	const searchInput = toolbar.createEl("input", { attr: { type: "text", placeholder: t("搜索知识点..."), style: "flex:1;padding:6px 8px;border-radius:4px;border:1px solid var(--background-modifier-border);" } });
	const refreshBtn = toolbar.createEl("button", { text: t("刷新"), attr: { style: "padding:6px 14px;border-radius:4px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
	refreshBtn.addEventListener("click", () => { view.plugin.invalidateCache(); void renderKnowledgeManager(view); });

	const bulkBar = el.createDiv({ attr: { style: "display:flex;align-items:center;gap:10px;margin-bottom:10px;" } });
	const selectAllCb = bulkBar.createEl("input", { attr: { type: "checkbox", title: t("全选") } });
	bulkBar.createSpan({ text: t("全选"), attr: { style: "color:var(--text-muted);font-size:16px;cursor:pointer;user-select:none;" } }).addEventListener("click", () => { selectAllCb.checked = !selectAllCb.checked; selectAllCb.checked ? selectAll() : clearSel(); });
	const bulkCount = bulkBar.createDiv({ text: tf("已选 {n} 个", { n: 0 }), attr: { style: "flex:1;color:var(--text-muted);font-size:16px;" } });
	const bulkDelBtn = bulkBar.createEl("button", { text: t("删除选中"), attr: { style: "padding:6px 16px;border-radius:6px;cursor:pointer;font-size:16px;border:1px solid var(--color-red);color:var(--color-red);background:transparent;opacity:0.5;pointer-events:none;" } });

	const summaryEl = el.createDiv({ text: tf("共 {n} 个知识点", { n: list.length }), attr: { style: "color:var(--text-muted);font-size:16px;margin-bottom:8px;" } });

	const wrap = el.createDiv({ attr: { style: "display:flex;flex-direction:column;gap:8px;padding-bottom:20px;" } });

	let currentFiltered: { tag: string; indexFiles: { file: string; sourceLabel: string }[] }[] = [];

	const updateBulk = () => {
		const n = selectedSet.size;
		bulkCount.setText(tf("已选 {n} 个", { n }));
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
			const confirmed = await confirmKnowledgeDelete(view.app, names.join("、"), allPaths, true);
			if (!confirmed) return;
			let ok = 0;
			for (const tag of names) {
				const files = knowledgeManagerTagFiles(view, tag);
				for (const f of files) {
					await deleteKnowledgeIndexFile(view, f.folder);
					ok++;
				}
			}
			new Notice(tf("已删除 {n} 处知识点索引文件", { n: ok }));
			view.plugin.invalidateCache();
			await renderKnowledgeManager(view);
		})();
	});

	const renderFiltered = (query: string) => {
		wrap.empty();
		const q = query.trim().toLowerCase();
		const filtered = q ? list.filter(i => i.tag.toLowerCase().includes(q) || i.indexFiles.some(s => s.sourceLabel.toLowerCase().includes(q))) : list;
		currentFiltered = filtered;
		summaryEl.setText(tf("共 {a} 个知识点", { a: list.length }) + (q ? tf("，筛选出 {b} 个", { b: filtered.length }) : ""));
		if (filtered.length === 0) {
			wrap.createDiv({ text: q ? t("未找到匹配的知识点") : t("暂无知识点索引文件"), attr: { style: "color:var(--text-muted);padding:20px 0;text-align:center;" } });
			updateBulk();
			return;
		}
		for (const item of filtered) {
			const row = wrap.createDiv({ cls: "qg-clip", attr: { style: "border-radius:12px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);overflow:hidden;" } });
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
			info.createDiv({ text: item.tag, cls: "qg-clip", attr: { style: "font-size:17px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" } });
			const typeInfo = head.createDiv({ attr: { style: "color:var(--text-muted);font-size:15px;flex-shrink:0;margin-right:6px;" } });
			const qCount = item.indexFiles.filter(s => s.sourceLabel === "题目索引").length;
			const nCount = item.indexFiles.filter(s => s.sourceLabel === "笔记索引").length;
			const wCount = item.indexFiles.filter(s => s.sourceLabel === "错题索引").length;
			const parts: string[] = [];
			if (qCount > 0) parts.push(t("题") + qCount);
			if (nCount > 0) parts.push(t("记") + nCount);
			if (wCount > 0) parts.push(t("错") + wCount);
			typeInfo.setText(parts.join(" ") || t("0 处索引"));
			head.addEventListener("click", (e) => {
				if ((e.target as HTMLElement).tagName === "BUTTON") return;
				if ((e.target as HTMLElement).tagName === "INPUT") return;
				detail.style.display = detail.style.display === "none" ? "block" : "none";
				arrow.setText(detail.style.display === "none" ? "▸" : "▾");
			});
			const detail = row.createDiv({ attr: { style: "display:none;border-top:1px solid var(--background-modifier-border);padding:10px 12px;font-size:15px;" } });
			detail.createDiv({ text: t("索引文件："), attr: { style: "font-weight:600;color:var(--text-muted);margin-bottom:6px;" } });
			for (const s of item.indexFiles) {
				const line = detail.createDiv({ attr: { style: "display:flex;gap:6px;align-items:flex-start;margin-bottom:6px;" } });
				const srcDisplay = s.sourceLabel === "题目索引" ? t("题目索引") : s.sourceLabel === "笔记索引" ? t("笔记索引") : t("错题索引");
				line.createSpan({ text: srcDisplay + "：", attr: { style: "flex-shrink:0;color:var(--interactive-accent);" } });
				line.createDiv({ text: s.file, attr: { style: "flex:1;word-break:break-all;color:var(--text-muted);" } });
			}
			detail.createDiv({ text: t("……（点击下方查看索引条目）"), attr: { style: "color:var(--text-muted);font-size:14px;margin:4px 0;" } });
			const peekBtn = detail.createEl("button", { text: t("🡕 查看索引条目"), attr: { style: "padding:5px 12px;border-radius:6px;cursor:pointer;font-size:15px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);margin-top:4px;" } });
			peekBtn.addEventListener("click", () => {
				void (async () => {
					peekBtn.setText(t("加载中..."));
					peekBtn.disabled = true;
					const linkSet = new Set<string>();
					for (const s of item.indexFiles) {
						const content = await readIndexFileContent(view, s.file);
						for (const l of extractIndexLinks(content)) linkSet.add(l);
					}
					peekBtn.setText(t("🡕 查看索引条目"));
					peekBtn.disabled = false;
					linksEl.empty();
					linksEl.show();
					const links = [...linkSet];
					if (links.length === 0) {
						linksEl.createDiv({ text: t("该知识点暂无关联条目"), attr: { style: "color:var(--text-muted);" } });
					} else {
						linksEl.createDiv({ text: tf("关联条目（{n}）：", { n: links.length }), attr: { style: "font-weight:600;color:var(--text-muted);margin-bottom:6px;" } });
						for (const l of links) {
							const linkRow = linksEl.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;padding:2px 0;line-height:1.5;cursor:pointer;" } });
							linkRow.createSpan({ text: l, attr: { style: "flex:1;word-break:break-all;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" } });
							linkRow.classList.add("qg-hover-bg");
							linkRow.setAttribute("title", tf("打开：{name}", { name: l }));
							linkRow.addEventListener("click", () => openLinkedFile(view, l));
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

		contentEl.createDiv({ text: this.isBulk ? tf("删除选中的 {n} 个索引文件", { n: this.indexFiles.length }) : tf("删除知识点： {name}", { name: this.title }), attr: { style: "font-size:18px;font-weight:700;margin-bottom:12px;" } });
		if (this.isBulk) {
			contentEl.createDiv({ text: t("将删除以下知识点： ") + this.title, attr: { style: "font-size:15px;color:var(--text-muted);margin-bottom:8px;word-break:break-all;line-height:1.6;" } });
		}
		contentEl.createDiv({ text: tf("将同时删除以下 {n} 个索引文件：", { n: this.indexFiles.length }), attr: { style: "font-size:15px;color:var(--text-muted);margin-bottom:8px;" } });

		const listEl = contentEl.createDiv({ attr: { style: "max-height:200px;overflow:auto;background:var(--background-secondary);border:1px solid var(--background-modifier-border);border-radius:8px;padding:10px 12px;margin-bottom:16px;font-size:14px;line-height:1.8;" } });
		for (const f of this.indexFiles) listEl.createDiv({ text: "· " + f, attr: { style: "word-break:break-all;" } });
		contentEl.createDiv({ text: t("此操作不可恢复，是否继续？"), attr: { style: "font-size:15px;color:var(--text-accent);margin-bottom:24px;" } });

		const btnRow = contentEl.createDiv({ attr: { style: "display:flex;justify-content:flex-end;gap:8px;" } });
		const cancelBtn = btnRow.createEl("button", { text: t("取消"), attr: { style: "padding:6px 16px;border-radius:6px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:15px;" } });
		cancelBtn.addEventListener("click", () => this.close());
		const okBtn = btnRow.createEl("button", { text: t("删除"), attr: { style: "padding:6px 16px;border-radius:6px;cursor:pointer;border:1px solid var(--color-red);background:var(--color-red);color:var(--text-on-accent);font-size:15px;" } });
		okBtn.addEventListener("click", () => { this.confirmed = true; this.close(); });
	}

	onClose() {
		this.contentEl.empty();
	}
}

export function confirmKnowledgeDelete(app: App, title: string, indexFiles: string[], isBulk = false): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const modal = new KnowledgeDeleteConfirmModal(app, title, indexFiles, isBulk);
		modal.open();
		const origClose = modal.close.bind(modal);
		modal.close = () => { origClose(); resolve(modal.confirmed); };
	});
}
