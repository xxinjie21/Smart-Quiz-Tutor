import type { ParsedQuestion, QuestionType } from "../types";

export function stripMd(text: string): string {
	return text
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^>\s*/gm, "")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/【/g, "(")
		.replace(/】/g, ")")
		.trim();
}

const EXAM_SECTION_NAMES = new Set([
	"单选题", "多选题", "判断题", "填空题", "简答题", "名词解释", "论述题",
	"计算题", "综合题", "问答题", "案例分析题", "案例分析", "解答题", "材料题", "改错题",
]);

export function parseQuestions(text: string): ParsedQuestion[] {
	const cleaned = stripMd(text);
	const questions: ParsedQuestion[] = [];

	const answerBlock: Record<number, string> = {};
	const abMatch = cleaned.match(/答案\s*汇总[：:\s]*\n([\s\S]*?)$/i);
	if (abMatch && abMatch[1]) {
		for (const line of abMatch[1].split("\n")) {
			const m = line.trim().match(/^(\d+)[.、）)\s]+([A-D]+)/);
			if (m && m[1] && m[2]) answerBlock[parseInt(m[1])] = m[2].toUpperCase();
		}
	}

	const lines = text.split("\n");
	let summaryStop = lines.length;
	for (let i = 0; i < lines.length; i++) {
		if (/^\s*答案\s*汇总[：:\s]*$/.test(lines[i]!)) { summaryStop = i; break; }
	}

	type Cur = { num: number; qText: string; opts: { label: string; text: string }[]; answer: string; explanation: string };
	let current: Cur | null = null;
	let answerRegion = false;
	let expRegion = false;
	let expPending = false;
	let ansTail = false;
	let justEndedBlock = true;
	let seqNum = 0;

	const pushCurrent = () => {
		if (!current) return;
		const q = current;
		current = null;
		const ab = answerBlock[q.num];
		if (!q.answer && ab) q.answer = ab;
		if (!q.answer && q.opts.length === 0) return;
		if (q.opts.length === 0 && !q.explanation && /^[A-D]{1,4}$/.test(q.qText)) return;
		seqNum++;

		let qType: QuestionType;
		if (q.opts.length >= 2) {
			const allTexts = q.opts.map(o => o.text.trim());
			if (q.opts.length === 2 && (
				(allTexts.includes("正确") && allTexts.includes("错误")) ||
				(allTexts.includes("对") && allTexts.includes("错")) ||
				(allTexts.includes("True") && allTexts.includes("False"))
			)) {
				qType = "judge";
			} else if (q.answer && q.answer.length > 1 && /^[A-D]+$/.test(q.answer)) {
				qType = "multi";
			} else {
				qType = "single";
			}
		} else if (/（[^）]*）/.test(q.qText) || /\(\s*\.\.\.\s*\)/.test(q.qText) || /_{2,}/.test(q.qText) || /\.{3,}/.test(q.qText)) {
			qType = "blank";
		} else {
			qType = "essay";
		}

		if (qType === "essay" || qType === "blank") {
			questions.push({ number: seqNum, type: qType, text: q.qText, options: [], answer: q.answer, explanation: q.explanation });
		} else if (q.opts.length >= 2) {
			questions.push({ number: seqNum, type: qType, text: q.qText, options: q.opts, answer: q.answer, explanation: q.explanation });
		}
	};

	for (let i = 0; i < summaryStop; i++) {
		const line = lines[i]!.trim();
		if (!line) { answerRegion = false; expRegion = false; expPending = false; justEndedBlock = true; continue; }
		if (/^-{3,}$/.test(line)) { justEndedBlock = true; continue; }

		if (/^#{1,6}\s+/.test(line) || EXAM_SECTION_NAMES.has(line.replace(/[*#\s]/g, ""))) {
			const name = line.replace(/[*#\s]/g, "");
			const isGroupHeading = /^####\s+/.test(line) && !EXAM_SECTION_NAMES.has(name);
			if (current && isGroupHeading && (answerRegion || current.answer)) {
				current.answer += (current.answer ? "\n" : "") + stripMd(line).trim();
				ansTail = true;
				continue;
			}
			pushCurrent();
			answerRegion = false;
			expRegion = false;
			expPending = false;
			ansTail = false;
			justEndedBlock = true;
			continue;
		}

		const numMatch = line.match(/^(?:\*\*)?(\d+)(?:\*\*)?[.、）)\s]+\s*(.*)$/);
		if (numMatch && numMatch[1]) {
			const lineContent = stripMd(line).trim();
			const rest = stripMd(numMatch[2] || "").trim().replace(/^\*\*/, "").trim();
			const cur = current;
			if (expRegion && cur) {
				if (justEndedBlock && !expPending) {
					expRegion = false;
				} else {
					cur.explanation += (cur.explanation ? "\n" : "") + lineContent;
					expPending = false;
					justEndedBlock = false;
					continue;
				}
			}
			const isNew = !cur || cur.opts.length >= 2 || justEndedBlock;
			if (isNew) {
				pushCurrent();
				current = {
					num: parseInt(numMatch[1]),
					qText: rest.replace(/^(?:题干|题目|问题|试题)[：:]\s*/i, ""),
					opts: [],
					answer: "",
					explanation: "",
				};
				answerRegion = false;
				expRegion = false;
				expPending = false;
				ansTail = false;
			} else if (cur) {
				if (answerRegion) {
					cur.answer += (cur.answer ? "\n" : "") + lineContent;
				} else if (cur.opts.length === 0 && !cur.answer) {
					cur.qText += " " + rest;
				}
			}
			justEndedBlock = false;
			continue;
		}

		if (!current) continue;

		const content = stripMd(line);

		if (!answerRegion && !expRegion) {
			const optMatch = content.match(/^([A-D])[.、）)\s]+\s*(.+)/);
			if (optMatch && optMatch[1] && optMatch[2]) {
				current.opts.push({ label: optMatch[1], text: optMatch[2].trim() });
				justEndedBlock = false;
				continue;
			}
		}

		const ansLetterMatch = content.match(/(?:标准)?(?:答案|正确答案|Answer)[：:\s]*([A-D]+)/i);
		if (ansLetterMatch && ansLetterMatch[1]) {
			current.answer = ansLetterMatch[1].toUpperCase();
			answerRegion = true;
			expRegion = false;
			ansTail = true;
			justEndedBlock = false;
			continue;
		}

		const noAns = content.match(/(?:标准)?(?:答案|正确答案|Answer)[：:\s]*(正确|错误|对|错|True|False)/i);
		if (noAns && noAns[1]) {
			current.answer = noAns[1];
			answerRegion = true;
			expRegion = false;
			ansTail = true;
			justEndedBlock = false;
			continue;
		}

		const answerLabel = content.match(/^(?:标准)?(?:答案|参考答案)[：:]\s*(.*)$/);
		if (answerLabel) {
			const rest = answerLabel[1]!.trim();
			if (rest) current.answer = rest;
			answerRegion = true;
			expRegion = false;
			ansTail = true;
			justEndedBlock = false;
			continue;
		}

		const expMatch = content.match(/(?:解析|Explanation|解释)[：:]\s*(.*)/i);
		if (expMatch) {
			if (expMatch[1]) current.explanation = expMatch[1].trim();
			answerRegion = false;
			expRegion = true;
			expPending = !expMatch[1];
			ansTail = false;
			justEndedBlock = true;
			continue;
		}

		if (expRegion) {
			current.explanation += (current.explanation ? "\n" : "") + content;
			expPending = false;
		} else if (answerRegion || ansTail) {
			current.answer += (current.answer ? "\n" : "") + content;
		} else if (current.opts.length === 0 && !current.answer) {
			current.qText += " " + content;
		}
		justEndedBlock = false;
	}

	pushCurrent();
	return questions;
}
