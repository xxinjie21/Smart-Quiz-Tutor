import { App, Modal, TFile } from "obsidian";
import { t } from "../i18n/index";

/** 简单的多选笔记选择器（搜索 + 复选），返回所选的 Markdown 文件。 */
export class NotePickerModal extends Modal {
	private selected = new Set<string>();
	private onChoose: (files: TFile[]) => void;

	constructor(app: App, onChoose: (files: TFile[]) => void) {
		super(app);
		this.onChoose = onChoose;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: t("选择要引用的笔记") });

		const search = contentEl.createEl("input", {
			attr: { type: "text", placeholder: t("搜索笔记…"), style: "width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--background-modifier-border);" },
		});
		const list = contentEl.createDiv({ attr: { style: "max-height:340px;overflow-y:auto;margin:10px 0;" } });
		const files = this.app.vault.getMarkdownFiles().slice().sort((a, b) => a.path.localeCompare(b.path));

		const render = (q: string) => {
			list.empty();
			const query = q.trim().toLowerCase();
			for (const f of files) {
				if (query && !f.path.toLowerCase().includes(query)) continue;
				const label = list.createEl("label", { attr: { style: "display:flex;align-items:center;gap:6px;padding:3px 4px;cursor:pointer;font-size:13px;" } });
				const cb = label.createEl("input", { attr: { type: "checkbox" } });
				cb.checked = this.selected.has(f.path);
				cb.addEventListener("change", () => {
					if (cb.checked) this.selected.add(f.path);
					else this.selected.delete(f.path);
				});
				label.createSpan({ text: f.path });
			}
		};
		search.addEventListener("input", () => render(search.value));
		render("");

		const footer = contentEl.createDiv({ attr: { style: "display:flex;justify-content:flex-end;gap:8px;" } });
		const ok = footer.createEl("button", { text: t("确认"), cls: "mod-cta" });
		ok.addEventListener("click", () => {
			const chosen = files.filter(f => this.selected.has(f.path));
			this.close();
			this.onChoose(chosen);
		});
		footer.createEl("button", { text: t("取消") }).addEventListener("click", () => this.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}
