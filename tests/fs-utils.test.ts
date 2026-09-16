import { describe, it, expect } from "vitest";
import { ensureFolder } from "../src/utils/fs-utils";
import type { App } from "obsidian";

interface MockState {
	indexed: Set<string>;
	onDisk: Set<string>;
	createError?: string;
	created: string[];
}

function state(): MockState {
	return { indexed: new Set(), onDisk: new Set(), created: [] };
}

function makeApp(s: MockState): App {
	return {
		vault: {
			getAbstractFileByPath: (p: string) => (s.indexed.has(p) ? { path: p } : null),
			adapter: { exists: async (p: string) => s.onDisk.has(p) },
			createFolder: async (p: string) => {
				if (s.createError) throw new Error(s.createError);
				if (s.onDisk.has(p)) throw new Error("Folder already exists.");
				s.onDisk.add(p);
				s.created.push(p);
			},
		},
	} as unknown as App;
}

describe("ensureFolder", () => {
	it("creates nested folders parent-first when missing", async () => {
		const s = state();
		await ensureFolder(makeApp(s), "A/B/C");
		expect(s.created).toEqual(["A", "A/B", "A/B/C"]);
	});

	it("skips when the vault index already knows the path", async () => {
		const s = state();
		s.indexed.add("A");
		s.indexed.add("A/B");
		s.indexed.add("A/B/C");
		await ensureFolder(makeApp(s), "A/B/C");
		expect(s.created).toEqual([]);
	});

	it("skips when the path exists on disk but not yet in the index", async () => {
		const s = state();
		s.onDisk.add("A");
		s.onDisk.add("A/B");
		await ensureFolder(makeApp(s), "A/B");
		expect(s.created).toEqual([]);
	});

	it("swallows 'already exists' errors", async () => {
		const s = state();
		s.createError = "Folder already exists.";
		await expect(ensureFolder(makeApp(s), "A")).resolves.toBeUndefined();
		expect(s.created).toEqual([]);
	});

	it("rethrows unexpected create errors", async () => {
		const s = state();
		s.createError = "Permission denied";
		await expect(ensureFolder(makeApp(s), "A")).rejects.toThrow("Permission denied");
	});

	it("does nothing for an empty path", async () => {
		const s = state();
		await ensureFolder(makeApp(s), "");
		expect(s.created).toEqual([]);
	});
});
