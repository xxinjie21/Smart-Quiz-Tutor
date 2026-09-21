import { App, Modal, Notice } from "obsidian";

import type { MainSidebarView } from "./sidebarView";
import { isAbs, ensureFolder, joinPath, writeFileStr } from "../utils/fs-utils";
import { buildFM, buildKnowledgeLinks } from "../utils/frontmatter";
import { safeName } from "../utils/text";
import { localDateStr, addDaysStr } from "../utils/date";
import { clampEase } from "../utils/sm2";
import { t, tf } from "../i18n/index";

/** 手动添加错题：填写内容/来源/知识点/备注，写入错题本并纳入 SM-2 复习。 */
export class AddWrongModal extends Modal {
	private view: MainSidebarView;

	constructor(app: App, view: MainSidebarView) {
		super(app);
		this.view = view;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: t("添加错题") });

		const field = (label: string, placeholder: string, multiline = false) => {
			contentEl.createDiv({ text: label, attr: { style: "font-size:13px;color:var(--text-muted);margin:8px 0 2px;" } });
			if (multiline) return contentEl.createEl("textarea", { attr: { placeholder, style: "width:100%;height:160px;font-size:14px;" } });
			return contentEl.createEl("input", { attr: { type: "text", placeholder, style: "width:100%;" } });
		};
		const bodyEl = field(t("题目内容"), t("粘贴题干、选项、答案、解析等"), true);
		const sourceEl = field(t("来源文件"), t("可选，填来源文件名"));
		const tagsEl = field(t("知识点标签"), t("可选，逗号分隔，如 计算机网络, TCP"));
		const noteEl = field(t("备注"), t("可选"));

		const err = contentEl.createDiv({ attr: { style: "color:var(--text-error);font-size:13px;margin-top:6px;" } });

		const footer = contentEl.createDiv({ attr: { style: "display:flex;justify-content:flex-end;gap:8px;margin-top:12px;" } });
		footer.createEl("button", { text: t("保存"), cls: "mod-cta" }).addEventListener("click", () => {
			const body = bodyEl.value.trim();
			if (!body) { err.setText(t("题目内容不能为空")); return; }
			const sourceName = sourceEl.value.trim();
			const tags = tagsEl.value.split(",").map(s => s.trim()).filter(Boolean);
			void this.save(body, sourceName, tags, noteEl.value.trim());
			this.close();
		});
		footer.createEl("button", { text: t("取消") }).addEventListener("click", () => this.close());
	}

	private async save(body: string, sourceName: string, kpTags: string[], note: string) {
		const view = this.view;
		try {
			const folder = view.plugin.rootPath(view.plugin.settings.wrongBookFolder);
			await ensureFolder(view.app, folder);
			const dateStr = localDateStr();
			const tags = ["错题", ...kpTags];
			const fm = buildFM({
				source: sourceName ? "[[" + sourceName + "]]" : "",
				date: dateStr,
				tags,
				note,
				nextReview: addDaysStr(dateStr, 1),
				interval: 1,
				correctCount: 0,
				wrongCount: 1,
				easeFactor: clampEase(view.plugin.settings.wrongEaseFactor),
				repetitions: 0,
				lapses: 1,
			});
			const content = fm + body + buildKnowledgeLinks(tags);
			const fileName = safeName(sourceName || "手动") + "_错题_" + dateStr + "_" + Date.now().toString(36) + ".md";
			let filePath: string;
			if (isAbs(folder)) {
				filePath = joinPath(folder, fileName);
				writeFileStr(filePath, content);
			} else {
				filePath = folder + "/" + fileName;
				await view.app.vault.create(filePath, content);
			}
			new Notice(t("已添加错题"));
			view.plugin.emitDataChanged();
			view.syncToKnowledgeIndex(tags, fileName.replace(/\.md$/, ""), filePath, "错题");
			await view.renderWrongTab();
		} catch (e) {
			new Notice(tf("添加失败：{msg}", { msg: (e as Error).message }));
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}