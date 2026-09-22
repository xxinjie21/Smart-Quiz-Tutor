import { App, Modal, TFile } from "obsidian";

import { buildFileTree } from "../utils/filetree";
import type { FileMeta, TreeNode } from "../types";
import { formatFileSize, formatDateShort } from "../utils/listView";
import { debounce } from "../utils/debounce";
import { SEARCH_DEBOUNCE_MS } from "../constants";
import { t, tf } from "../i18n/index";

const ROW_STYLE = "display:flex;align-items:center;gap:6px;padding:3px 4px;border-radius:4px;cursor:pointer;font-size:14px;";
const FOLDER_STYLE = ROW_STYLE + "font-weight:600;";

/** 按文件夹分层选择的笔记多选器，返回所选的 Markdown 文件。 */
export class NotePickerModal extends Modal {
	private selected = new Set<string>();
	private expandedSet: Set<string>;
	private onChoose: (files: TFile[]) => void;
	private files: TFile[] = [];
	private searchEl: HTMLInputElement | null = null;
	private infoEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	/** 文件路径 → 该行复选框；用于不重建 DOM 地同步勾选状态。 */
	private fileBoxes = new Map<string, HTMLInputElement>();
	/** 文件夹路径 → 该行复选框及其全部后代文件（用于汇总全选/半选）。 */
	private folderBoxes = new Map<string, { box: HTMLInputElement; files: FileMeta[] }>();

	/**
	 * @param expanded 展开状态的容器。由调用方持有可以让弹窗重开后仍保持展开；
	 *                 不传则只在本次弹窗内有效。
	 */
	constructor(app: App, onChoose: (files: TFile[]) => void, expanded?: Set<string>) {
		super(app);
		this.onChoose = onChoose;
		this.expandedSet = expanded ?? new Set<string>();
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: t("选择要引用的笔记") });

		this.files = this.app.vault.getMarkdownFiles().slice().sort((a, b) => a.path.localeCompare(b.path));
		this.searchEl = contentEl.createEl("input", {
			attr: { type: "text", placeholder: t("搜索文件名…"), style: "width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--background-modifier-border);" },
		});
		// 大 vault 里每敲一个字都重建整棵树会明显卡顿，这里做一次防抖
		const rerender = debounce(() => this.renderTree(), SEARCH_DEBOUNCE_MS);
		this.searchEl.addEventListener("input", () => rerender());
		this.infoEl = contentEl.createDiv({ attr: { style: "color:var(--text-muted);font-size:13px;margin:6px 0;" } });
		this.listEl = contentEl.createDiv({ attr: { style: "max-height:360px;overflow-y:auto;margin:0 0 10px;border:1px solid var(--background-modifier-border);border-radius:6px;padding:2px;" } });

		this.renderTree();

		const toolBar = contentEl.createDiv({ attr: { style: "display:flex;gap:6px;margin-bottom:8px;" } });
		const toolBtn = (label: string, cb: () => void, title: string) => {
			const b = toolBar.createEl("button", { text: label, attr: { title, style: "padding:4px 10px;border-radius:4px;cursor:pointer;font-size:13px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
			b.addEventListener("click", cb);
		};
		// 全选 / 取消全选只作用于**当前搜索出的**文件，避免「搜了一半却把整库都选上」
		toolBtn(t("全选"), () => { for (const f of this.visibleFiles()) this.selected.add(f.path); this.syncCheckboxes(); }, t("选中当前列出的全部文档"));
		toolBtn(t("取消全选"), () => { for (const f of this.visibleFiles()) this.selected.delete(f.path); this.syncCheckboxes(); }, t("取消选中当前列出的文档"));

		const footer = contentEl.createDiv({ attr: { style: "display:flex;justify-content:flex-end;gap:8px;" } });
		const ok = footer.createEl("button", { text: t("确认"), cls: "mod-cta" });
		ok.addEventListener("click", () => {
			const chosen = this.files.filter(f => this.selected.has(f.path));
			this.close();
			this.onChoose(chosen);
		});
		footer.createEl("button", { text: t("取消") }).addEventListener("click", () => this.close());
	}

	/** 当前搜索条件下列出的文件（无搜索词时即全部）。 */
	private visibleFiles(): TFile[] {
		const q = (this.searchEl?.value || "").trim().toLowerCase();
		if (!q) return this.files;
		return this.files.filter(f => f.path.toLowerCase().includes(q) || f.basename.toLowerCase().includes(q));
	}

	/**
	 * 只同步复选框状态，**不重建 DOM**。
	 *
	 * 旧实现每次勾选都 `renderTree()`（先 `empty()` 再全量重建），列表高度瞬间归零会让
	 * `scrollTop` 复位到 0 —— 在几百上千条笔记的 vault 里勾一个靠后的文件就被弹回顶部，
	 * 根本没法连续多选。
	 */
	private syncCheckboxes() {
		for (const [path, box] of this.fileBoxes) box.checked = this.selected.has(path);
		for (const { box, files } of this.folderBoxes.values()) {
			const all = files.length > 0 && files.every(f => this.selected.has(f.path));
			box.checked = all;
			box.indeterminate = !all && files.some(f => this.selected.has(f.path));
		}
		if (this.infoEl) {
			const shown = this.visibleFiles().length;
			this.infoEl.setText(shown === this.files.length
				? tf("共 {a} 个文档，已选 {b} 个", { a: this.files.length, b: this.selected.size })
				: tf("共 {a} 个文档，筛选出 {c} 个，已选 {b} 个", { a: this.files.length, c: shown, b: this.selected.size }));
		}
	}

	private descendantFiles(node: TreeNode): FileMeta[] {
		const out: FileMeta[] = [];
		for (const c of node.children) {
			if (c.isFolder) out.push(...this.descendantFiles(c));
			else if (c.file) out.push(c.file);
		}
		return out;
	}

	private renderTree() {
		if (!this.listEl) return;
		this.fileBoxes.clear();
		this.folderBoxes.clear();
		this.listEl.empty();
		this.renderNode(this.listEl, buildFileTree(this.visibleFiles()), 0);
		this.syncCheckboxes();
	}

	private renderNode(container: HTMLElement, node: TreeNode, depth: number) {
		const sorted = [...node.children].sort((a, b) => {
			if (a.isFolder && !b.isFolder) return -1;
			if (!a.isFolder && b.isFolder) return 1;
			return a.name.localeCompare(b.name);
		});
		for (const child of sorted) {
			if (child.isFolder) {
				const wrap = container.createDiv({ attr: { style: "margin-left:" + (depth * 16) + "px;" } });
				const row = wrap.createDiv({ attr: { style: FOLDER_STYLE + "color:var(--text-normal);" } });
				const arrow = row.createSpan({ text: "▸", attr: { style: "font-size:14px;min-width:12px;color:var(--text-muted);" } });
				const folderFiles = this.descendantFiles(child);
				const cb = row.createEl("input", { attr: { type: "checkbox" } });
				this.folderBoxes.set(child.path, { box: cb, files: folderFiles });
				cb.addEventListener("change", () => {
					folderFiles.forEach(f => { if (cb.checked) this.selected.add(f.path); else this.selected.delete(f.path); });
					this.syncCheckboxes();
				});
				row.createSpan({ text: child.name + " (" + folderFiles.length + ")", attr: { style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" } });
				const childBox = wrap.createDiv({ attr: { style: "display:none;" } });
				const expanded = this.expandedSet.has(child.path);
				childBox.style.display = expanded ? "block" : "none";
				arrow.setText(expanded ? "▾" : "▸");
				row.addEventListener("click", (e) => {
					if ((e.target as HTMLElement).tagName === "INPUT") return;
					if (this.expandedSet.has(child.path)) this.expandedSet.delete(child.path);
					else this.expandedSet.add(child.path);
					childBox.style.display = this.expandedSet.has(child.path) ? "block" : "none";
					arrow.setText(this.expandedSet.has(child.path) ? "▾" : "▸");
				});
				this.renderNode(childBox, child, depth + 1);
			} else {
				const row = container.createDiv({ attr: { style: "margin-left:" + (depth * 16) + "px;" + ROW_STYLE } });
				const cb = row.createEl("input", { attr: { type: "checkbox" } });
				this.fileBoxes.set(child.path, cb);
				row.createSpan({ text: child.name, attr: { style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-normal);" } });
				if (child.file) {
					row.createSpan({ text: formatFileSize(child.file.stat.size), attr: { style: "color:var(--text-muted);font-size:12px;flex-shrink:0;" } });
					row.createSpan({ text: formatDateShort(child.file.stat.mtime), attr: { style: "color:var(--text-muted);font-size:12px;flex-shrink:0;" } });
				}
				const update = () => {
					if (cb.checked) this.selected.add(child.path); else this.selected.delete(child.path);
					this.syncCheckboxes();
				};
				cb.addEventListener("change", update);
				row.addEventListener("click", (e) => {
					if ((e.target as HTMLElement).tagName === "INPUT") return;
					cb.checked = !cb.checked;
					update();
				});
			}
		}
	}

	onClose() {
		this.fileBoxes.clear();
		this.folderBoxes.clear();
		this.contentEl.empty();
	}
}
