import { describe, it, expect, beforeEach } from "vitest";
import { t, tf, setLanguage, getLanguage, zh, en } from "../src/i18n/index";
import { buildGeneratePrompt, buildExamExtractPrompt } from "../src/services/questionService";
import { buildNotePrompt } from "../src/services/noteService";
import { buildTaggingPrompt } from "../src/services/knowledgeService";

describe("i18n 字典", () => {
	it("en 必须覆盖 zh 的所有 key", () => {
		const zhKeys = Object.keys(zh).sort();
		const enKeys = Object.keys(en).sort();
		expect(enKeys).toEqual(zhKeys);
	});
	it("zh 的 value 与 key 相同（原文即 key）", () => {
		for (const [k, v] of Object.entries(zh)) expect(v).toBe(k);
	});
});

describe("t()", () => {
	beforeEach(() => setLanguage("zh"));
	it("zh 模式返回原文", () => {
		expect(t("根文件夹")).toBe("根文件夹");
	});
	it("en 模式返回英文", () => {
		setLanguage("en");
		expect(t("根文件夹")).toBe("Root folder");
	});
	it("缺失 key 回退原文（不空白）", () => {
		setLanguage("en");
		expect(t("不存在的key")).toBe("不存在的key");
	});
	it("getLanguage 反映当前语言", () => {
		setLanguage("en");
		expect(getLanguage()).toBe("en");
	});
});

describe("tf() 占位符", () => {
	beforeEach(() => setLanguage("zh"));
	it("替换 {n} 占位符", () => {
		expect(tf("共 {n} 次学习活动", { n: 3 })).toBe("共 3 次学习活动");
	});
	it("en 模式替换占位符", () => {
		setLanguage("en");
		expect(tf("共 {n} 次学习活动", { n: 3 })).toBe("3 learning activities in total");
	});
	it("多个占位符", () => {
		setLanguage("en");
		expect(tf("已选 {a} 个，共 {b} 个", { a: 2, b: 5 })).toBe("2 selected, 5 in total");
	});
});

describe("提示词模板双语", () => {
	beforeEach(() => setLanguage("zh"));
	it("zh 模式 buildGeneratePrompt 输出中文（与旧版一致）", () => {
		setLanguage("zh");
		const p = buildGeneratePrompt("原文", "single:5", []);
		expect(p).toContain("出题教师");
		expect(p).toContain("只允许出下面列出的题型与数量");
	});
	it("en 模式 buildGeneratePrompt 输出英文且含语言规则", () => {
		setLanguage("en");
		const p = buildGeneratePrompt("material", "single:5", []);
		expect(p).toContain("question-writing teacher");
		expect(p).toContain("Use the same language as the source material");
	});
	it("zh 模式 buildExamExtractPrompt 输出中文", () => {
		setLanguage("zh");
		const p = buildExamExtractPrompt("文档");
		expect(p).toContain("试卷识别助手");
	});
	it("en 模式 buildExamExtractPrompt 输出英文", () => {
		setLanguage("en");
		const p = buildExamExtractPrompt("document");
		expect(p).toContain("exam extraction assistant");
	});
	it("zh 模式 buildNotePrompt 输出中文且含语言一致规则", () => {
		setLanguage("zh");
		const p = buildNotePrompt("正文", "来源");
		expect(p).toContain("语言与材料一致");
	});
	it("en 模式 buildNotePrompt 输出英文且含语言一致规则", () => {
		setLanguage("en");
		const p = buildNotePrompt("body", "source");
		expect(p).toContain("same language as the material");
	});
	it("zh 模式 buildTaggingPrompt 输出中文", () => {
		setLanguage("zh");
		const p = buildTaggingPrompt("内容", []);
		expect(p).toContain("知识管理助手");
	});
	it("en 模式 buildTaggingPrompt 输出英文", () => {
		setLanguage("en");
		const p = buildTaggingPrompt("content", []);
		expect(p).toContain("knowledge-management assistant");
	});
});
