import { describe, it, expect } from "vitest";
import {
	getScopeFiles,
	retrieveContext,
	buildChatPrompt,
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