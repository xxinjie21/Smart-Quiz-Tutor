import { describe, it, expect } from "vitest";
import {
	getScopeFiles,
	retrieveContext,
	buildChatPrompt,
	tokenize,
	scoreByMeta,
	scoreByContent,
	rankCandidates,
	buildReferenceBlock,
	type RetrievedChunk,
	type ScopeFile,
} from "../src/services/chatService";

const sampleFiles: ScopeFile[] = [
	{ path: "题目/三角函数_试题.md", basename: "三角函数_试题" },
	{ path: "题目/知识点/三角函数.md", basename: "三角函数" },
	{ path: "笔记/物理笔记.md", basename: "物理笔记" },
	{ path: "其他/随便.md", basename: "随便" },
];

describe("getScopeFiles", () => {
	it("keeps all files when scope is vault", () => {
		const res = getScopeFiles(sampleFiles, "vault", ["智学助手/题目", "智学助手/笔记"]);
		expect(res).toHaveLength(sampleFiles.length);
	});

	it("filters to plugin dirs when scope is plugin", () => {
		const res = getScopeFiles(sampleFiles, "plugin", ["题目", "笔记"]);
		expect(res.map(f => f.basename)).toEqual(["三角函数_试题", "三角函数", "物理笔记"]);
	});

	it("handles trailing slash in plugin dirs", () => {
		const res = getScopeFiles(sampleFiles, "plugin", ["题目/"]);
		expect(res.map(f => f.basename)).toEqual(["三角函数_试题", "三角函数"]);
	});
});

describe("retrieveContext", () => {
	it("ranks files by keyword hits and returns top-k with snippets", () => {
		const contents: Record<string, string> = {
			"题目/三角函数_试题.md": "三角函数公式 sin、cos、tan 定义",
			"笔记/物理笔记.md": "这是一篇完全无关的物理笔记，讨论力学和能量守恒。",
		};
		const res = retrieveContext("三角函数", [
			{ path: "题目/三角函数_试题.md", basename: "三角函数_试题" },
			{ path: "笔记/物理笔记.md", basename: "物理笔记" },
		], contents, 5);
		expect(res.length).toBe(1);
		expect(res[0]!.basename).toBe("三角函数_试题");
		expect(res[0]!.score).toBeGreaterThan(0);
		expect(res[0]!.snippet).toContain("三角函数");
	});

	it("returns empty when no terms qualify", () => {
		const res = retrieveContext("a", sampleFiles, {}, 5);
		expect(res).toEqual([]);
	});

	it("respects the limit", () => {
		const contents: Record<string, string> = {
			"题目/三角函数_试题.md": "三角函数 sin",
			"题目/知识点/三角函数.md": "三角函数定义",
			"笔记/物理笔记.md": "三角函数在物理中的应用",
		};
		const res = retrieveContext("三角函数", sampleFiles, contents, 2);
		expect(res.length).toBeLessThanOrEqual(2);
	});
});

describe("buildChatPrompt", () => {
	const chunks: RetrievedChunk[] = [
		{ path: "题目/三角函数_试题.md", basename: "三角函数_试题", score: 5, snippet: "三角函数公式 sin" },
	];

	it("includes reference material and source markers", () => {
		const prompt = buildChatPrompt("什么是三角函数？", chunks, "plugin");
		expect(prompt).toContain("三角函数");
		expect(prompt).toContain("【来源：[[三角函数_试题]]】");
		expect(prompt).toContain("插件知识库");
	});

	it("falls back to plain question when no context", () => {
		const prompt = buildChatPrompt("什么是三角函数？", [], "vault");
		expect(prompt).toContain("什么是三角函数？");
		expect(prompt).not.toContain("【来源：");
	});
});

describe("tokenize", () => {
	it("splits CJK into bigrams and trigrams", () => {
		const terms = tokenize("中医电子病历");
		expect(terms).toContain("中医");
		expect(terms).toContain("电子");
		expect(terms).toContain("病历");
		expect(terms).toContain("中医电");
	});

	it("keeps latin words (>=2) and drops single latin chars", () => {
		expect(tokenize("a b cd Redis")).toEqual(["cd", "redis"]);
	});

	it("handles mixed CJK + latin", () => {
		const terms = tokenize("Redis 分布式锁");
		expect(terms).toContain("redis");
		expect(terms).toContain("分布式");
	});

	it("dedupes and returns empty for punctuation-only input", () => {
		expect(tokenize("aa aa aa")).toEqual(["aa"]);
		expect(tokenize("，。！？")).toEqual([]);
		expect(tokenize("")).toEqual([]);
	});
});

describe("scoring", () => {
	it("weights filename hits above path hits", () => {
		const terms = tokenize("三角函数");
		const nameHit = scoreByMeta(terms, "三角函数", "a/b.md");
		const pathHit = scoreByMeta(terms, "无关名字", "三角函数/x.md");
		expect(nameHit).toBeGreaterThan(pathHit);
	});

	it("caps content occurrences per term at 3", () => {
		const terms = ["ab"];
		expect(scoreByContent(terms, "ab ab")).toBe(2);
		expect(scoreByContent(terms, "ab ab ab ab ab")).toBe(3);
	});
});

describe("rankCandidates", () => {
	const files: ScopeFile[] = [
		{ path: "a/普通笔记.md", basename: "普通笔记" },
		{ path: "a/三角函数.md", basename: "三角函数" },
	];

	it("puts name matches first and respects the cap", () => {
		const ranked = rankCandidates("三角函数", files, 1);
		expect(ranked).toHaveLength(1);
		expect(ranked[0]!.basename).toBe("三角函数");
	});

	it("falls back to original order when query has no terms", () => {
		expect(rankCandidates("，。", files, 2).map(f => f.basename)).toEqual(["普通笔记", "三角函数"]);
	});
});

describe("buildReferenceBlock", () => {
	it("returns empty string when there are no references", () => {
		expect(buildReferenceBlock([], 1000)).toBe("");
	});

	it("includes name, selection marker and instruction", () => {
		const out = buildReferenceBlock([{ name: "笔记A", text: "内容内容", isSelection: true }], 1000);
		expect(out).toContain("【笔记A（选中片段）】");
		expect(out).toContain("内容内容");
		expect(out).toContain("回答请优先依据以上引用文件的内容与思想");
	});

	it("truncates later references once the budget is exhausted", () => {
		const out = buildReferenceBlock([
			{ name: "A", text: "x".repeat(60), isSelection: false },
			{ name: "B", text: "b".repeat(60), isSelection: false },
		], 50);
		expect(out).toContain("【A】");
		expect(out).not.toContain("【B】");
		expect(out).not.toContain("x".repeat(60));
	});
});