import { describe, it, expect } from "vitest";
import { extractKnowledgeTags } from "../src/utils/tags";
import { MAX_EXTRACTED_TAGS } from "../src/constants";

describe("extractKnowledgeTags", () => {
	it("extracts weighted segments from the source name and strips the 错题 suffix", () => {
		const tags = extractKnowledgeTags("Claude_Code_完整项目分步规划_错题_2026-08-01", "");
		expect(tags).toContain("完整项目分步规划");
		expect(tags).toContain("Claude");
		expect(tags).not.toContain("错题");
	});

	it("drops chapter-number segments", () => {
		const tags = extractKnowledgeTags("第一章", "");
		expect(tags).not.toContain("第一章");
	});

	it("drops english stop words but keeps content words", () => {
		const tags = extractKnowledgeTags("RAG", "the model will answer via retrieval");
		const lower = tags.map(x => x.toLowerCase());
		expect(lower).not.toContain("the");
		expect(lower).not.toContain("via");
		expect(lower).toContain("retrieval");
	});

	it("caps the number of tags", () => {
		const tags = extractKnowledgeTags("x", "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda");
		expect(tags.length).toBeLessThanOrEqual(MAX_EXTRACTED_TAGS);
	});

	it("dedupes repeated terms", () => {
		const tags = extractKnowledgeTags("", "Redis Redis Redis");
		expect(tags.filter(x => x.toLowerCase() === "redis")).toHaveLength(1);
	});
});
