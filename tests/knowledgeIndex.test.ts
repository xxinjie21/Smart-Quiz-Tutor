import { describe, it, expect } from "vitest";
import { TFile, TFolder } from "obsidian";
import { parseIndexSections, buildIndexBody, isKnowledgeIndexContent, KnowledgeService, type IndexSource } from "../src/services/knowledgeService";

describe("parseIndexSections", () => {
	it("parses three source sections separately", () => {
		const content = [
			"---",
			"tags: [知识点]",
			"---",
			"# 二次函数",
			"",
			"## 相关题目",
			"- [[函数_试题_A]]",
			"",
			"## 相关笔记",
			"- [[数学笔记_函数]]",
			"- [[代数笔记_图像]]",
			"",
			"## 相关错题",
			"- [[错题_01]]",
		].join("\n");
		const sections = parseIndexSections(content);
		expect(sections["题目"]).toEqual(["函数_试题_A"]);
		expect(sections["笔记"]).toEqual(["数学笔记_函数", "代数笔记_图像"]);
		expect(sections["错题"]).toEqual(["错题_01"]);
	});

	it("ignores content outside the three sections", () => {
		const content = "标题\n[[无段链接]]\n\n## 相关笔记\n- [[甲]]\n\n结尾 [[乙]]";
		const sections = parseIndexSections(content);
		expect(sections["笔记"]).toEqual(["甲", "乙"]);
		expect(sections["题目"]).toEqual([]);
		expect(sections["错题"]).toEqual([]);
	});

	it("dedupes repeated links", () => {
		const content = "## 相关错题\n- [[重复]]\n- [[重复]]\n- [[其他]]";
		expect(parseIndexSections(content)["错题"]).toEqual(["重复", "其他"]);
	});
});

describe("isKnowledgeIndexContent", () => {
	it("detects auto-generated index frontmatter", () => {
		expect(isKnowledgeIndexContent("---\ntags: [知识点]\n---\n# 二次函数")).toBe(true);
		expect(isKnowledgeIndexContent(buildIndexBody("tag", { 题目: [], 笔记: [], 错题: [] }))).toBe(true);
	});

	it("rejects handwritten files", () => {
		expect(isKnowledgeIndexContent("# 手写笔记\n\n正文")).toBe(false);
		expect(isKnowledgeIndexContent("---\ntags: [数学]\n---\n# 手写")).toBe(false);
		expect(isKnowledgeIndexContent("")).toBe(false);
	});
});

describe("buildIndexBody", () => {
	it("builds three-section index body with sorted links", () => {
		const sections: Record<IndexSource, string[]> = {
			题目: ["函数_试题_A"],
			笔记: ["代数笔记_图像", "数学笔记_函数"],
			错题: [],
		};
		const body = buildIndexBody("二次函数", sections);
		expect(body).toContain("## 相关题目");
		expect(body).toContain("## 相关笔记");
		expect(body).toContain("## 相关错题");
		expect(body).toContain("- [[函数_试题_A]]");
		expect(body).toContain("- [[代数笔记_图像]]\n- [[数学笔记_函数]]");
		expect(body).toContain("## 相关错题\n暂无");
		expect(body).toContain("---\ntags: [知识点]\n---");
	});

	it("round-trips through parseIndexSections", () => {
		const sections: Record<IndexSource, string[]> = {
			题目: ["b", "a"],
			笔记: ["n1"],
			错题: ["w1", "w2"],
		};
		const body = buildIndexBody("tag", sections);
		const parsed = parseIndexSections(body);
		expect(parsed["题目"]).toEqual(["a", "b"]);
		expect(parsed["笔记"]).toEqual(["n1"]);
		expect(parsed["错题"]).toEqual(["w1", "w2"]);
	});
});

describe("rebuildKnowledgeIndex stale-file cleanup", () => {
	function makeVault() {
		const children: TFile[] = [];
		const folder = new TFolder();
		folder.name = "知识点";
		folder.path = "知识点";
		folder.children = children;
		const app: any = {
			vault: {
				getAbstractFileByPath: (p: string) => (p === "知识点" ? folder : null),
				read: async (f: TFile) => (f as any).content ?? "",
				modify: async () => {},
				create: async () => {},
				getFiles: () => [],
			},
			fileManager: {
				trashFile: async (f: TFile) => {
					const i = children.indexOf(f);
					if (i >= 0) children.splice(i, 1);
				},
			},
		};
		return { app, folder, children };
	}
	function makeFile(name: string, content: string): TFile {
		const f = new TFile();
		Object.assign(f, { basename: name, name: name + ".md", path: "知识点/" + name + ".md", content });
		return f;
	}
	function makeProvider(app: any) {
		return {
			app,
			settings: { knowledgeFolder: "知识点", wrongBookFolder: "错题", questionFolder: "题目", noteViewFolder: "笔记" },
			rootPath: (sub: string) => sub,
			loadAllWrongNotes: async () => [],
			invalidateCache: () => {},
		};
	}

	it("removes ALL stale index files in one rebuild (no skipped deletion)", async () => {
		const { app, folder, children } = makeVault();
		const stale = [
			makeFile("废弃A", buildIndexBody("废弃A", { 题目: [], 笔记: [], 错题: [] })),
			makeFile("废弃B", buildIndexBody("废弃B", { 题目: [], 笔记: [], 错题: [] })),
			makeFile("废弃C", buildIndexBody("废弃C", { 题目: [], 笔记: [], 错题: [] })),
			makeFile("废弃D", buildIndexBody("废弃D", { 题目: [], 笔记: [], 错题: [] })),
		];
		const hw = makeFile("手写笔记", "# 手写笔记\n\n手写内容，不应被删除。");
		children.push(...stale, hw);

		await new KnowledgeService(makeProvider(app)).rebuildKnowledgeIndex();

		expect(folder.children.map((c: TFile) => c.basename)).toEqual(["手写笔记"]);
		expect(stale.every(f => !children.includes(f))).toBe(true);
	});
});

describe("rebuildKnowledgeIndex vault-relative create+cleanup", () => {
	function makeInMemoryVault() {
		const files: TFile[] = [];
		const getStore = () => files;
		const pathOf = (p: string) => { const f = files.find(x => x.path === p); return f ?? null; };
		const addFile = (absPath: string, content: string): TFile => {
			const f = new TFile();
			const segs = absPath.split("/");
			Object.assign(f, { content, path: absPath, name: segs[segs.length - 1]!, basename: segs[segs.length - 1]!.replace(/\.md$/, ""), extension: "md" });
			files.push(f);
			return f;
		};
		const app: any = {
			vault: {
				getFiles: () => files,
				getAbstractFileByPath: (p: string) => {
					if (p === "题目" || p === "笔记" || p === "错题" || p === "知识点") {
						const dir = new TFolder();
						dir.name = p;
						dir.path = p;
						Object.defineProperty(dir, "children", { get() { return files.filter(f => f.path.startsWith(p + "/")); } });
						return dir;
					}
					return pathOf(p);
				},
				read: async (f: TFile) => (f as any).content ?? "",
				modify: async (f: TFile, c: string) => { (f as any).content = c; },
				create: async (p: string, c: string) => addFile(p, c),
			},
			fileManager: {
				trashFile: async (f: TFile) => { const i = files.indexOf(f); if (i >= 0) files.splice(i, 1); },
			},
		};
		return { app, files, addFile };
	}
	function providerFor(app: any) {
		return {
			app,
			settings: { knowledgeFolder: "知识点", wrongBookFolder: "错题", questionFolder: "题目", noteViewFolder: "笔记" },
			rootPath: (s: string) => s,
			loadAllWrongNotes: async () => [],
			invalidateCache: () => {},
		};
	}

	it("creates index files for every referenced knowledge tag from questions/notes/wrong, removes stale, keeps handwritten", async () => {
		const { app, files, addFile } = makeInMemoryVault();
		// knowledge folder: one existing index + handwritten + stale
		addFile("知识点/函数.md", buildIndexBody("函数", { 题目: [], 笔记: [], 错题: [] }));
		addFile("知识点/手写笔记.md", "# 手写笔记\n\n正文，不应删除。");
		addFile("知识点/废弃知识点.md", buildIndexBody("废弃知识点", { 题目: [], 笔记: [], 错题: [] }));

		// questions (题目 folder) with knowledge tags
		addFile("题目/函数_试题.md", "---\ntags: [题目, 函数, 导数]\n---\n\n### 单选题\n1. 定义\n答案：A");
		addFile("题目/二次函数_试题.md", "---\ntags: [题目, 二次函数]\n---\n\n题");
		// note with knowledge tag
		addFile("笔记/函数笔记.md", "---\ntags: [笔记, 函数]\n---\n\n笔记内容");

		const ks = new KnowledgeService(providerFor(app));
		await ks.rebuildKnowledgeIndex();

		const idxNames = files.filter(f => f.path.startsWith("知识点/")).map(f => f.basename);
		expect(idxNames).toContain("函数");
		expect(idxNames).toContain("导数");
		expect(idxNames).toContain("二次函数");
		expect(idxNames).toContain("手写笔记");
		expect(idxNames).not.toContain("废弃知识点");
		// no duplicate index files
		const funcCount = files.filter(f => f.path === "知识点/函数.md").length;
		expect(funcCount).toBe(1);
	});

	it("continues creating other indexes when one tag write fails (no partial aborted rebuild)", async () => {
		const { app, files, addFile } = makeInMemoryVault();
		// three referenced tags, one of which will fail to write
		addFile("题目/函数_试题.md", "---\ntags: [题目, 函数]\n---\n\n题");
		addFile("题目/导数_试题.md", "---\ntags: [题目, 导数]\n---\n\n题");
		addFile("题目/二次函数_试题.md", "---\ntags: [题目, 二次函数]\n---\n\n题");
		// one tag whose write fails (e.g. vault.create throws for that path)
		const failPaths = new Set<string>(["知识点/二次函数.md"]);
		const originalCreate = app.vault.create;
		app.vault.create = async (p: string, c: string) => {
			if (failPaths.has(p)) throw new Error("create rejected");
			return addFile(p, c);
		};

		const ks = new KnowledgeService(providerFor(app));
		await expect(ks.rebuildKnowledgeIndex()).resolves.not.toThrow();

		// 函数/导数 created despite a sibling tag failing; 二次函数 skipped, not aborted
		const names = files.filter(f => f.path.startsWith("知识点/")).map(f => f.basename);
		expect(names).toContain("函数");
		expect(names).toContain("导数");
		expect(names).not.toContain("二次函数");

		// when the failure clears, a later rebuild completes the missing index
		app.vault.create = originalCreate;
		failPaths.clear();
		await new KnowledgeService(providerFor(app)).rebuildKnowledgeIndex();
		expect(files.filter(f => f.path.startsWith("知识点/")).map(f => f.basename)).toContain("二次函数");
	});
});
