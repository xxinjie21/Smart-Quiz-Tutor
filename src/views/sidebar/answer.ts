import { Notice } from "obsidian";

import type { MainSidebarView } from "../sidebarView";
import type { ParsedQuestion, QuestionType } from "../../types";
import { parseQuestions } from "../../utils/parse";
import { splitAnswerContent, normalizeExamContent } from "../../utils/layout";
import { buildFM, buildKnowledgeLinks } from "../../utils/frontmatter";
import { safeName } from "../../utils/text";
import { isAbs, writeFileStr, joinPath, ensureFolder } from "../../utils/fs-utils";
import { t, tf } from "../../i18n/index";

export function startAnswer(view: MainSidebarView, resultText: string, sourceName: string, sourcePath: string = "") {
	view.answerResultText = resultText;
	view.answerSourceName = sourceName;
	view.answerSourcePath = sourcePath;
	view.answerQuestions = parseQuestions(resultText);
	view.answerAnswers = new Map();
	view.answerWrongChecked = new Set();
	view.answerCurrentTags = [];
	if (view.activeSection !== "home") view.activeSection = "home";
	view.homeView = "answer";
	void view.renderHomeTab();
}

export function renderAnswerView(view: MainSidebarView) {
	if (!view.innerContentEl) return;
	const el = view.innerContentEl;
	el.empty();

	const backBtn = el.createEl("button", { text: t("← 返回"), attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:19px;margin-bottom:10px;" } });
	backBtn.addEventListener("click", () => { view.homeView = "default"; void view.renderHomeTab(); });

	if (view.answerQuestions.length === 0) {
		el.createEl("p", { text: t("未能解析出可答题的题目。"), attr: { style: "color:var(--text-muted);padding:20px 0;" } });
		return;
	}

	const typeLabels: Record<QuestionType, string> = { single: t("单选"), multi: t("多选"), judge: t("判断"), blank: t("填空"), essay: t("简答") };
	const counts: Record<string, number> = {};
	for (const q of view.answerQuestions) { const k = typeLabels[q.type]; counts[k] = (counts[k] || 0) + 1; }
	const summary = Object.entries(counts).map(([k, v]) => k + " " + v).join(" / ");
	el.createDiv({ text: tf("共 {n} 题：", { n: view.answerQuestions.length }) + summary, cls: "qg-summary" });

	for (const q of view.answerQuestions) {
		const isGradable = q.type === "single" || q.type === "multi" || q.type === "judge";
		const qEl = el.createDiv({ cls: "qg-question-card", attr: { style: "border:1px solid var(--background-modifier-border);border-radius:8px;padding:12px 14px;margin-bottom:10px;" } });

		const headerRow = qEl.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;margin-bottom:8px;" } });
		headerRow.createSpan({ text: typeLabels[q.type], attr: { style: "font-size:16px;padding:2px 6px;border-radius:4px;background:var(--interactive-accent);color:var(--text-on-accent);font-weight:500;" } });
		headerRow.createSpan({ text: tf("第 {n} 题", { n: q.number }), attr: { style: "font-size:17px;color:var(--text-muted);" } });
		if (!isGradable) headerRow.createSpan({ text: t("(仅参考)"), attr: { style: "font-size:16px;color:var(--text-faint);" } });

		const qTextRow = qEl.createDiv({ attr: { style: "font-weight:600;line-height:1.7;font-size:19px;margin-bottom:8px;" } });
		qTextRow.createSpan({ text: q.number + ". ", attr: { style: "font-weight:700;" } });
		qTextRow.createSpan({ text: q.text });

		if (q.type === "single" || q.type === "judge") {
			const optsEl = qEl.createDiv({ cls: "qg-opts-col" });
			for (const opt of q.options) {
				const optRow = optsEl.createDiv({ cls: "qg-option-row" });
				const radio = optRow.createEl("input", { attr: { type: "radio", name: "q" + q.number, value: opt.label } });
				optRow.createSpan({ text: opt.label + ". " + opt.text, cls: "qg-option-text" });
				radio.addEventListener("change", () => { view.answerAnswers.set(q.number, opt.label); });
				optRow.addEventListener("click", () => { radio.checked = true; view.answerAnswers.set(q.number, opt.label); });
			}
		} else if (q.type === "multi") {
			const optsEl = qEl.createDiv({ cls: "qg-opts-col" });
			const selected = new Set<string>();
			for (const opt of q.options) {
				const optRow = optsEl.createDiv({ cls: "qg-option-row" });
				const cb = optRow.createEl("input", { attr: { type: "checkbox", value: opt.label } });
				optRow.createSpan({ text: opt.label + ". " + opt.text, cls: "qg-option-text" });
				const updateMulti = () => { view.answerAnswers.set(q.number, [...selected].sort().join("")); };
				cb.addEventListener("change", () => { cb.checked ? selected.add(opt.label) : selected.delete(opt.label); updateMulti(); });
				optRow.addEventListener("click", (e) => { if ((e.target as HTMLElement).tagName !== "INPUT") { cb.checked = !cb.checked; cb.checked ? selected.add(opt.label) : selected.delete(opt.label); updateMulti(); } });
			}
		} else if (q.type === "blank") {
			const input = qEl.createEl("input", { cls: "qg-input-wide", attr: { type: "text", placeholder: t("填写答案...") } });
			input.addEventListener("input", () => { view.answerAnswers.set(q.number, input.value.trim()); });
		} else if (q.type === "essay") {
			const ta = qEl.createEl("textarea", { attr: { style: "width:100%;min-height:80px;padding:8px;border-radius:4px;border:1px solid var(--background-modifier-border);resize:vertical;font-size:19px;line-height:1.7;box-sizing:border-box;", placeholder: t("输入你的答案...") } });
			ta.addEventListener("input", () => { view.answerAnswers.set(q.number, ta.value.trim()); });
		}
	}

	const submitBtn = el.createDiv({ attr: { style: "margin-top:10px;text-align:center;" } });
	const sb = submitBtn.createEl("button", { text: t("提交答卷"), attr: { class: "mod-cta", style: "padding:8px 24px;border-radius:4px;cursor:pointer;font-size:20px;" } });
	sb.addEventListener("click", () => answerSubmit(view));
}

function answerSubmit(view: MainSidebarView) {
	if (!view.innerContentEl) return;
	const el = view.innerContentEl;
	el.empty();

	const backBtn = el.createEl("button", { text: t("← 重新答题"), attr: { style: "padding:4px 10px;border-radius:4px;cursor:pointer;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:19px;margin-bottom:10px;" } });
	backBtn.addEventListener("click", () => { view.answerAnswers = new Map(); view.answerWrongChecked = new Set(); renderAnswerView(view); });

	const gradable = view.answerQuestions.filter(q => q.type === "single" || q.type === "multi" || q.type === "judge");
	const nonGradable = view.answerQuestions.filter(q => q.type === "blank" || q.type === "essay");

	let correct = 0;
	const wrongList: ParsedQuestion[] = [];
	for (const q of gradable) {
		const userAnswer = view.answerAnswers.get(q.number) || "";
		let isCorrect = false;
		if (q.type === "single" || q.type === "judge") isCorrect = userAnswer.toUpperCase() === q.answer.toUpperCase();
		else if (q.type === "multi") isCorrect = userAnswer.split("").sort().join("").toUpperCase() === q.answer.toUpperCase();
		if (isCorrect) correct++;
		else wrongList.push(q);
	}

	const totalGradable = gradable.length;
	const score = totalGradable > 0 ? Math.round((correct / totalGradable) * 100) : -1;

	const scoreCard = el.createDiv({ attr: { style: "text-align:center;padding:16px;margin-bottom:14px;border-radius:8px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);" } });
	if (score >= 0) {
		const scoreColor = score >= 80 ? "var(--color-green)" : score >= 60 ? "var(--color-yellow)" : "var(--color-red)";
		scoreCard.createDiv({ text: tf("{n} 分", { n: score }), attr: { style: "font-size:36px;font-weight:bold;color:" + scoreColor + ";line-height:1.2;" } });
		scoreCard.createDiv({ text: tf("客观题 {n} 题：正确 {c} / 错误 {w}", { n: totalGradable, c: correct, w: wrongList.length }), attr: { style: "color:var(--text-muted);margin-top:6px;font-size:19px;" } });
	}
	if (nonGradable.length > 0) scoreCard.createDiv({ text: tf("主观题 {n} 题：请对照参考答案自查", { n: nonGradable.length }), attr: { style: "color:var(--text-faint);margin-top:4px;font-size:18px;" } });

	const selectRow = el.createDiv({ attr: { style: "display:flex;align-items:center;gap:8px;margin:4px 0 6px;" } });
	selectRow.createSpan({ text: t("勾选要加入错题本的题目："), attr: { style: "color:var(--text-muted);font-size:17px;" } });
	const selectBtn = selectRow.createEl("button", { text: t("全选"), attr: { style: "padding:3px 14px;border-radius:4px;cursor:pointer;font-size:17px;border:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);" } });
	const checkboxes: HTMLInputElement[] = [];
	const updateSelectBtn = () => {
		const allChecked = checkboxes.length > 0 && checkboxes.every(c => c.checked);
		selectBtn.setText(allChecked ? t("取消全选") : t("全选"));
	};
	selectBtn.addEventListener("click", () => {
		const allChecked = checkboxes.length > 0 && checkboxes.every(c => c.checked);
		view.answerWrongChecked.clear();
		for (const cb of checkboxes) {
			cb.checked = !allChecked;
			if (cb.checked) view.answerWrongChecked.add(Number(cb.dataset.num));
		}
		updateSelectBtn();
	});

	const typeLabels: Record<QuestionType, string> = { single: t("单选"), multi: t("多选"), judge: t("判断"), blank: t("填空"), essay: t("简答") };

	if (gradable.length > 0) {
		el.createDiv({ text: t("客观题详情"), attr: { style: "font-size:19px;font-weight:600;margin:12px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--background-modifier-border);" } });
		for (const q of gradable) {
			const userAnswer = view.answerAnswers.get(q.number) || "";
			let isCorrect = false;
			if (q.type === "single" || q.type === "judge") isCorrect = userAnswer.toUpperCase() === q.answer.toUpperCase();
			else if (q.type === "multi") isCorrect = userAnswer.split("").sort().join("").toUpperCase() === q.answer.toUpperCase();

			const borderColor = isCorrect ? "var(--color-green)" : "var(--color-red)";
			const qEl = el.createDiv({ attr: { style: "border:1px solid " + borderColor + ";border-radius:8px;padding:10px 12px;margin-bottom:8px;" } });

			const qHeader = qEl.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;margin-bottom:6px;" } });
			const wCb = qHeader.createEl("input", { attr: { type: "checkbox" } });
			wCb.dataset.num = String(q.number);
			wCb.checked = view.answerWrongChecked.has(q.number);
			wCb.addEventListener("change", () => { wCb.checked ? view.answerWrongChecked.add(q.number) : view.answerWrongChecked.delete(q.number); updateSelectBtn(); });
			checkboxes.push(wCb);
			qHeader.createSpan({ text: isCorrect ? t("✓ 正确") : t("✗ 错误"), attr: { style: "font-size:17px;padding:2px 6px;border-radius:4px;font-weight:600;" + (isCorrect ? "background:color-mix(in srgb, var(--color-green) 15%, transparent);color:var(--color-green);" : "background:color-mix(in srgb, var(--color-red) 15%, transparent);color:var(--color-red);") } });
			qHeader.createSpan({ text: typeLabels[q.type], attr: { style: "font-size:16px;color:var(--text-muted);" } });

			const qTextRow = qEl.createDiv({ attr: { style: "font-weight:600;line-height:1.7;font-size:19px;margin-bottom:6px;" } });
			qTextRow.createSpan({ text: q.number + ". ", attr: { style: "font-weight:700;" } });
			qTextRow.createSpan({ text: q.text });

			for (const opt of q.options) {
				const isUserChoice = q.type === "multi" ? userAnswer.includes(opt.label) : opt.label === userAnswer;
				const isCorrectOpt = q.type === "multi" ? q.answer.includes(opt.label) : opt.label === q.answer;
				let optStyle = "padding:2px 0;font-size:19px;line-height:1.5;";
				if (isCorrectOpt) optStyle += "color:var(--color-green);font-weight:600;";
				else if (isUserChoice && !isCorrect) optStyle += "color:var(--color-red);text-decoration:line-through;";
				qEl.createDiv({ text: opt.label + ". " + opt.text, attr: { style: optStyle } });
			}

			if (q.answer) {
				const refLabel = qEl.createDiv({ attr: { style: "margin-top:4px;" } });
				refLabel.createDiv({ text: t("参考答案"), attr: { style: "font-size:18px;font-weight:700;color:#2E7D32;margin-bottom:2px;" } });
				const steps = splitAnswerContent(q.answer);
				for (const step of steps) qEl.createDiv({ text: step, attr: { style: "font-size:18px;line-height:1.6;" } });
			}
			if (q.explanation) {
				const expLabel = qEl.createDiv({ attr: { style: "margin-top:4px;" } });
				expLabel.createDiv({ text: t("考点解析"), attr: { style: "font-size:18px;font-weight:700;color:#1565C0;margin-bottom:2px;" } });
				const expLines = splitAnswerContent(q.explanation);
				for (const line of expLines) qEl.createDiv({ text: line, attr: { style: "font-size:17px;line-height:1.6;color:var(--text-muted);" } });
			}
		}
	}

	if (nonGradable.length > 0) {
		el.createDiv({ text: t("主观题参考答案"), attr: { style: "font-size:19px;font-weight:600;margin:12px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--background-modifier-border);" } });
		for (const q of nonGradable) {
			const userAnswer = view.answerAnswers.get(q.number) || "";
			const qEl = el.createDiv({ attr: { style: "border:1px solid var(--interactive-accent);border-radius:8px;padding:10px 12px;margin-bottom:8px;" } });
			const qHeader = qEl.createDiv({ attr: { style: "display:flex;align-items:center;gap:6px;margin-bottom:6px;" } });
			const wCb = qHeader.createEl("input", { attr: { type: "checkbox" } });
			wCb.dataset.num = String(q.number);
			wCb.checked = view.answerWrongChecked.has(q.number);
			wCb.addEventListener("change", () => { wCb.checked ? view.answerWrongChecked.add(q.number) : view.answerWrongChecked.delete(q.number); updateSelectBtn(); });
			checkboxes.push(wCb);
			qHeader.createSpan({ text: typeLabels[q.type], attr: { style: "font-size:16px;padding:2px 6px;border-radius:4px;background:var(--interactive-accent);color:var(--text-on-accent);" } });

			const qTextRow = qEl.createDiv({ attr: { style: "font-weight:600;line-height:1.7;font-size:19px;margin-bottom:6px;" } });
			qTextRow.createSpan({ text: q.number + ". ", attr: { style: "font-weight:700;" } });
			qTextRow.createSpan({ text: q.text });
			if (userAnswer) {
				qEl.createDiv({ text: tf("你的答案：{a}", { a: userAnswer }), attr: { style: "font-size:17px;color:var(--text-muted);margin-bottom:2px;" } });
				qEl.createDiv({ text: userAnswer, attr: { style: "padding:6px 10px;border-radius:4px;background:var(--background-secondary);font-size:19px;line-height:1.7;white-space:pre-wrap;" } });
			}
			if (q.answer) {
				const refAns = qEl.createDiv({ attr: { style: "margin-top:6px;" } });
				refAns.createDiv({ text: t("参考答案"), attr: { style: "font-size:17px;color:#2E7D32;font-weight:700;margin-bottom:2px;" } });
				const steps = splitAnswerContent(q.answer);
				for (const step of steps) refAns.createDiv({ text: step, attr: { style: "padding:3px 10px;border-radius:4px;background:color-mix(in srgb, var(--color-green) 8%, transparent);font-size:19px;line-height:1.7;" } });
			}
			if (q.explanation) {
				const expEl = qEl.createDiv({ cls: "qg-exp-top" });
				expEl.createDiv({ text: t("考点解析"), cls: "qg-exp-title" });
				const expLines = splitAnswerContent(q.explanation);
				for (const line of expLines) expEl.createDiv({ text: line, cls: "qg-exp-line" });
			}
		}
	}

	if (view.answerQuestions.length > 0) {
		const wrongBtnRow = el.createDiv({ cls: "qg-mt10" });
		const wrongBtn = wrongBtnRow.createEl("button", { text: t("加入错题本"), attr: { class: "mod-cta" }, cls: "qg-wrong-btn" });
		const wrongArea = el.createDiv({ cls: "qg-wrong-area qg-hidden" });
		const questionsText = view.answerQuestions.map(q => q.text).join("\n");
		wrongArea.createDiv({ text: t("知识点标签（可编辑）："), cls: "qg-label-text" });
		const tagsInput = wrongArea.createEl("input", { attr: { type: "text", value: "", placeholder: t("AI识别中，点击“加入错题本”后自动识别"), style: "width:100%;padding:6px;border-radius:4px;border:1px solid var(--background-modifier-border);margin-bottom:6px;font-size:18px;" } });
		wrongArea.createDiv({ text: t("备注："), attr: { style: "font-size:18px;margin-bottom:4px;" } });
		const noteArea = wrongArea.createEl("textarea", { attr: { style: "width:100%;height:40px;border-radius:4px;border:1px solid var(--background-modifier-border);font-size:18px;", placeholder: t("例如：第3、7题做错了") } });
		const confirmWrongBtn = wrongArea.createEl("button", { text: t("确认加入"), attr: { class: "mod-cta", style: "padding:5px 14px;border-radius:4px;cursor:pointer;font-size:18px;margin-top:4px;" } });
		confirmWrongBtn.addEventListener("click", () => {
			void (async () => {
				view.answerCurrentTags = tagsInput.value.split(",").map(s => s.trim()).filter(Boolean);
				const checked = view.answerWrongChecked.size > 0 ? view.answerQuestions.filter(q => view.answerWrongChecked.has(q.number)) : wrongList;
				if (checked.length === 0) { new Notice(t("请先勾选要加入错题本的题目")); return; }
				await answerSaveWrongToBook(view, checked, noteArea.value);
				wrongArea.classList.add("qg-hidden");
			})();
		});
		let tagsSuggested = false;
		wrongBtn.addEventListener("click", () => {
			wrongArea.classList.toggle("qg-hidden");
			if (!tagsSuggested) {
				tagsSuggested = true;
				tagsInput.placeholder = t("AI识别知识点中...");
				view.resetAI();
				void view.aiSuggestTags(questionsText).then(tags => {
					if (tagsInput.value.trim() === "") tagsInput.value = tags.join(", ");
				});
			}
		});
	}

	const homeBtn = el.createDiv({ cls: "qg-home-btn" });
	const hb = homeBtn.createEl("button", { text: t("返回首页"), cls: "qg-btn-home" });
	hb.addEventListener("click", () => { view.homeView = "default"; void view.renderHomeTab(); });
}

async function answerSaveWrongToBook(view: MainSidebarView, wrongList: ParsedQuestion[], noteText: string) {
	view.resetAI();
	const typeLabels: Record<QuestionType, string> = { single: "单选题", multi: "多选题", judge: "判断题", blank: "填空题", essay: "简答题" };
	const fmtPoints = (label: string, content: string): string => {
		const lines = content.split("\n").map(s => s.trim()).filter(Boolean);
		if (lines.length > 1 || /\(\d+\)/.test(content)) {
			return label + "：\n" + lines.join("\n");
		}
		return label + "：" + content;
	};
	const groups: Partial<Record<QuestionType, ParsedQuestion[]>> = {};
	for (const q of wrongList) (groups[q.type] ??= []).push(q);
	let wrongText = "";
	let seq = 0;
	for (const [type, questions] of Object.entries(groups) as [QuestionType, ParsedQuestion[]][]) {
		wrongText += "## " + typeLabels[type] + "\n";
		for (const q of questions) {
			seq++;
			wrongText += "**" + seq + ".** " + q.text + "\n";
			for (const opt of q.options) wrongText += opt.label + ". " + opt.text + "\n";
			wrongText += fmtPoints("答案", q.answer) + "\n";
			if (q.explanation) wrongText += fmtPoints("解析", q.explanation) + "\n";
			wrongText += "\n";
		}
	}
	const autoTags = await view.aiSuggestTags(wrongText);
	const tags = ["错题", ...view.answerCurrentTags, ...autoTags.filter(t => !view.answerCurrentTags.includes(t))];
	const knowledgeLinks = buildKnowledgeLinks(tags);
	try {
		await ensureFolder(view.app, view.plugin.rootPath(view.plugin.settings.wrongBookFolder));
		const dateStr = new Date().toISOString().slice(0, 10);
		const sourceLink = view.answerSourceName ? "[[" + view.answerSourceName + "]]" : "";
		const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
		const fm = buildFM({ source: sourceLink, sourcePath: view.answerSourcePath, date: dateStr, tags, note: noteText || "答题模式加入（" + wrongList.length + "题错误）", nextReview: tomorrow.toISOString().slice(0, 10), interval: 1, correctCount: 0, wrongCount: wrongList.length });
		const content = fm + normalizeExamContent(wrongText) + knowledgeLinks;
		const fileName = safeName(view.answerSourceName) + "_错题_" + dateStr + ".md";
		if (isAbs(view.plugin.rootPath(view.plugin.settings.wrongBookFolder))) {
			const dir = view.plugin.rootPath(view.plugin.settings.wrongBookFolder);
			try { writeFileStr(joinPath(dir, fileName), content); }
			catch { writeFileStr(joinPath(dir, safeName(view.answerSourceName) + "_错题_" + Date.now() + ".md"), content); }
		} else {
			try { await view.app.vault.create(view.plugin.rootPath(view.plugin.settings.wrongBookFolder) + "/" + fileName, content); }
			catch { await view.app.vault.create(view.plugin.rootPath(view.plugin.settings.wrongBookFolder) + "/" + safeName(view.answerSourceName) + "_错题_" + Date.now() + ".md", content); }
		}
		new Notice(tf("已自动将 {n} 道错题加入错题本", { n: wrongList.length }));
		view.plugin.emitDataChanged();
		view.syncToKnowledgeIndex(tags, fileName.replace(/\.md$/, ""), joinPath(view.plugin.rootPath(view.plugin.settings.wrongBookFolder), fileName), "错题");
	} catch (err) { new Notice(tf("加入错题本失败：{msg}", { msg: (err as Error).message })); console.error("[question-generator] 加入错题本失败:", err); }
}
