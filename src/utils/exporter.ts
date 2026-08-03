import { Paragraph, TextRun, HeadingLevel, AlignmentType } from "docx";
import * as fs from "fs";
import { getElectronRemote } from "./electron";
import {
	FONT, FSBody, FSSmall, AnswerColor, ExplainColor,
	highlightTechTerms, highlightTechHtml,
	splitAnswerContent, splitSemantic, stripAnswerSummarySection,
} from "./layout";
import { htmlEscape } from "./text";

function pushPara(children: Paragraph[], opts: { runs?: TextRun[]; spacing?: { before?: number; after?: number; line?: number }; indent?: { left?: number; right?: number }; alignment?: (typeof AlignmentType)[keyof typeof AlignmentType]; heading?: (typeof HeadingLevel)[keyof typeof HeadingLevel] }) {
	if (opts.runs) {
		children.push(new Paragraph({ children: opts.runs, spacing: opts.spacing || { before: 0, after: 0 }, indent: opts.indent, alignment: opts.alignment, heading: opts.heading }));
	}
}

function addEmptyLine(children: Paragraph[], count: number = 1) {
	for (let j = 0; j < count; j++) {
		children.push(new Paragraph({ children: [], spacing: { before: 0, after: 0 } }));
	}
}

export type ExamBlock =
	| { type: "heading"; parts: [string]; hasInline: false; level: number }
	| { type: "question"; parts: [string]; hasInline: true }
	| { type: "option"; parts: [string]; hasInline: true }
	| { type: "subitem"; parts: [string]; hasInline: true }
	| { type: "note"; parts: [string]; hasInline: true }
	| { type: "answer"; parts: string[]; hasInline: boolean }
	| { type: "explanation"; parts: string[]; hasInline: boolean }
	| { type: "text"; parts: [string]; hasInline: true };

const EXAM_ANSWER_LINE = /^(?:\*\*)?(?:答案|标准答案|参考答案)(?:\*\*)?[：:]/;
const EXAM_EXPLAIN_LINE = /^(?:\*\*)?解析(?:\*\*)?[：:]/;
const EXAM_NUM_LINE = /^\d+[.、]/;
const EXAM_HEADING_LINE = /^#{1,6}\s+/;

export function parseExamBlocks(text: string): ExamBlock[] {
	const rawLines = stripAnswerSummarySection(text).split("\n");
	const blocks: ExamBlock[] = [];
	let i = 0;
	while (i < rawLines.length) {
		const trimmed = rawLines[i]!.trim();
		i++;
		if (trimmed === "") continue;

		if (EXAM_HEADING_LINE.test(trimmed)) {
			const level = trimmed.match(/^(#{1,6})/)?.[1]?.length || 1;
			blocks.push({ type: "heading", parts: [trimmed.replace(/^#{1,6}\s+/, "")], hasInline: false, level });
			continue;
		}
		if (EXAM_NUM_LINE.test(trimmed)) {
			blocks.push({ type: "question", parts: [trimmed], hasInline: true });
			continue;
		}
		if (/^[A-D][.、]/.test(trimmed)) {
			blocks.push({ type: "option", parts: [trimmed], hasInline: true });
			continue;
		}
		if (/^\(\d+\)/.test(trimmed)) {
			blocks.push({ type: "subitem", parts: [trimmed], hasInline: true });
			continue;
		}
		if (/^[*>\s]*补充说明[：:]/.test(trimmed)) {
			blocks.push({ type: "note", parts: [trimmed.replace(/^[*>\s]+/, "").replace(/[*\s]+$/, "").trim()], hasInline: true });
			continue;
		}
		if (EXAM_ANSWER_LINE.test(trimmed)) {
			const match = trimmed.match(/^(?:\*\*)?(答案|标准答案|参考答案)(?:\*\*)?([：:])(.*)/);
			const label = match ? (match[1] || "答案") + (match[2] || "：") : "答案：";
			const inlineContent = match ? (match[3] || "").trim().replace(/^\*{1,2}/, "").replace(/\*{1,2}$/, "").trim() : "";
			const steps = splitAnswerContent(inlineContent);
			const hasInline = inlineContent !== "" && steps.length <= 1;
			blocks.push({ type: "answer", parts: hasInline ? [label + " " + inlineContent] : [label, ...steps], hasInline });
			continue;
		}
		if (EXAM_EXPLAIN_LINE.test(trimmed)) {
			const match = trimmed.match(/^(?:\*\*)?解析(?:\*\*)?([：:])(.*)/);
			const label = match ? "解析" + (match[1] || "：") : "解析：";
			const content = match ? (match[2] || "").trim().replace(/^\*{1,2}/, "").replace(/\*{1,2}$/, "").trim() : "";
			const lines: string[] = [label];
			if (content) lines.push(...splitSemantic(content));
			while (i < rawLines.length) {
				const next = rawLines[i]!.trim();
				if (next === "") { i++; continue; }
				if (EXAM_NUM_LINE.test(next) || EXAM_HEADING_LINE.test(next) || /^(答案|标准答案|参考答案)[：:]/.test(next)) break;
				lines.push(...splitSemantic(next));
				i++;
			}
			blocks.push({ type: "explanation", parts: lines, hasInline: lines.length <= 1 });
			continue;
		}
		blocks.push({ type: "text", parts: [trimmed], hasInline: true });
	}
	return blocks;
}

// ===================== Word排版 =====================
export function buildWordParagraphs(text: string, title?: string, source?: string): Paragraph[] {
	const children: Paragraph[] = [];

	if (title) {
		children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1, spacing: { before: 0, after: 40 }, alignment: AlignmentType.CENTER }));
	}
	if (source) {
		pushPara(children, { runs: [new TextRun({ text: "来源：" + source, font: FONT, size: FSSmall, color: "888888", italics: true })], spacing: { before: 0, after: 80 }, alignment: AlignmentType.CENTER });
	}

	let lastType = "";

	for (const block of parseExamBlocks(text)) {
		if (block.type === "heading") {
			const headingMap: Record<number, typeof HeadingLevel[keyof typeof HeadingLevel]> = {
				1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3,
				4: HeadingLevel.HEADING_4, 5: HeadingLevel.HEADING_5, 6: HeadingLevel.HEADING_6,
			};
			children.push(new Paragraph({ text: block.parts[0], heading: headingMap[block.level] || HeadingLevel.HEADING_2, spacing: { before: 160, after: 40 } }));
			lastType = "heading";
			continue;
		}

		if (block.type === "question") {
			if (lastType === "explanation" || lastType === "answer" || lastType === "option") {
				addEmptyLine(children);
			}
			const match = block.parts[0].match(/^(\d+[.、]\s*)(.*)/);
			if (match) {
				const stemRuns: TextRun[] = [
					new TextRun({ text: match[1]!, bold: true, font: FONT, size: FSBody }),
					...highlightTechTerms(match[2]!),
				];
				pushPara(children, {
					runs: stemRuns,
					spacing: { before: lastType === "heading" ? 20 : 60, after: 20 },
					indent: { left: 0 }
				});
			}
			lastType = "question";
			continue;
		}

		if (block.type === "option" || block.type === "subitem") {
			const pad = block.type === "option" ? 4 : 2;
			pushPara(children, {
				runs: highlightTechTerms(block.parts[0]),
				spacing: { before: pad, after: pad },
				indent: { left: 360 }
			});
			lastType = block.type === "option" ? "option" : "answer";
			continue;
		}

		if (block.type === "note") {
			pushPara(children, {
				runs: [new TextRun({ text: block.parts[0], font: FONT, size: FSBody, italics: true, color: "666666" })],
				spacing: { before: 2, after: 2 },
				indent: { left: 360 }
			});
			lastType = "answer";
			continue;
		}

		if (block.type === "answer") {
			if (lastType !== "heading" && lastType !== "") addEmptyLine(children);

			pushPara(children, {
				runs: [new TextRun({ text: block.parts[0], bold: true, color: AnswerColor, font: FONT, size: FSBody })],
				spacing: { before: 0, after: 0 },
				indent: { left: 0 }
			});

			if (!block.hasInline) {
				for (const step of block.parts.slice(1)) {
					pushPara(children, {
						runs: highlightTechTerms(step),
						spacing: { before: 2, after: 2 },
						indent: { left: 0 }
					});
				}
			}
			lastType = "answer";
			continue;
		}

		if (block.type === "explanation") {
			pushPara(children, {
				runs: [new TextRun({ text: block.parts[0], bold: true, color: ExplainColor, font: FONT, size: FSSmall })],
				spacing: { before: 4, after: 2 },
				indent: { left: 0 }
			});
			for (const line of block.parts.slice(1)) {
				pushPara(children, {
					runs: highlightTechTerms(line),
					spacing: { before: 0, after: 0 },
					indent: { left: 0 }
				});
			}
			lastType = "explanation";
			continue;
		}

		pushPara(children, {
			runs: highlightTechTerms(block.parts[0]),
			spacing: { before: 4, after: 4 },
			indent: { left: 0 }
		});
		lastType = "text";
	}

	return children;
}

export function buildExportHtml(text: string, title?: string, source?: string): string {
	const dateStr = new Date().toISOString().slice(0, 10);
	const parts: string[] = [];

	if (title) parts.push('<h1 style="text-align:center;margin:0 0 2px;font-size:27px;">' + highlightTechHtml(htmlEscape(title)) + '</h1>');
	if (source) parts.push('<p style="text-align:center;color:#999;font-size:18px;margin:0 0 4px;">来源：' + htmlEscape(source) + '　|　日期：' + dateStr + '</p>');

	let lastType = "";
	for (const block of parseExamBlocks(text)) {
		if (block.type === "heading") {
			const tag = block.level <= 2 ? "h2" : "h3";
			const style = block.level <= 2
				? 'font-size:21px;font-weight:600;color:#1a5276;margin:16px 0 6px;padding-bottom:3px;border-bottom:1.5px solid #3498db;'
				: 'font-size:20px;font-weight:600;color:#2c3e50;margin:12px 0 4px;';
			parts.push('<' + tag + ' style="' + style + '">' + highlightTechHtml(htmlEscape(block.parts[0])) + '</' + tag + '>');
			lastType = "heading";
			continue;
		}

		if (block.type === "question") {
			if (lastType === "explanation" || lastType === "answer" || lastType === "option") {
				parts.push('<div style="height:8px;"></div>');
			}
			const match = block.parts[0].match(/^(\d+[.、]\s*)(.*)/);
			if (match) {
				parts.push('<p style="margin:' + (lastType === "heading" ? "2px" : "6px") + ' 0;font-size:20px;line-height:1.7;"><strong>' + htmlEscape(match[1]!) + '</strong>' + highlightTechHtml(htmlEscape(match[2]!)) + '</p>');
			}
			lastType = "question";
			continue;
		}

		if (block.type === "option" || block.type === "subitem") {
			parts.push('<p style="margin:1px 0 1px 24px;font-size:19px;line-height:1.6;">' + highlightTechHtml(htmlEscape(block.parts[0])) + '</p>');
			lastType = block.type === "option" ? "option" : "answer";
			continue;
		}

		if (block.type === "note") {
			parts.push('<p style="margin:1px 0 1px 24px;font-size:19px;line-height:1.6;font-style:italic;color:#666;">' + highlightTechHtml(htmlEscape(block.parts[0])) + '</p>');
			lastType = "answer";
			continue;
		}

		if (block.type === "answer") {
			if (lastType !== "heading" && lastType !== "") parts.push('<div style="height:8px;"></div>');
			parts.push('<p style="margin:2px 0;font-size:20px;line-height:1.7;"><strong style="color:#2E7D32;">' + htmlEscape(block.parts[0]!) + '</strong></p>');
			if (!block.hasInline) {
				for (const step of block.parts.slice(1)) {
					parts.push('<p style="margin:1px 0;font-size:20px;line-height:1.7;">' + highlightTechHtml(htmlEscape(step)) + '</p>');
				}
			}
			lastType = "answer";
			continue;
		}

		if (block.type === "explanation") {
			parts.push('<p style="margin:2px 0;font-size:19px;line-height:1.7;"><strong style="color:#1565C0;">' + htmlEscape(block.parts[0]!) + '</strong></p>');
			for (const line of block.parts.slice(1)) {
				parts.push('<p style="margin:0;font-size:19px;line-height:1.7;">' + highlightTechHtml(htmlEscape(line)) + '</p>');
			}
			lastType = "explanation";
			continue;
		}

		parts.push('<p style="margin:2px 0;font-size:20px;line-height:1.7;">' + highlightTechHtml(htmlEscape(block.parts[0])) + '</p>');
		lastType = "text";
	}

	const body = parts.join("\n");
	return '<html><head><meta charset="utf-8"><style>body{padding:40px 50px;max-width:900px;margin:0 auto;font-family:"Microsoft YaHei","PingFang SC",sans-serif;font-size:20px;color:#333;}h1{font-size:27px;font-weight:700;text-align:center;color:#222;}p{margin:2px 0;}strong{font-weight:600;}</style></head><body>' + body + '</body></html>';
}

export async function exportPdfDirect(filePath: string, text: string, title?: string, source?: string) {
	const fullHtml = buildExportHtml(text, title, source);
	
	const { BrowserWindow } = getElectronRemote();
	const win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { offscreen: true } });
	try {
		await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(fullHtml));
		const pdfData = await win.webContents.printToPDF({ printBackground: true, pageSize: "A4", marginTop: 0.6, marginBottom: 0.6, marginLeft: 0.5, marginRight: 0.5 });
		fs.writeFileSync(filePath, pdfData);
	} finally {
		win.close();
	}
}
