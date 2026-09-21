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
	cutAtBoundary,
	selectRelevantSnippets,
	distributeBudget,
	isCasualQuery,
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

	it("distributes the budget fairly across references instead of dropping later ones", () => {
		const out = buildReferenceBlock([
			{ name: "A", text: "x".repeat(60), isSelection: false },
			{ name: "B", text: "b".repeat(60), isSelection: false },
		], 150);
		expect(out).toContain("【A】");
		expect(out).toContain("【B】");
		expect(out).not.toContain("x".repeat(60));
		expect(out).not.toContain("b".repeat(60));
		expect(out).toContain("部分引用因长度受限");
	});

	it("includes relevant snippets when a query is provided", () => {
		const long = "开头内容。".repeat(500) + "关键命中词出现在这里" + "尾部内容。".repeat(500);
		const out = buildReferenceBlock([{ name: "长文", text: long, isSelection: false }], 3000, { query: "关键命中词" });
		expect(out).toContain("【长文】");
		expect(out).toContain("相关片段");
		expect(out).toContain("关键命中词");
	});

	it("is deterministic for the same input", () => {
		const refs = [{ name: "A", text: "内容".repeat(500), isSelection: false }];
		expect(buildReferenceBlock(refs, 1000, { query: "内容" })).toBe(buildReferenceBlock(refs, 1000, { query: "内容" }));
	});
});

describe("cutAtBoundary", () => {
	it("cuts at a paragraph boundary when possible", () => {
		const text = "第一段。\n\n第二段很长很长很长很长很长很长很长很长很长";
		const cut = cutAtBoundary(text, 7);
		expect(cut).toBe("第一段。\n\n");
	});
	it("returns the original text when within limit", () => {
		expect(cutAtBoundary("短", 10)).toBe("短");
	});
});

describe("distributeBudget", () => {
	it("gives each equal share when all are long", () => {
		expect(distributeBudget([100, 100], 40)).toEqual([20, 20]);
	});
	it("redistributes leftover from short references", () => {
		expect(distributeBudget([5, 100], 40)).toEqual([5, 35]);
	});
});

describe("selectRelevantSnippets", () => {
	it("returns snippets around query terms", () => {
		const text = "aaaa".repeat(50) + "TARGET" + "bbbb".repeat(50);
		const out = selectRelevantSnippets(text, ["target"], 40, 3);
		expect(out.length).toBe(1);
		expect(out[0]).toContain("TARGET");
	});
	it("returns empty when no term matches", () => {
		expect(selectRelevantSnippets("hello", ["zzz"], 40, 3)).toEqual([]);
	});
});

describe("isCasualQuery", () => {
	it("treats greetings and short queries as casual", () => {
		expect(isCasualQuery("你好")).toBe(true);
		expect(isCasualQuery("您好，请问在吗？")).toBe(true);
		expect(isCasualQuery("hi")).toBe(true);
		expect(isCasualQuery("Hello, how are you?")).toBe(true);
		expect(isCasualQuery("谢谢")).toBe(true);
		expect(isCasualQuery("你是谁")).toBe(true);
		expect(isCasualQuery("help")).toBe(true);
		expect(isCasualQuery("yes")).toBe(true);
	});

	it("keeps knowledge questions as retrievable", () => {
		expect(isCasualQuery("TCP 三次握手的过程是什么")).toBe(false);
		expect(isCasualQuery("请总结这篇文章的重点")).toBe(false);
		expect(isCasualQuery("SSE 流式输出怎么实现")).toBe(false);
		expect(isCasualQuery("复习错题里的知识点")).toBe(false);
	});
});
