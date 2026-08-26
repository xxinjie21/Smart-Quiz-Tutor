import { describe, it, expect } from "vitest";
import { parseQuestions, parseExamBlocks } from "../src/main";

describe("parseQuestions 英文题解析", () => {
	it("解析英文单选题（Answer:/Explanation:）", () => {
		const text = [
			"## Single Choice",
			"**1.** What is 2+2?",
			"A. 3", "B. 4", "C. 5", "D. 6",
			"Answer: B",
			"Explanation: Basic arithmetic.",
		].join("\n");
		const qs = parseQuestions(text);
		expect(qs.length).toBe(1);
		expect(qs[0]!.type).toBe("single");
		expect(qs[0]!.answer).toBe("B");
	});
	it("解析英文判断题（True/False）", () => {
		const text = [
			"## True/False",
			"**1.** The sky is blue.",
			"A. True", "B. False",
			"Answer: A",
		].join("\n");
		const qs = parseQuestions(text);
		expect(qs[0]!.type).toBe("judge");
	});
	it("解析英文答案汇总块（Answer Summary）", () => {
		const text = [
			"**1.** Question one",
			"A. x", "B. y",
			"Answer Summary",
			"1. B",
		].join("\n");
		const qs = parseQuestions(text);
		expect(qs.length).toBe(1);
		expect(qs[0]!.answer).toBe("B");
	});
	it("中文题解析不受影响（回归）", () => {
		const text = [
			"## 单选题",
			"**1.** 2+2等于几？",
			"A. 3", "B. 4",
			"答案：B",
			"解析：基础算术。",
		].join("\n");
		const qs = parseQuestions(text);
		expect(qs.length).toBe(1);
		expect(qs[0]!.type).toBe("single");
		expect(qs[0]!.answer).toBe("B");
	});
});

describe("parseExamBlocks 英文标签", () => {
	it("识别英文 Answer:/Explanation:", () => {
		const text = "**1.** Question\nA. x\nB. y\n**Answer:**\nB\n**Explanation:**\nBecause.";
		const blocks = parseExamBlocks(text);
		expect(blocks.length).toBeGreaterThan(0);
		const types = blocks.map(b => b.type);
		expect(types).toContain("answer");
		expect(types).toContain("explanation");
	});
});
