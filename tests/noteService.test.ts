import { describe, it, expect } from "vitest";
import { buildNotePrompt, parseNoteResult, buildNoteFrontmatter } from "../src/services/noteService";

describe("buildNotePrompt", () => {
	it("requires preserving original structure and abbreviating body text", () => {
		const prompt = buildNotePrompt("材料正文", "物理_第一章");
		expect(prompt).toContain("完全照搬");
		expect(prompt).toContain("去废话、留主干、提炼核心、压缩语句");
		expect(prompt).toContain("保留：关键定义、核心条件、重点特征、因果逻辑、必考信息");
		expect(prompt).toContain("删除：修饰词、重复语句、铺垫话术、举例废话、过渡语句");
		expect(prompt).toContain("长句变短句");
		expect(prompt).toContain("只精简文字，不删减考点、不新增内容");
		expect(prompt).toContain("Tags:");
		expect(prompt).toContain("材料来源：物理_第一章");
		expect(prompt).toContain("材料正文");
	});
});

describe("parseNoteResult", () => {
	it("extracts tags from Tags: line (comma separated)", () => {
		const text = "# 知识点：力学\n\n## 核心概念\n\n内容\n\nTags: 力学, 牛顿定律, 加速度";
		const { tags, body } = parseNoteResult(text);
		expect(tags).toEqual(["力学", "牛顿定律", "加速度"]);
		expect(body).toContain("# 知识点：力学");
		expect(body).not.toContain("Tags:");
	});

	it("extracts tags from 标签： line (Chinese separators)", () => {
		const text = "# 知识点：化学\n\n## 核心概念\n\n内容\n\n标签：氧化还原、离子反应";
		const { tags, body } = parseNoteResult(text);
		expect(tags).toEqual(["氧化还原", "离子反应"]);
		expect(body).not.toContain("标签：");
	});

	it("strips hash prefixes from tag tokens", () => {
		const { tags } = parseNoteResult("内容\n\nTags: #力学, ##化学");
		expect(tags).toEqual(["力学", "化学"]);
	});

	it("returns empty tags when no tag line present", () => {
		const { tags, body } = parseNoteResult("# 知识点：数学\n\n正文内容");
		expect(tags).toEqual([]);
		expect(body).toBe("# 知识点：数学\n\n正文内容");
	});

	it("strips backtick fences from body", () => {
		const { body } = parseNoteResult("```markdown\n# 知识点：生物\n\n内容\n```");
		expect(body).toBe("# 知识点：生物\n\n内容");
	});

	it("handles empty input", () => {
		expect(parseNoteResult("")).toEqual({ tags: [], body: "" });
	});
});

describe("buildNoteFrontmatter", () => {
	it("includes source, sourcePath, date and tags", () => {
		const fm = buildNoteFrontmatter("物理_第一章", "/vault/物理_第一章.md", ["力学", "加速度"]);
		expect(fm).toContain("source: \"[[物理_第一章]]\"");
		expect(fm).toContain("sourcePath: \"/vault/物理_第一章.md\"");
		expect(fm).toContain("tags: [力学, 加速度]");
		expect(fm).toContain("date: \"");
	});

	it("includes review metadata for the spaced-repetition system", () => {
		const fm = buildNoteFrontmatter("src", "path", []);
		expect(fm).toContain("nextReview: \"");
		expect(fm).toContain("interval: 2");
		expect(fm).toContain("correctCount: 0");
		expect(fm).toContain("wrongCount: 0");
	});

	it("uses provided note intervals for first review", () => {
		const fm = buildNoteFrontmatter("src", "path", [], {}, [5, 10]);
		expect(fm).toContain("interval: 5");
	});

	it("allows extra fields to override review metadata", () => {
		const fm = buildNoteFrontmatter("src", "path", [], { interval: 30, correctCount: 3 });
		expect(fm).toContain("interval: 30");
		expect(fm).toContain("correctCount: 3");
	});

	it("emits empty source when no source name", () => {
		const fm = buildNoteFrontmatter("", "path", []);
		expect(fm).toContain("source: \"\"");
	});
});
