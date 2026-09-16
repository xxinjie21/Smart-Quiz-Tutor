import { Notice, TFile } from "obsidian";

import type { MainSidebarView } from "../sidebarView";
import { SEARCH_DEBOUNCE_MS } from "../../constants";
import { debounce } from "../../utils/debounce";
import { parseFM, buildFM } from "../../utils/frontmatter";
import { buildTaggingPrompt, parseTaggedResult } from "../../services/knowledgeService";
import { t, tf } from "../../i18n/index";

function loadTaggerFiles(view: MainSidebarView) {
	const excludeList = view.buildExcludeList();
	view.fpAllFiles = view.app.vault.getFiles().filter(f => {
		if (f.extension !== "md") return false;
		const lp = f.path.toLowerCase();
		for (const ex of excludeList) { if (lp.includes(ex + "/") || lp.startsWith(ex)) return false; }
		return true;
	});
}

export async function renderTaggerView(view: MainSidebarView) {
	if (!view.innerContentEl) return;
	if (view.homeView !== "tagger") return;
	const el = view.innerContentEl;
	el.empty();

	const backBtn = el.createEl("button", { text: t("← 返回"), attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:19px;margin-bottom:12px;" } });
	backBtn.addEventListener("click", () => { view.cancelAI(); view.fpSelected.clear(); view.taggerStatusText = ""; view.homeView = "default"; void view.renderHomeTab(); });
	el.createDiv({ text: t("AI添加标签"), attr: { style: "font-size:21px;font-weight:bold;margin-bottom:4px;" } });
	el.createDiv({ text: t("AI识别文档中的知识点，自动写入frontmatter，用于Obsidian知识图谱"), attr: { style: "color:var(--text-muted);font-size:17px;margin-bottom:12px;" } });

	const modeRow = el.createDiv({ attr: { style: "display:flex;gap:4px;margin-bottom:12px;" } });
	const modes: { key: "current" | "folder"; label: string }[] = [
		{ key: "current", label: t("当前文件") },
		{ key: "folder", label: t("从文件夹选择") },
	];
	for (const m of modes) {
		const btn = modeRow.createEl("button", { text: m.label, attr: { style: "padding:4px 12px;border-radius:3px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:" + (view.taggerMode === m.key ? "var(--interactive-accent);color:var(--text-on-accent);" : "var(--background-secondary);color:var(--text-muted);") } });
		btn.addEventListener("click", () => { view.taggerMode = m.key; view.fpSelected.clear(); void view.renderTaggerView(); });
	}

	if (view.taggerMode === "current") {
		const activeFile = view.app.workspace.getActiveFile();
		if (!activeFile || activeFile.extension !== "md") {
			el.createDiv({ text: t("请先打开一个Markdown文件"), attr: { style: "color:var(--text-muted);text-align:center;padding:30px 0;font-size:19px;" } });
		} else {
			const info = el.createDiv({ attr: { style: "padding:8px 10px;border-radius:6px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);margin-bottom:12px;font-size:17px;" } });
			info.createSpan({ text: t("当前文件：") });
			info.createSpan({ text: activeFile.path, attr: { style: "color:var(--interactive-accent);" } });
			info.createDiv({ text: view.fileSizeInfo(activeFile), attr: { style: "color:var(--text-muted);margin-top:2px;" } });
			const btnRow = el.createDiv({ attr: { style: "display:flex;gap:8px;align-items:center;" } });
			const processBtn = btnRow.createEl("button", { text: view.taggerProcessing ? t("处理中...") : t("🤖 开始识别标签"), attr: { style: "padding:8px 20px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--interactive-accent);background:var(--interactive-accent);color:var(--text-on-accent);" + (view.taggerProcessing ? "opacity:0.5;pointer-events:none;" : "") } });
			processBtn.addEventListener("click", () => { void runAITagging(view, [activeFile]); });
			if (view.taggerProcessing) {
				const stopBtn = btnRow.createEl("button", { text: t("⏹ 停止"), attr: { style: "padding:8px 20px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--color-red);background:var(--background-secondary);color:var(--color-red);" } });
				stopBtn.addEventListener("click", () => view.cancelAI());
			}
		}
	} else {
		loadTaggerFiles(view);
		const infoEl = el.createDiv({ attr: { style: "color:var(--text-muted);font-size:18px;margin-bottom:6px;" } });
		infoEl.setText(view.selectInfoText(view.fpAllFiles, view.fpSelected));

		const searchInput = el.createEl("input", { attr: { type: "text", placeholder: t("搜索文件名..."), style: "width:100%;padding:6px 8px;border-radius:4px;border:1px solid var(--background-modifier-border);margin-bottom:8px;" } });

		const toolBar = el.createDiv({ attr: { style: "margin-bottom:8px;display:flex;gap:6px;" } });
		const toolBtn = (label: string, cb: () => void) => {
			const b = toolBar.createEl("button", { text: label, attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;font-size:18px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
			b.addEventListener("click", cb);
		};

		const listEl = el.createDiv({ attr: { style: "max-height:420px;overflow-y:auto;" } });
		const btnRow = el.createDiv({ attr: { style: "margin-top:12px;display:flex;gap:8px;" } });
		const procBtn = btnRow.createEl("button", { text: (view.taggerProcessing ? t("处理中...") : tf("🤖 开始识别标签（{n}个）", { n: 0 })), attr: { style: "flex:1;padding:8px 16px;border-radius:4px;font-size:19px;cursor:pointer;border:1px solid var(--interactive-accent);background:var(--interactive-accent);color:var(--text-on-accent);opacity:0.5;pointer-events:none;" } });
		procBtn.addEventListener("click", () => {
			const files = view.fpAllFiles.filter(f => view.fpSelected.has(f.path));
			void runAITagging(view, files);
		});
		const clearBtn = btnRow.createEl("button", { text: t("清空选择"), attr: { style: "padding:8px 16px;border-radius:4px;font-size:19px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
		clearBtn.addEventListener("click", () => { view.fpSelected.clear(); rerender(); });
		if (view.taggerProcessing) {
			const stopBtn = btnRow.createEl("button", { text: t("⏹ 停止"), attr: { style: "padding:8px 16px;border-radius:4px;font-size:19px;cursor:pointer;border:1px solid var(--color-red);background:var(--background-secondary);color:var(--color-red);" } });
			stopBtn.addEventListener("click", () => view.cancelAI());
		}
		const updateConfirm = () => {
			const size = view.fpSelected.size;
			procBtn.setText(view.taggerProcessing ? t("处理中...") : tf("🤖 开始识别标签（{n}个）", { n: size }));
			const disabled = view.taggerProcessing || size === 0;
			procBtn.style.opacity = disabled ? "0.5" : "1";
			procBtn.style.pointerEvents = disabled ? "none" : "auto";
		};
		const rerender = () => { view.renderSelectTree(listEl, searchInput, infoEl, view.fpAllFiles, view.fpSelected, rerender, updateConfirm, view.taggerExpanded); updateConfirm(); };
		toolBtn(t("全选"), () => { view.fpAllFiles.forEach(f => view.fpSelected.add(f.path)); rerender(); });
		toolBtn(t("取消全选"), () => { view.fpSelected.clear(); rerender(); });
		searchInput.addEventListener("input", debounce(() => rerender(), SEARCH_DEBOUNCE_MS));
		rerender();
	}

	if (view.taggerStatusText) {
		el.createDiv({ text: view.taggerStatusText, attr: { style: "margin-top:10px;padding:8px 10px;border-radius:6px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);font-size:17px;color:var(--text-muted);" } });
	}
}

export async function runAITagging(view: MainSidebarView, files: TFile[]) {
	if (files.length === 0 || view.taggerProcessing) return;
	view.taggerProcessing = true;
	view.resetAI();
	view.taggerStatusText = tf("准备处理 {n} 个文件...", { n: files.length });
	void view.renderTaggerView();

	const existingTags = await view.plugin.loadExistingKnowledgeTags();

	let successCount = 0;
	let failCount = 0;

	for (let i = 0; i < files.length; i++) {
		if (view.aiCancelled) break;
		const file = files[i]!;
		view.taggerStatusText = tf("正在识别 ({cur}/{total}) {name}...", { cur: i + 1, total: files.length, name: file.basename });
		void view.renderTaggerView();

		try {
			const content = await view.app.vault.read(file);
			if (!content || content.trim().length === 0) { failCount++; continue; }

			const prompt = buildTaggingPrompt(content, existingTags);

			const full = await view.callAIWithPrompt(prompt);
			if (!full) { failCount++; continue; }

			const tags = parseTaggedResult(full);
			if (tags.length === 0) { failCount++; continue; }

			const { meta, body } = parseFM(content);
			const oldTags = Array.isArray(meta.tags) ? meta.tags : [];
			const mergedTags = [...new Set([...oldTags, ...tags])];
			const newFM = { ...meta, tags: mergedTags };
			const newContent = buildFM(newFM) + body;
			await view.app.vault.modify(file, newContent);
			successCount++;
		} catch (err) {
			if ((err as Error).name === "AbortError") {
				if (view.aiCancelled) break;
				failCount++;
				continue;
			}
			console.error("[question-generator] AI标签失败:", file.path, err);
			failCount++;
		}
	}

	view.taggerProcessing = false;
	view.taggerStatusText = (view.aiCancelled ? t("已中止") : t("完成")) + tf("！成功 {a} 个，失败 {b} 个", { a: successCount, b: failCount });
	void view.renderTaggerView();
	new Notice((view.aiCancelled ? tf("AI标签已中止：成功 {a}，失败 {b}", { a: successCount, b: failCount }) : tf("AI标签完成：成功 {a}，失败 {b}", { a: successCount, b: failCount })));
}
