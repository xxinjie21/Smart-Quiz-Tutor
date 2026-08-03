import { describe, it, expect } from "vitest";
import {
	parseExcludeFolderNames,
	isExcludedPath,
	joinPath,
	parseFM,
	buildFM,
	parseQuestions,
	parseReviewIntervals,
	DEFAULT_SETTINGS,
	DEFAULT_NOTE_INTERVALS,
	parseExamBlocks,
	buildExportHtml,
} from "../src/main";

describe("parseExcludeFolderNames", () => {
	it("splits comma-separated names and trims spaces", () => {
		expect(parseExcludeFolderNames(".trash, 模板, templates")).toEqual([".trash", "模板", "templates"]);
	});

	it("returns empty array for empty input", () => {
		expect(parseExcludeFolderNames("")).toEqual([]);
		expect(parseExcludeFolderNames("  , ,")).toEqual([]);
	});
});

describe("isExcludedPath", () => {
	it("excludes paths containing any excluded folder segment", () => {
		const cfg = ".trash, 模板, templates";
		expect(isExcludedPath("题目/模板/a.md", cfg)).toBe(true);
		expect(isExcludedPath("题目/.trash/x.md", cfg)).toBe(true);
		expect(isExcludedPath("笔记/templates/y.md", cfg)).toBe(true);
		expect(isExcludedPath("题目/章节一/a.md", cfg)).toBe(false);
	});

	it("matches excluded folder nested in the middle of the path", () => {
		expect(isExcludedPath("题目/第一章/模板/a.md", "模板")).toBe(true);
	});

	it("handles backslash absolute paths", () => {
		expect(isExcludedPath("D:\\库\\题目\\模板\\a.md", "模板")).toBe(true);
		expect(isExcludedPath("D:\\库\\题目\\章节一\\a.md", "模板")).toBe(false);
	});

	it("returns false when no exclusion configured", () => {
		expect(isExcludedPath("题目/a.md", "")).toBe(false);
	});
});

describe("joinPath", () => {
	it("joins with forward slash for absolute Windows dirs", () => {
		expect(joinPath("D:\\库\\题目", "a.md")).toBe("D:/库/题目/a.md");
	});

	it("joins with forward slash for unix dirs", () => {
		expect(joinPath("/vault/题目", "a.md")).toBe("/vault/题目/a.md");
	});

	it("joins with forward slash for vault-relative dirs", () => {
		expect(joinPath("题目/识别试卷", "a.md")).toBe("题目/识别试卷/a.md");
	});

	it("avoids double slashes when dir already ends with separator", () => {
		expect(joinPath("题目/", "a.md")).toBe("题目/a.md");
		expect(joinPath("D:\\库\\", "a.md")).toBe("D:/库/a.md");
	});
});

describe("parseFM block-list tags", () => {
	it("parses YAML block-list tags like Obsidian writes", () => {
		const { meta, body } = parseFM("---\ntitle: T\ntags:\n  - 试卷\n  - AI识别\n---\n\nBody");
		expect(meta.title).toBe("T");
		expect(meta.tags).toEqual(["试卷", "AI识别"]);
		expect(body).toBe("Body");
	});

	it("still parses inline array tags", () => {
		const { meta } = parseFM("---\ntags: [a, b]\n---\n\nBody");
		expect(meta.tags).toEqual(["a", "b"]);
	});
});

describe("parseFM review numeric fields", () => {
	it("coerces interval/correctCount/wrongCount to numbers", () => {
		const { meta } = parseFM(buildFM({ interval: 7, correctCount: 3, wrongCount: 2, nextReview: "2026-08-10" }));
		expect(meta.interval).toBe(7);
		expect(meta.correctCount).toBe(3);
		expect(meta.wrongCount).toBe(2);
		expect(meta.nextReview).toBe("2026-08-10");
	});

	it("keeps non-review scalars as strings", () => {
		const { meta } = parseFM("---\nkey: value\ncount: 5\n---\n\nContent");
		expect(meta.key).toBe("value");
		expect(meta.count).toBe("5");
	});
});

describe("parseQuestions keeps unanswered stems", () => {
	it("keeps a numbered blank stem without an answer", () => {
		const result = parseQuestions("## 填空题\n1. Fill the blank ___");
		expect(result.length).toBe(1);
		expect(result[0]!.type).toBe("blank");
		expect(result[0]!.answer).toBe("");
	});

	it("keeps a numbered essay stem without an answer", () => {
		const result = parseQuestions("## 简答题\n1. 请简述流程");
		expect(result.length).toBe(1);
		expect(result[0]!.type).toBe("essay");
		expect(result[0]!.text).toContain("请简述流程");
	});

	it("still returns empty for plain text without question numbers", () => {
		const result = parseQuestions("Just some text");
		expect(result.length).toBe(0);
	});
});

describe("note review interval alignment", () => {
	it("default settings note intervals match the standard preset", () => {
		expect(parseReviewIntervals(DEFAULT_SETTINGS.noteReviewIntervals, DEFAULT_NOTE_INTERVALS)).toEqual(DEFAULT_NOTE_INTERVALS);
	});
});

describe("parseExamBlocks", () => {
	it("parses heading, question, option, answer, explanation blocks", () => {
		const blocks = parseExamBlocks("## 单选题\n1. Q\nA. a\nB. b\n答案：A\n解析：explanation");
		const types = blocks.map(b => b.type);
		expect(types).toContain("heading");
		expect(types).toContain("question");
		expect(types).toContain("option");
		expect(types).toContain("answer");
		expect(types).toContain("explanation");
	});

	it("collects explanation continuation lines into a single block", () => {
		const blocks = parseExamBlocks("1. Q\n答案：A\n解析：第一句\n第二句\n2. 下一题\n答案：B");
		const expl = blocks.find(b => b.type === "explanation");
		expect(expl).toBeTruthy();
		expect(expl!.parts).toContain("第一句");
		expect(expl!.parts).toContain("第二句");
	});

	it("marks single-line answers as inline so renderers keep them on one line", () => {
		const blocks = parseExamBlocks("1. Q\nA. a\nB. b\n答案：A\n解析：x");
		const ans = blocks.find(b => b.type === "answer");
		expect(ans).toBeTruthy();
		expect(ans!.hasInline).toBe(true);
	});

	it("splits multi-point answers into separate parts", () => {
		const blocks = parseExamBlocks("1. Q\n答案：1. 甲 2. 乙\n解析：x");
		const ans = blocks.find(b => b.type === "answer");
		expect(ans!.parts.length).toBeGreaterThan(1);
	});
});

describe("buildExportHtml", () => {
	it("renders question stems bold and colored answer/explanation labels", () => {
		const html = buildExportHtml("1. Q\nA. a\nB. b\n答案：A\n解析：expl");
		expect(html).toContain("<strong>1. </strong>");
		expect(html).toContain("color:#2E7D32");
		expect(html).toContain("color:#1565C0");
	});

	it("strips the answer summary section before rendering", () => {
		const html = buildExportHtml("1. Q\n答案：A\n\n---\n\n答案汇总\n1. A");
		expect(html).not.toContain("答案汇总");
	});
});
