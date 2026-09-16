import { describe, it, expect } from "vitest";
import { extractIndexLinks, indexFileSections } from "../src/views/sidebar/knowledge";

describe("extractIndexLinks", () => {
	it("extracts wikilink targets and strips aliases", () => {
		expect(extractIndexLinks("[[A]] and [[B|alias]]")).toEqual(["A", "B"]);
	});

	it("returns an empty list when there are no links", () => {
		expect(extractIndexLinks("no links here")).toEqual([]);
	});
});

describe("indexFileSections", () => {
	it("returns the sections that contain links", () => {
		const content = "## 相关题目\n[[Q1]]\n## 相关笔记\n暂无\n## 相关错题\n[[W1]]";
		expect(indexFileSections(content)).toEqual(["题目索引", "错题索引"]);
	});

	it("returns empty when no section has links", () => {
		expect(indexFileSections("## 相关题目\n暂无\n## 相关笔记\n暂无")).toEqual([]);
	});
});
