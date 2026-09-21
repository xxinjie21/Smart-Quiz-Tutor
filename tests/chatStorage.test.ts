import { describe, it, expect } from "vitest";
import {
	autoTitle,
	genId,
	capMessages,
	createSession,
	loadSession,
	loadSessions,
	saveSession,
	renameSession,
	setSessionScope,
	deleteSession,
	setActiveSession,
	loadMeta,
	type ChatAdapter,
} from "../src/utils/chatStorage";
import { CHAT_HISTORY_LIMIT } from "../src/constants";

class MemoryAdapter implements ChatAdapter {
	private store = new Map<string, string>();
	private dirs = new Set<string>();

	async read(path: string) { return this.store.has(path) ? this.store.get(path)! : null; }
	async write(path: string, data: string) { this.store.set(path, data); this.dirs.add(path.slice(0, path.lastIndexOf("/"))); }
	async exists(path: string) { return this.store.has(path) || this.dirs.has(path); }
	async mkdir(path: string) { this.dirs.add(path); }
	async list(path: string) {
		const prefix = path.endsWith("/") ? path : path + "/";
		const folders: string[] = [];
		const files: string[] = [];
		for (const d of this.dirs) {
			if (d.startsWith(prefix) && d !== path) {
				const rest = d.slice(prefix.length);
				if (!rest.includes("/")) folders.push(d);
			}
		}
		for (const k of this.store.keys()) {
			if (k.startsWith(prefix)) {
				const rest = k.slice(prefix.length);
				if (!rest.includes("/")) files.push(k);
			}
		}
		return { folders, files };
	}
	async remove(path: string) { this.store.delete(path); }
	async rmdir(path: string) { this.dirs.delete(path); }
}

describe("chatStorage (sessions only)", () => {
	it("genId produces distinct ids", () => {
		expect(genId()).not.toBe(genId());
	});

	it("autoTitle truncates to 20 chars or falls back", () => {
		expect(autoTitle("很长的第一句提问内容超过二十个字符会被截断", 0)).toHaveLength(20);
		expect(autoTitle("", 2, "新会话")).toBe("新会话 3");
	});

	it("caps message history by keeping the tail", () => {
		const messages = Array.from({ length: 100 }, (_, i) => ({ role: "user" as const, content: "m" + i }));
		const capped = capMessages(messages);
		expect(capped.length).toBe(CHAT_HISTORY_LIMIT * 2);
		expect(capped[0]!.content).toBe("m" + (100 - CHAT_HISTORY_LIMIT * 2));
	});

	it("creates a session on first run when no directory exists", async () => {
		const a = new MemoryAdapter();
		const s = await createSession(a, "plugin");
		expect(s.id.length).toBeGreaterThan(0);
		expect((await loadMeta(a)).activeSessionId).toBe(s.id);
		expect(await loadSessions(a)).toHaveLength(1);
	});

	it("persists messages", async () => {
		const a = new MemoryAdapter();
		const s = await createSession(a, "plugin");
		s.messages.push({ role: "user", content: "hi" });
		await saveSession(a, s);
		const loaded = await loadSession(a, s.id);
		expect(loaded!.messages).toHaveLength(1);
		expect(loaded!.scope).toBe("plugin");
	});

	it("orders sessions per meta.order", async () => {
		const a = new MemoryAdapter();
		const first = await createSession(a, "plugin", "A");
		const second = await createSession(a, "plugin", "B");
		const list = await loadSessions(a);
		expect(list.map(s => s.name)).toEqual(["A", "B"]);
		await setActiveSession(a, first.id);
		expect((await loadMeta(a)).activeSessionId).toBe(first.id);
		void second;
	});

	it("renames sessions and updates scope", async () => {
		const a = new MemoryAdapter();
		const s = await createSession(a, "plugin");
		expect(await renameSession(a, s.id, "新名字")).toBe(true);
		expect(await setSessionScope(a, s.id, "vault")).toBe(true);
		const loaded = await loadSession(a, s.id);
		expect(loaded!.name).toBe("新名字");
		expect(loaded!.scope).toBe("vault");
	});

	it("deletes a session and falls back the active id", async () => {
		const a = new MemoryAdapter();
		const s1 = await createSession(a, "plugin");
		const s2 = await createSession(a, "plugin");
		await deleteSession(a, s2.id);
		expect(await loadSession(a, s2.id)).toBeNull();
		expect(await loadSessions(a)).toHaveLength(1);
		expect((await loadMeta(a)).activeSessionId).toBe(s1.id);
	});

	it("numbers the next session 新会话 1 again after all are deleted", async () => {
		const a = new MemoryAdapter();
		const s1 = await createSession(a, "plugin");
		expect(s1.name).toBe("新会话 1");
		const s2 = await createSession(a, "plugin");
		expect(s2.name).toBe("新会话 2");
		await deleteSession(a, s1.id);
		await deleteSession(a, s2.id);
		expect(await loadSessions(a)).toHaveLength(0);
		const fresh = await createSession(a, "plugin");
		expect(fresh.name).toBe("新会话 1");
	});
});