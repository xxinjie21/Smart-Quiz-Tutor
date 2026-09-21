import { App, Modal, TFile } from "obsidian";

import { buildFileTree } from "../utils/filetree";
import type { FileMeta, TreeNode } from "../types";
import { formatFileSize, formatDateShort } from "../utils/listView";
import { t, tf } from "../i18n/index";

const ROW_STYLE = "display:flex;align-items:center;gap:6px;padding:3px 4px;border-radius:4px;cursor:pointer;font-size:14px;";
const FOLDER_STYLE = ROW_STYLE + "font-weight:600;";

/** 按文件夹分层选择的笔记多选器，返回所选的 Markdown 文件。 */
export class NotePickerModal extends Modal {
	private selected = new Set<string>();
	private expandedSet = new Set<string>();
	private onChoose: (files: TFile[]) => void;
	private files: TFile[] = [];
	private searchEl: HTMLInputElement | null = null;
	private infoEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;

	constructor(app: App, onChoose: (files: TFile[]) => void) {
		super(app);
		this.onChoose = onChoose;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: t("选择要引用的笔记") });

		this.files = this.app.vault.getMarkdownFiles().slice().sort((a, b) => a.path.localeCompare(b.path));
		this.searchEl = contentEl.createEl("input", {
			attr: { type: "text", placeholder: t("搜索文件名…"), style: "width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--background-modifier-border);" },
		});
		this.searchEl.addEventListener("input", () => this.renderTree());
		this.infoEl = contentEl.createDiv({ attr: { style: "color:var(--text-muted);font-size:13px;margin:6px 0;" } });
		this.listEl = contentEl.createDiv({ attr: { style: "max-height:360px;overflow-y:auto;margin:0 0 10px;border:1px solid var(--background-modifier-border);border-radius:6px;padding:2px;" } });

		this.renderTree();

		const toolBar = contentEl.createDiv({ attr: { style: "display:flex;gap:6px;margin-bottom:8px;" } });
		const toolBtn = (label: string, cb: () => void) => {
			const b = toolBar.createEl("button", { text: label, attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;font-size:13px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
			b.addEventListener("click", cb);
		};
		toolBtn(t("全选"), () => { this.files.forEach(f => this.selected.add(f.path)); this.renderTree(); });
		toolBtn(t("取消全选"), () => { this.selected.clear(); this.renderTree(); });

		const footer = contentEl.createDiv({ attr: { style: "display:flex;justify-content:flex-end;gap:8px;" } });
		const ok = footer.createEl("button", { text: t("确认"), cls: "mod-cta" });
		ok.addEventListener("click", () => {
			const chosen = this.files.filter(f => this.selected.has(f.path));
			this.close();
			this.onChoose(chosen);
		});
		footer.createEl("button", { text: t("取消") }).addEventListener("click", () => this.close());
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
		const q = (this.searchEl?.value || "").trim().toLowerCase();
		const filtered = q
			? this.files.filter(f => f.path.toLowerCase().includes(q) || f.basename.toLowerCase().includes(q))
			: this.files;
		this.listEl.empty();
		this.renderNode(this.listEl, buildFileTree(filtered), 0);
		if (this.infoEl) this.infoEl.setText(tf("共 {a} 个文档，已选 {b} 个", { a: this.files.length, b: this.selected.size }));
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
				cb.checked = folderFiles.length > 0 && folderFiles.every(f => this.selected.has(f.path));
				cb.indeterminate = folderFiles.some(f => this.selected.has(f.path)) && !cb.checked;
				cb.addEventListener("change", () => {
					folderFiles.forEach(f => { if (cb.checked) this.selected.add(f.path); else this.selected.delete(f.path); });
					this.renderTree();
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
				cb.checked = this.selected.has(child.path);
				row.createSpan({ text: child.name, attr: { style: "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-normal);" } });
				if (child.file) {
					row.createSpan({ text: formatFileSize(child.file.stat.size), attr: { style: "color:var(--text-muted);font-size:12px;flex-shrink:0;" } });
					row.createSpan({ text: formatDateShort(child.file.stat.mtime), attr: { style: "color:var(--text-muted);font-size:12px;flex-shrink:0;" } });
				}
				const update = () => {
					if (cb.checked) this.selected.add(child.path); else this.selected.delete(child.path);
					this.renderTree();
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
		this.contentEl.empty();
	}
}