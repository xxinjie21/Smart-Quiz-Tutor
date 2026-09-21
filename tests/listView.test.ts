import { describe, it, expect } from "vitest";
import { groupBySource, groupByTag, formatFileSize, formatDateShort } from "../src/utils/listView";

interface Item { name: string; source: string; tags: string[]; }

const items: Item[] = [
	{ name: "a", source: "[[X]]", tags: ["t1"] },
	{ name: "b", source: "X", tags: ["t1", "t2"] },
	{ name: "c", source: "Y", tags: [] },
	{ name: "d", source: "", tags: ["t2"] },
];

describe("groupBySource", () => {
	it("groups by source, strips wikilinks, sorts by count, separates noSource", () => {
		const { groups, noSource } = groupBySource(items, it => it.source);
		expect(groups.map(g => g.key)).toEqual(["X", "Y"]);
		expect(groups[0]!.items.map(i => i.name)).toEqual(["a", "b"]);
		expect(noSource.map(i => i.name)).toEqual(["d"]);
	});

	it("handles empty input", () => {
		const r = groupBySource<Item>([], () => "");
		expect(r.groups).toEqual([]);
		expect(r.noSource).toEqual([]);
	});
});

describe("groupByTag", () => {
	it("groups by tag (item may appear in multiple groups) and separates untagged", () => {
		const { groups, untagged } = groupByTag(items, it => it.tags);
		expect(groups.find(g => g.key === "t1")!.items.map(i => i.name)).toEqual(["a", "b"]);
		expect(groups.find(g => g.key === "t2")!.items.map(i => i.name)).toEqual(["b", "d"]);
		expect(untagged.map(i => i.name)).toEqual(["c"]);
	});
});

describe("format helpers", () => {
	it("formats file size to KB", () => {
		expect(formatFileSize(1024)).toBe("1KB");
	});
	it("formats short date m/d", () => {
		expect(formatDateShort(new Date(2026, 8, 3).getTime())).toBe("9/3");
	});
});