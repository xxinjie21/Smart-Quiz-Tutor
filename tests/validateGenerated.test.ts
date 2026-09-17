import { describe, it, expect } from "vitest";
import { validateGenerated } from "../src/services/questionService";

describe("validateGenerated", () => {
	it("accepts output with headings, numbered questions and answers", () => {
		const v = validateGenerated("## 单选题\n**1.** 题干？\nA. x\nB. y\n答案：A\n解析：(1) …");
		expect(v.ok).toBe(true);
	});

	it("rejects output without headings or question numbers", () => {
		expect(validateGenerated("随便一段文字").ok).toBe(false);
	});

	it("rejects output without an answer line", () => {
		const v = validateGenerated("## 单选题\n**1.** 题干？\nA. x\nB. y");
		expect(v.ok).toBe(false);
		expect(v.hasAnswer).toBe(false);
	});

	it("counts headings and questions", () => {
		const v = validateGenerated("## A\n**1.** …\n答案：x\n## B\n**2.** …\n答案：y");
		expect(v.sectionCount).toBe(2);
		expect(v.questionCount).toBe(2);
	});
});