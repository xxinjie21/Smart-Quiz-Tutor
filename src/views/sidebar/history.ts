import type { MainSidebarView } from "../sidebarView";
import { t, tf } from "../../i18n/index";

/** 生成历史记录页（从 MainSidebarView 抽出）。 */
export function renderHistoryView(view: MainSidebarView): void {
	if (!view.innerContentEl) return;
	const el = view.innerContentEl;
	el.empty();

	const backBtn = el.createEl("button", { text: t("← 返回"), attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:19px;margin-bottom:12px;" } });
	backBtn.addEventListener("click", () => { view.homeView = "default"; void view.renderHomeTab(); });

	const headerRow = el.createDiv({ attr: { style: "display:flex;align-items:center;gap:8px;margin-bottom:10px;" } });
	headerRow.createDiv({ text: t("生成历史记录"), attr: { style: "font-size:20px;font-weight:bold;flex:1;" } });

	const entries = view.plugin.history.slice().sort((a, b) => b.timestamp - a.timestamp);
	if (entries.length === 0) {
		el.createDiv({ text: t("暂无生成历史"), attr: { style: "color:var(--text-muted);text-align:center;padding:40px 0;font-size:18px;" } });
		return;
	}

	const clearBtn = headerRow.createEl("button", { text: t("清空历史"), attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;font-size:17px;border:1px solid var(--color-red);background:var(--background-secondary);color:var(--color-red);" } });
	clearBtn.addEventListener("click", () => { view.plugin.history = []; void view.plugin.saveHistory(); void view.renderHistoryView(); });

	const listEl = el.createDiv({ attr: { style: "display:flex;flex-direction:column;gap:8px;" } });
	for (const entry of entries) {
		const card = listEl.createDiv({ cls: "qg-clip", attr: { style: "border:1px solid var(--background-modifier-border);border-radius:8px;overflow:hidden;" } });
		const head = card.createDiv({ attr: { style: "display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;background:var(--background-secondary);" } });
		head.createSpan({ text: entry.fileName, attr: { style: "font-weight:600;font-size:17px;flex:1;word-break:break-all;" } });
		head.createSpan({ text: new Date(entry.timestamp).toLocaleString(), attr: { style: "color:var(--text-faint);font-size:15px;flex-shrink:0;" } });
		if (entry.sourcePath) {
			card.createDiv({ text: tf("来源：{s}", { s: entry.sourcePath }), attr: { style: "padding:0 10px 6px;color:var(--text-muted);font-size:16px;word-break:break-all;" } });
		}
		const body = card.createDiv({ attr: { style: "display:none;border-top:1px solid var(--background-modifier-border);padding:8px 10px;" } });
		const ta = body.createEl("textarea", { attr: { style: "width:100%;height:180px;font-family:monospace;font-size:17px;line-height:1.5;" } });
		ta.value = entry.resultText;
		ta.readOnly = true;
		head.addEventListener("click", () => {
			body.style.display = body.style.display === "none" ? "block" : "none";
		});
	}
}
