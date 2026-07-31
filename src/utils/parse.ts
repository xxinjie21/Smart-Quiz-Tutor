import type { ParsedQuestion, QuestionType } from "../types";

export function stripMd(text: string): string {
	return text
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/【/g, "(")
		.replace(/】/g, ")")
		.trim();
}

export function parseQuestions(text: string): ParsedQuestion[] {
	const cleaned = stripMd(text);
	const questions: ParsedQuestion[] = [];

	const answerBlock: Record<number, string> = {};
	const summaryPatterns = [
		/答案[汇总：:\s]*\n([\s\S]*?)$/i,
		/\n答案[汇总：:\s]*\n([\s\S]*?)$/i,
	];
	for (const pat of summaryPatterns) {
		const abMatch = cleaned.match(pat);
		if (abMatch && abMatch[1]) {
			for (const line of abMatch[1].split("\n")) {
				const m = line.trim().match(/^(\d+)[.、）)\s]+([A-D]+)/);
				if (m && m[1] && m[2]) answerBlock[parseInt(m[1])] = m[2].toUpperCase();
			}
			if (Object.keys(answerBlock).length > 0) break;
		}
	}

	let textToParse = cleaned;
	const summaryStart = cleaned.search(/\n\s*答案[汇总：:\s]*\n/);
	if (summaryStart !== -1) {
		textToParse = cleaned.slice(0, summaryStart);
	}

	const qBlocks = textToParse.split(/\n(?=(?:\*\*)?\d+[.、）)\s](?:\*\*)?\s)/);
	for (const block of qBlocks) {
		const lines = block.split("\n");
		const firstLine = lines[0]?.trim() || "";
		const numMatch = firstLine.match(/^(?:\*\*)?(\d+)(?:\*\*)?[.、）)\s]+\s*(.+)/);
		if (!numMatch || !numMatch[1] || !numMatch[2]) continue;

		const qNum = parseInt(numMatch[1]);
		let qText = numMatch[2].trim();
		qText = qText.replace(/^(?:题干|题目|问题|试题)[：:]\s*/i, "").trim();

		const opts: { label: string; text: string }[] = [];
		let answer = "";
		let explanation = "";

		for (let i = 1; i < lines.length; i++) {
			const line = lines[i]?.trim() || "";
			if (!line) continue;
			if (/^-{3,}$/.test(line)) continue;

			const optMatch = line.match(/^([A-D])[.、）)\s]+\s*(.+)/);
			if (optMatch && optMatch[1] && optMatch[2]) {
				opts.push({ label: optMatch[1], text: optMatch[2].trim() });
				continue;
			}

			const ansLetterMatch = line.match(/(?:标准)?(?:答案|正确答案|Answer)[：:\s]*([A-D]+)/i);
			if (ansLetterMatch && ansLetterMatch[1]) {
				answer = ansLetterMatch[1].toUpperCase();
				continue;
			}

			const noAns = line.match(/(?:标准)?(?:答案|正确答案|Answer)[：:\s]*(正确|错误|对|错|True|False)/i);
			if (noAns && noAns[1]) {
				answer = noAns[1];
				continue;
			}

			const textAns = line.match(/(?:标准)?(?:答案|参考答案)[：:]\s*(.+)/);
			if (textAns && textAns[1] && !answer) {
				answer = textAns[1].trim();
				continue;
			}

			const expMatch = line.match(/(?:解析|Explanation|解释)[：:]\s*(.+)/i);
			if (expMatch && expMatch[1]) {
				explanation = expMatch[1].trim();
				continue;
			}

			if (opts.length === 0 && !answer) qText += " " + line;
		}

		if (!answer && answerBlock[qNum]) answer = answerBlock[qNum];
		if (!answer && opts.length === 0) continue;
		if (opts.length === 0 && !explanation && /^[A-D]{1,4}$/.test(qText)) continue;

		let qType: QuestionType;
		if (opts.length >= 2) {
			const allTexts = opts.map(o => o.text.trim());
			if (opts.length === 2 && (
				(allTexts.includes("正确") && allTexts.includes("错误")) ||
				(allTexts.includes("对") && allTexts.includes("错")) ||
				(allTexts.includes("True") && allTexts.includes("False"))
			)) {
				qType = "judge";
			} else if (answer && answer.length > 1 && /^[A-D]+$/.test(answer)) {
				qType = "multi";
			} else {
				qType = "single";
			}
		} else if (/（[^）]*）/.test(qText) || /\(\s*\.\.\.\s*\)/.test(qText) || /_{2,}/.test(qText) || /\.{3,}/.test(qText)) {
			qType = "blank";
		} else {
			qType = "essay";
		}

		if (qType === "essay" || qType === "blank") {
			questions.push({ number: qNum, type: qType, text: qText, options: [], answer, explanation });
		} else if (opts.length >= 2) {
			questions.push({ number: qNum, type: qType, text: qText, options: opts, answer, explanation });
		}
	}
	return questions;
}
