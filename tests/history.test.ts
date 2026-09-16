import { describe, it, expect } from "vitest";
import { pruneHistory } from "../src/utils/history";
import type { HistoryEntry } from "../src/types";

function entry(id: number, resultLen: number): HistoryEntry {
	return {
		id: String(id),
		timestamp: id,
		fileName: "f" + id,
		sourceSnippet: "s",
		resultText: "x".repeat(resultLen),
		sourcePath: "p",
	};
}

describe("pruneHistory", () => {
	it("returns the same array when empty", () => {
		expect(pruneHistory([], 10, 5)).toEqual([]);
	});

	it("keeps only the most recent maxEntries", () => {
		const input = [entry(1, 0), entry(2, 0), entry(3, 0)];
		const out = pruneHistory(input, 2, 100);
		expect(out.map(e => e.id)).toEqual(["2", "3"]);
	});

	it("truncates resultText to maxResultChars", () => {
		const out = pruneHistory([entry(1, 500)], 10, 100);
		expect(out[0]!.resultText).toHaveLength(100);
	});

	it("does not mutate the input entries", () => {
		const input = [entry(1, 500)];
		pruneHistory(input, 10, 100);
		expect(input[0]!.resultText).toHaveLength(500);
	});
});
