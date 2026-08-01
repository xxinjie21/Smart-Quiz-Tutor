import { describe, it, expect } from "vitest";
import {
	parseFM,
	buildFM,
	safeName,
	cleanSourceText,
	estimateTokens,
	stripAnswersForExport,
	reviewUpdate,
	todayStr,
	isDueForReview,
	stripMd,
	parseQuestions,
	stripAnswerSummarySection,
	splitSemantic,
	normalizeAnswerSteps,
	splitAnswerContent,
	normalizeExamContent,
	htmlEscape,
	mergeExamChunks,
	listMdFilesRecursive,
	parseTypeSpec,
	buildGeneratePrompt,
} from "../src/main";

describe("parseFM", () => {
	it("parses frontmatter with inline array", () => {
		const { meta, body } = parseFM("---\ntitle: Test\ntags: [tag1, tag2]\n---\n\nBody content");
		expect(meta.title).toBe("Test");
		expect(meta.tags).toEqual(["tag1", "tag2"]);
		expect(body).toBe("Body content");
	});

	it("parses frontmatter with scalar values", () => {
		const { meta, body } = parseFM("---\nkey: value\ncount: 5\nflag: true\n---\n\nContent");
		expect(meta.key).toBe("value");
		expect(meta.count).toBe("5");
		expect(meta.flag).toBe(true);
		expect(body).toBe("Content");
	});

	it("returns empty meta for no frontmatter", () => {
		const { meta, body } = parseFM("Just content");
		expect(meta).toEqual({});
		expect(body).toBe("Just content");
	});
});

describe("buildFM", () => {
	it("builds frontmatter string", () => {
		const result = buildFM({ title: "Test", tags: ["a", "b"], count: 5 });
		expect(result).toContain('title: "Test"');
		expect(result).toContain("tags: [a, b]");
  expect(result).toContain("count: 5");
		expect(result.startsWith("---\n")).toBe(true);
		expect(result.endsWith("\n---\n\n")).toBe(true);
	});
});

describe("safeName", () => {
	it("sanitizes filenames", () => {
		expect(safeName("hello/world:test")).toBe("hello_world_test");
		expect(safeName("normal")).toBe("normal");
		expect(safeName("a<b>c\"d|e?f*g")).toBe("a_b_c_d_e_f_g");
	});
});

describe("cleanSourceText", () => {
	it("removes frontmatter markers but keeps content", () => {
		expect(cleanSourceText("---\ntitle: x\n---\n\nContent")).toBe("title: x\n\nContent");
	});

	it("returns text without frontmatter as-is", () => {
		expect(cleanSourceText("Hello World")).toBe("Hello World");
	});
});

describe("estimateTokens", () => {
	it("estimates token count", () => {
		const count = estimateTokens("Hello world");
		expect(count).toBeGreaterThan(0);
	});
});

describe("stripAnswersForExport", () => {
	it("removes answer lines", () => {
		const result = stripAnswersForExport("Q1\n答案：A\n解析：text\n\nQ2");
		expect(result).not.toContain("答案：");
		expect(result).toContain("Q1");
	});
});

describe("reviewUpdate", () => {
	it("increases interval on correct answer", () => {
		const result = reviewUpdate(0, true);
		expect(result.correctCount).toBe(1);
		expect(result.interval).toBeGreaterThan(0);
	});

	it("resets to 0 on wrong answer", () => {
		const result = reviewUpdate(3, false);
		expect(result.correctCount).toBe(0);
		expect(result.interval).toBe(1);
	});
});

describe("todayStr", () => {
	it("returns date in YYYY-MM-DD format", () => {
		expect(todayStr()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});

describe("isDueForReview", () => {
	it("returns true for past dates", () => {
		const note = {
			nextReview: "2020-01-01",
			interval: 1,
			correctCount: 0,
			wrongCount: 1,
		} as any;
		expect(isDueForReview(note)).toBe(true);
	});

	it("returns false for future dates", () => {
		const note = {
			nextReview: "2099-12-31",
			interval: 1,
			correctCount: 0,
			wrongCount: 1,
		} as any;
		expect(isDueForReview(note)).toBe(false);
	});
});

describe("stripMd", () => {
	it("removes bold and italic", () => {
		expect(stripMd("**bold** and *italic*")).toBe("bold and italic");
	});
});

describe("parseQuestions", () => {
	it("parses single choice question", () => {
		const result = parseQuestions("## 单选题\n1. Test question\nA. Opt1\nB. Opt2\n答案：A\n解析：Explanation");
		expect(result.length).toBe(1);
		expect(result[0]!.type).toBe("single");
		expect(result[0]!.number).toBe(1);
		expect(result[0]!.text).toContain("Test question");
		expect(result[0]!.answer).toBe("A");
		expect(result[0]!.options.length).toBe(2);
	});

	it("parses multiple choice question", () => {
		const result = parseQuestions("## 多选题\n1. Multi?\nA. Opt1\nB. Opt2\n答案：AB");
		expect(result.length).toBe(1);
		expect(result[0]!.type).toBe("multi");
		expect(result[0]!.answer).toBe("AB");
	});

	it("parses true/false question", () => {
		const result = parseQuestions("## 判断题\n1. True?\nA. 正确\nB. 错误\n答案：A");
		expect(result.length).toBe(1);
		expect(result[0]!.type).toBe("judge");
	});

	it("parses fill-in-the-blank question", () => {
		const result = parseQuestions("## 填空题\n1. Fill ___\n答案：answer");
		expect(result.length).toBe(1);
		expect(result[0]!.type).toBe("blank");
	});

	it("returns empty for no questions", () => {
		const result = parseQuestions("Just some text");
		expect(result.length).toBe(0);
	});

	it("keeps numbered answer sub-points inside their question", () => {
		const result = parseQuestions("## 简答题\n1. 题干A\n答案：\n1. 要点一\n2. 要点二\n解析：解释\n\n2. 题干B\n答案：这是完整答案\n解析：解释B");
		expect(result.length).toBe(2);
		expect(result[0]!.answer).toContain("要点一");
		expect(result[0]!.answer).toContain("要点二");
		expect(result[0]!.text).toContain("题干A");
		expect(result[1]!.answer).toBe("这是完整答案");
	});

	it("parses bold answer labels with renumbered sub-points", () => {
		const result = parseQuestions("## 简答题\n1. 提Issue应该带上哪些信息？\n**答案**：\n(1) 你运行的命令\n(2) 完整报错信息\n**解析**：需要携带6项信息");
		expect(result.length).toBe(1);
		expect(result[0]!.answer).toContain("你运行的命令");
		expect(result[0]!.answer).toContain("完整报错信息");
		expect(result[0]!.explanation).toBe("需要携带6项信息");
	});

	it("does not truncate at an empty answer line", () => {
		const input = "## 简答题\n1. 题干\n答案：\n1. 要点一\n2. 要点二\n解析：x\n\n2. 另一题\n答案：B答案\n解析：y";
		const result = parseQuestions(input);
		expect(result.length).toBe(2);
	});

	it("keeps multi-line essay answers intact", () => {
		const result = parseQuestions("## 简答题\n1. 题干\n答案：第一行内容\n第二行内容\n解析：解释");
		expect(result[0]!.answer).toBe("第一行内容\n第二行内容");
	});

	it("parses all questions of a merged multi-section exam", () => {
		const input = [
			"## 简答题",
			"1. 问题A",
			"答案：",
			"1. 甲",
			"2. 乙",
			"解析：xa",
			"",
			"2. 问题B",
			"答案：丙",
			"解析：xb",
			"",
			"## 简答题",
			"1. 问题C",
			"答案：",
			"1. 丁",
			"解析：xc",
		].join("\n");
		const result = parseQuestions(input);
		expect(result.length).toBe(3);
		expect(result[2]!.answer).toContain("丁");
	});

	it("parses consecutive objective questions without blank separators", () => {
		const result = parseQuestions("## 单选题\n1. Q1\nA. a\nB. b\n答案：A\n解析：e\n2. Q2\nA. c\nB. d\n答案：B\n解析：f");
		expect(result.length).toBe(2);
		expect(result[1]!.answer).toBe("B");
	});

	it("parses bold-numbered questions", () => {
		const result = parseQuestions("## 简答题\n**1.** 题干\n答案：回答\n解析：x");
		expect(result.length).toBe(1);
		expect(result[0]!.text).toContain("题干");
	});

	it("renumbers questions sequentially across sections", () => {
		const input = "## 单选题\n1. Q1\nA. a\nB. b\n答案：A\n解析：e\n\n## 判断题\n1. Q2\nA. 正确\nB. 错误\n答案：B\n解析：f";
		const result = parseQuestions(input);
		expect(result.map(q => q.number)).toEqual([1, 2]);
	});

	it("does not truncate the question at answer-group sub-headings like #### 阶段名称", () => {
		const input = [
			"## 简答题",
			"1. 请结合本章内容说明RAG的处理过程",
			"**答案：**",
			"#### 离线建库阶段",
			"(1) 文档加载",
			"(2) 文档清洗",
			"#### 在线问答阶段",
			"(1) 用户问题向量化",
			"*补充说明：清晰划分两阶段*",
			"",
			"**解析：**",
			"概述。",
			"1. 索引阶段",
			"2. 检索与生成阶段",
		].join("\n");
		const result = parseQuestions(input);
		expect(result.length).toBe(1);
		expect(result[0]!.text).toContain("RAG的处理过程");
		expect(result[0]!.answer).toContain("文档加载");
		expect(result[0]!.answer).toContain("用户问题向量化");
		expect(result[0]!.answer).toContain("补充说明：清晰划分两阶段");
		expect(result[0]!.explanation).toContain("概述。");
		expect(result[0]!.explanation).toContain("索引阶段");
		expect(result[0]!.explanation).toContain("检索与生成阶段");
	});

	it("parses essay answers with group sub-headings across a following empty line", () => {
		const input = [
			"## 简答题",
			"1. 题干",
			"答案：",
			"(1) 甲",
			"",
			"#### 第二阶段",
			"(1) 乙",
		].join("\n");
		const result = parseQuestions(input);
		expect(result.length).toBe(1);
		expect(result[0]!.answer).toContain("甲");
		expect(result[0]!.answer).toContain("第二阶段");
		expect(result[0]!.answer).toContain("乙");
	});

	it("parses single-line bold answers like **答案：A**", () => {
		const result = parseQuestions("## 单选题\n1. Q\nA. a\nB. b\n**答案：A**\n解析：x");
		expect(result.length).toBe(1);
		expect(result[0]!.answer).toBe("A");
	});

	it("keeps blockquote 补充说明 inside the essay answer", () => {
		const result = parseQuestions("## 简答题\n1. 题干\n答案：\n(1) 甲\n(2) 乙\n\n> 补充说明：这是提示\n解析：x");
		expect(result.length).toBe(1);
		expect(result[0]!.answer).toContain("补充说明：这是提示");
	});

	it("parses numbered explanation points into explanation without creating phantom questions", () => {
		const result = parseQuestions("## 单选题\n1. Q\nA. a\nB. b\n答案：A\n解析：\n(1) 说明第一点\n(2) 说明第二点");
		expect(result.length).toBe(1);
		expect(result[0]!.answer).toBe("A");
		expect(result[0]!.explanation).toBe("(1) 说明第一点\n(2) 说明第二点");
	});

	it("does not leak bold markers from bold-numbered question lines", () => {
		const result = parseQuestions("## 简答题\n**1.** 题干\n答案：回答\n解析：x");
		expect(result.length).toBe(1);
		expect(result[0]!.text).toBe("题干");
	});

	it("keeps numbered explanation sub-points intact for consistent rendering", () => {
		const result = parseQuestions("## 简答题\n1. 题干\n答案：A\n解析：\n1. 第一点\n2. 第二点");
		expect(result[0]!.explanation).toBe("1. 第一点\n2. 第二点");
	});
});

describe("stripAnswerSummarySection", () => {
	it("removes answer summary section", () => {
		const result = stripAnswerSummarySection("Content\n\n---\n\n答案汇总\n1. A\n2. B");
		expect(result).not.toContain("答案汇总");
	});
});

describe("splitAnswerContent", () => {
	it("splits numbered answers", () => {
		const result = splitAnswerContent("1. First\n2. Second");
		expect(result.length).toBe(2);
	});

	it("returns single answer as array", () => {
		const result = splitAnswerContent("Simple answer");
		expect(result.length).toBe(1);
	});

	it("splits parenthetical numbered points without dangling parens", () => {
		const result = splitAnswerContent("(1) 输出标准化需求文档 (2) 梳理核心业务 (3) 定义接口");
		expect(result).toEqual(["(1) 输出标准化需求文档", "(2) 梳理核心业务", "(3) 定义接口"]);
	});

	it("splits 顿号 numbered points without dangling parens", () => {
		const result = splitAnswerContent("1、输出标准化需求文档 2、梳理核心业务 3、定义接口");
		expect(result).toEqual(["1、输出标准化需求文档", "2、梳理核心业务", "3、定义接口"]);
	});

	it("splits parenthetical points across lines without dangling parens", () => {
		const result = splitAnswerContent("(1) 要点一\n(2) 要点二\n(3) 要点三");
		expect(result).toEqual(["(1) 要点一", "(2) 要点二", "(3) 要点三"]);
	});
});

describe("normalizeExamContent", () => {
	it("keeps decimal/version numbers on one line", () => {
		const result = normalizeExamContent("1. 填空题题干。\n答案：Python 3.10；Python 3.10；Python 3.13");
		expect(result).not.toContain("\n3.10");
		expect(result).not.toContain("\nPython\n");
		expect(result).toContain("**答案：Python 3.10；Python 3.10；Python 3.13**");
	});

	it("wraps short answer into a single bold line like **答案：内容**", () => {
		const result = normalizeExamContent("1. 简答题题干。\n答案：RAG本质是先检索再生成");
		expect(result).toContain("**答案：RAG本质是先检索再生成**");
	});

	it("wraps letter answers into a single bold line", () => {
		const single = normalizeExamContent("1. 题干\nA. a\nB. b\n答案：A\n解析：x");
		expect(single).toContain("**答案：A**");
		const multi = normalizeExamContent("1. 题干\nA. a\nB. b\n答案：AB\n解析：x");
		expect(multi).toContain("**答案：AB**");
	});

	it("wraps fill-blank answers into a single bold line", () => {
		const result = normalizeExamContent("1. 本仓库定位为______学习资料。\n答案：Python智能体");
		expect(result).toContain("**答案：Python智能体**");
	});

	it("renumbers answer sub-points from 1 instead of using question-style numbers", () => {
		const result = normalizeExamContent("3. 提Issue应该带上哪些信息？\n答案：4.你运行的命令 5.完整报错信息 6.Python版本\n解析：需要携带6项信息");
		expect(result).toContain("**答案：**\n(1) 你运行的命令\n(2) 完整报错信息\n(3) Python版本");
		expect(result).not.toContain("\n4.你运行的命令");
		expect(result).toContain("**解析：**\n需要携带6项信息");
	});

	it("renumbers multi-line answer sub-points inside the answer block", () => {
		const result = normalizeExamContent("4. 本仓库使用了哪些Docsify扩展？\n答案：\n5. docsify-darklight-theme\n6. 全文搜索\n7. zoom-image\n解析：见文档第8节");
		expect(result).toContain("**答案：**\n(1) docsify-darklight-theme\n(2) 全文搜索\n(3) zoom-image");
	});

	it("splits numbered answer points onto separate lines", () => {
		const result = normalizeExamContent("1. 简答题题干。\n答案：1. 要点一 2. 要点二 3. 要点三");
		expect(result).toContain("**答案：**\n(1) 要点一\n(2) 要点二\n(3) 要点三");
	});

	it("keeps multi-line answer sub-points contiguous without blank insertion", () => {
		const input = "## 简答题\n1. 题干\n答案：\n1. 要点一\n2. 要点二\n\n解析：x\n\n## 简答题\n2. 题干二\n答案：B\n解析：y";
		const result = normalizeExamContent(input);
		expect(result).toContain("**答案：**\n(1) 要点一\n(2) 要点二");
		expect(result).not.toContain("(1) 要点一\n\n(2) 要点二");
		expect(result).toContain("2. 题干二");
	});

	it("drops empty sub-point placeholders like (1)()", () => {
		const result = normalizeExamContent("1. 题干\n答案：\n(1)()\n(2) 真实要点\n(3)（ ）");
		expect(result).toContain("**答案：**\n(1) 真实要点");
		expect(result).not.toContain("()");
	});

	it("keeps group sub-headings, restarts numbering inside each group, and uses blockquote for 补充说明", () => {
		const input = [
			"1. 请结合本章内容说明RAG的处理过程",
			"答案：",
			"1. 文档加载",
			"2. 文档清洗",
			"#### 在线问答阶段",
			"1. 用户问题向量化",
			"2. 生成回答",
			"*补充说明：清晰划分两阶段可简化排障工作*",
			"解析：第一句概述。1. 索引阶段面向原始文档 2. 检索与生成阶段",
		].join("\n");
		const result = normalizeExamContent(input);
		expect(result).toContain("**答案：**\n(1) 文档加载\n(2) 文档清洗\n#### 在线问答阶段\n(1) 用户问题向量化\n(2) 生成回答");
		expect(result).toContain("> 补充说明：清晰划分两阶段可简化排障工作");
		expect(result).not.toContain("*补充说明");
		expect(result).toContain("**解析：**\n第一句概述。\n(1) 索引阶段面向原始文档\n(2) 检索与生成阶段");
		expect(result).not.toContain("\n1. 索引阶段");
	});

	it("renumbers runaway sequential numbers inside explanation into (1)(2)(3)", () => {
		const result = normalizeExamContent("1. 题干\n答案：A\n解析：\n2. 根据文档内容说明第一点\n3. 选项B的说明\n4. 补充第三点");
		expect(result).toContain("**解析：**\n(1) 根据文档内容说明第一点\n(2) 选项B的说明\n(3) 补充第三点");
		expect(result).not.toContain("\n2. 根据文档内容");
	});

	it("accepts bold labels with inner colon like **答案：**", () => {
		const result = normalizeExamContent("1. 题干\n**答案：**\n(1) 要点一\n(2) 要点二\n**解析：**\n解释文本");
		expect(result).toContain("**答案：**\n(1) 要点一\n(2) 要点二");
		expect(result).toContain("**解析：**\n解释文本");
	});

	it("accepts blockquote 补充说明 without change", () => {
		const result = normalizeExamContent("1. 题干\n答案：A\n> 补充说明：这里是提示\n解析：x");
		expect(result).toContain("> 补充说明：这里是提示");
	});
});

describe("mergeExamChunks", () => {
	it("merges duplicate type sections and renumbers sequentially", () => {
		const input = "## 简答题\n1. 问题A\n答案：甲\n解析：x\n\n20. 问题B\n答案：乙\n解析：y\n\n## 简答题\n1. 问题C\n答案：丙\n解析：z\n\n知识点：a, b";
		const result = mergeExamChunks(input);
		expect((result.match(/^## 简答题/gm) || []).length).toBe(1);
		expect(result).toContain("1. 问题A");
		expect(result).toContain("2. 问题B");
		expect(result).toContain("3. 问题C");
		expect(result).toContain("知识点：a, b");
	});

	it("keeps answer sub-points inside their question block", () => {
		const input = "## 简答题\n1. 题干\n答案：\n1. 要点一\n2. 要点二\n解析：解释\n\n2. 另一题\n答案：答案2\n解析：解释2";
		const result = mergeExamChunks(input);
		expect(result).toContain("1. 题干\n答案：\n1. 要点一\n2. 要点二\n解析：解释");
		expect(result).toContain("2. 另一题");
	});

	it("repairs broken number lines like BM25", () => {
		const input = "## 简答题\n1. 题干\n答案：向量检索、BM\n2\n5、混合检索\n解析：x";
		const result = mergeExamChunks(input);
		expect(result).toContain("BM25、混合检索");
		expect(result).not.toContain("\n2\n5、");
	});

	it("strips intermediate knowledge lines but keeps the last one", () => {
		const input = "## 单选题\n1. 题一\n答案：A\n解析：x\n\n知识点：mid\n## 单选题\n2. 题二\n答案：B\n解析：y\n\n知识点：final";
		const result = mergeExamChunks(input);
		expect(result).not.toContain("知识点：mid");
		expect(result).toContain("知识点：final");
	});

	it("dedupes identical questions across chunk overlap", () => {
		const input = "## 简答题\n1. 重复题\n答案：A\n解析：x\n\n## 简答题\n1. 重复题\n答案：A\n解析：x\n\n知识点：t";
		const result = mergeExamChunks(input);
		expect((result.match(/重复题/g) || []).length).toBe(1);
	});
});

describe("htmlEscape", () => {
	it("escapes HTML special chars", () => {
		expect(htmlEscape("<div>\"test\"&</div>")).toBe("&lt;div&gt;&quot;test&quot;&amp;&lt;/div&gt;");
	});
});

describe("listMdFilesRecursive", () => {
	it("lists md files in nested folders recursively", () => {
		const root = __dirname + "/fixtures-recursive";
		const sub = root + "/sub";
		require("fs").mkdirSync(sub, { recursive: true });
		require("fs").writeFileSync(root + "/a.md", "x");
		require("fs").writeFileSync(root + "/b.txt", "x");
		require("fs").writeFileSync(sub + "/c.md", "x");
		try {
			const files = listMdFilesRecursive(root).map(f => f.replace(/\\/g, "/"));
			expect(files.some(f => f.endsWith("a.md"))).toBe(true);
			expect(files.some(f => f.endsWith("c.md"))).toBe(true);
			expect(files.every(f => f.endsWith(".md"))).toBe(true);
		} finally {
			require("fs").rmSync(root, { recursive: true, force: true });
		}
	});

	it("skips excluded subfolders", () => {
		const root = __dirname + "/fixtures-excluded";
		const excl = root + "/知识点";
		require("fs").mkdirSync(excl, { recursive: true });
		require("fs").writeFileSync(root + "/q.md", "x");
		require("fs").writeFileSync(excl + "/knowledge.md", "x");
		try {
			const files = listMdFilesRecursive(root, [excl]).map(f => f.replace(/\\/g, "/"));
			expect(files.some(f => f.endsWith("q.md"))).toBe(true);
			expect(files.every(f => !f.includes("/知识点/"))).toBe(true);
		} finally {
			require("fs").rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("parseTypeSpec", () => {
	it("parses 题型+数量 pairs joined by 、", () => {
		expect(parseTypeSpec("单选题5、多选题3、判断题5、填空题2、简答题2")).toEqual([
			{ type: "单选题", count: 5 },
			{ type: "多选题", count: 3 },
			{ type: "判断题", count: 5 },
			{ type: "填空题", count: 2 },
			{ type: "简答题", count: 2 },
		]);
	});
	it("ignores non-numeric pieces", () => {
		expect(parseTypeSpec("单选题2、薄弱点、判断题4")).toEqual([
			{ type: "单选题", count: 2 },
			{ type: "判断题", count: 4 },
		]);
	});
	it("returns empty for free-text spec", () => {
		expect(parseTypeSpec("薄弱点定向生成")).toEqual([]);
	});
});

describe("buildGeneratePrompt", () => {
	it("embeds required type counts and warns against other types", () => {
		const p = buildGeneratePrompt("原文", "单选题5、判断题2", []);
		expect(p).toContain("只允许出下面列出的题型与数量");
		expect(p).toContain("单选题：5 道");
		expect(p).toContain("判断题：2 道");
		expect(p).toContain("题目数量：单选题5、判断题2");
	});
	it("when no numeric spec, falls back to generic output", () => {
		const p = buildGeneratePrompt("原文", "薄弱点定向生成", []);
		expect(p).toContain("5 道左右不同题型的题目");
		expect(p).not.toContain("只允许出下面列出的题型与数量");
	});
});
