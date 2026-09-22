import type { ChatMessage, ChatSearchScope, ChatSession } from "../types";
import { CHAT_HISTORY_LIMIT, CHAT_TITLE_MAX, CHAT_REQUEST_MESSAGES, CHAT_COMPRESS_KEEP_RECENT } from "../constants";

/** 文件系统能力的最小接口，便于单测注入内存 mock。 */
export interface ChatAdapter {
	read(path: string): Promise<string | null>;
	write(path: string, data: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	list(path: string): Promise<{ folders: string[]; files: string[] }>;
	remove(path: string): Promise<void>;
	rmdir(path: string): Promise<void>;
}

/** chat-data 目录布局（相对插件目录，由 plugin.chatAdapter 统一加前缀）。 */
export const CHAT_DIR = "chat-data";
export const SESSIONS_DIR = CHAT_DIR + "/sessions";
export const META_FILE = CHAT_DIR + "/meta.json";

export interface ChatMeta {
	activeSessionId: string;
	order: string[];
}

export function genId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 会话自动标题：取首条提问前 N 字；无文字时用「新会话 N」。 */
export function autoTitle(text: string, index: number, fallbackLabel = "新会话"): string {
	const t = (text || "").replace(/\n+/g, " ").trim();
	if (!t) return fallbackLabel + " " + (index + 1);
	return t.slice(0, CHAT_TITLE_MAX);
}

export function sessionFile(sid: string): string {
	return SESSIONS_DIR + "/" + sid + ".session.json";
}

/**
 * 会话消息上限（对半，保留成对历史）。
 *
 * **摘要消息不参与淘汰**：它承载的是被它替换掉的那一整批消息，一旦被当成普通消息切掉，
 * 压缩的成果就白费了。
 */
export function capMessages(messages: ChatMessage[]): ChatMessage[] {
	const max = CHAT_HISTORY_LIMIT * 2;
	if (messages.length <= max) return messages;
	const summaries = messages.filter(m => m.summary).slice(-max);
	const rest = messages.filter(m => !m.summary);
	const keep = Math.max(0, max - summaries.length);
	return [...summaries, ...rest.slice(Math.max(0, rest.length - keep))];
}

/** 一次上下文压缩的规划结果。 */
export interface CompressionPlan {
	/** 将被摘要替换掉的消息。 */
	older: ChatMessage[];
	/** 原样保留在末尾的消息。 */
	kept: ChatMessage[];
}

/**
 * 规划一次上下文压缩：末尾保留 `keepRecent` 条，其余交给 AI 摘要。
 *
 * 返回 `null` 表示「没什么可压的」（可压缩部分不足 2 条），调用方应直接提示用户而不是发请求。
 */
export function planCompression(messages: ChatMessage[], keepRecent = CHAT_COMPRESS_KEEP_RECENT): CompressionPlan | null {
	const keep = Math.max(0, keepRecent);
	const cut = Math.max(0, messages.length - keep);
	const older = messages.slice(0, cut);
	if (older.length < 2) return null;
	return { older, kept: messages.slice(cut) };
}

/** 会话里所有历史摘要的正文（按时间顺序）。 */
export function collectSummaries(messages: ChatMessage[]): string[] {
	return messages.filter(m => m.summary && m.content.trim()).map(m => m.content.trim());
}

/**
 * 组装发给 AI 的普通消息：末尾 `limit` 条，**跳过摘要消息**。
 *
 * 摘要不是一轮真实对话，直接混进 `messages` 会让模型误以为那是自己说过的话；
 * 它由调用方并入 system 提示词（见 `collectSummaries`）。
 */
export function buildRequestMessages(messages: ChatMessage[], limit = CHAT_REQUEST_MESSAGES): ChatMessage[] {
	const rest = messages.filter(m => !m.summary);
	const start = Math.max(0, rest.length - Math.max(0, limit));
	return rest.slice(start).map(m => ({ role: m.role, content: m.content }));
}

async function ensureDir(adapter: ChatAdapter, dir: string): Promise<void> {
	try { await adapter.mkdir(dir); } catch { /* 已存在 */ }
}

export async function loadMeta(adapter: ChatAdapter): Promise<ChatMeta> {
	try {
		const raw = await adapter.read(META_FILE);
		if (!raw) return { activeSessionId: "", order: [] };
		const data = JSON.parse(raw) as Partial<ChatMeta>;
		return { activeSessionId: typeof data.activeSessionId === "string" ? data.activeSessionId : "", order: Array.isArray(data.order) ? data.order : [] };
	} catch { return { activeSessionId: "", order: [] }; }
}

export async function saveMeta(adapter: ChatAdapter, meta: ChatMeta): Promise<void> {
	await ensureDir(adapter, CHAT_DIR);
	await adapter.write(META_FILE, JSON.stringify(meta));
}

/** 列出所有会话 ID（从 sessions 目录读取文件名）。 */
export async function listSessionIds(adapter: ChatAdapter): Promise<string[]> {
	try {
		const list = await adapter.list(SESSIONS_DIR);
		return list.files
			.map(f => f.split("/").pop() || f)
			.filter(f => f.endsWith(".session.json"))
			.map(f => f.replace(/\.session\.json$/, ""));
	} catch { return []; }
}

export async function loadSession(adapter: ChatAdapter, sid: string): Promise<ChatSession | null> {
	try {
		const raw = await adapter.read(sessionFile(sid));
		if (!raw) return null;
		const data = JSON.parse(raw) as ChatSession;
		return { ...data, messages: capMessages(data.messages || []) };
	} catch { return null; }
}

/** 按 meta.order 排序加载全部会话（未知的追加在末尾）。 */
export async function loadSessions(adapter: ChatAdapter): Promise<ChatSession[]> {
	const ids = await listSessionIds(adapter);
	const meta = await loadMeta(adapter);
	const rank = new Map(meta.order.map((id, i) => [id, i]));
	const out: ChatSession[] = [];
	for (const id of ids) {
		const s = await loadSession(adapter, id);
		if (s) out.push(s);
	}
	out.sort((a, b) => {
		const ra = rank.has(a.id) ? rank.get(a.id)! : Number.MAX_SAFE_INTEGER;
		const rb = rank.has(b.id) ? rank.get(b.id)! : Number.MAX_SAFE_INTEGER;
		if (ra !== rb) return ra - rb;
		return a.createdAt - b.createdAt;
	});
	// 清理 meta.order 中已不存在的孤儿 id
	const ids2 = new Set(out.map(s => s.id));
	if (meta.order.some(id => !ids2.has(id)) || meta.order.length !== out.length) {
		meta.order = out.map(s => s.id);
		await saveMeta(adapter, meta);
	}
	return out;
}

export async function saveSession(adapter: ChatAdapter, session: ChatSession): Promise<void> {
	await ensureDir(adapter, CHAT_DIR);
	await ensureDir(adapter, SESSIONS_DIR);
	await adapter.write(sessionFile(session.id), JSON.stringify({ ...session, messages: capMessages(session.messages) }));
}

export async function createSession(adapter: ChatAdapter, scope: ChatSearchScope, name?: string): Promise<ChatSession> {
	const meta = await loadMeta(adapter);
	const existing = await listSessionIds(adapter);
	const now = Date.now();
	const session: ChatSession = { id: genId(), name: name || autoTitle("", existing.length), scope, createdAt: now, updatedAt: now, messages: [] };
	await saveSession(adapter, session);
	meta.order = meta.order.filter(id => existing.includes(id));
	meta.order.push(session.id);
	meta.activeSessionId = session.id;
	await saveMeta(adapter, meta);
	return session;
}

export async function deleteSession(adapter: ChatAdapter, sid: string): Promise<void> {
	try { await adapter.remove(sessionFile(sid)); } catch { /* ignore */ }
	const meta = await loadMeta(adapter);
	meta.order = meta.order.filter(id => id !== sid);
	if (meta.activeSessionId === sid) meta.activeSessionId = meta.order[0] || "";
	await saveMeta(adapter, meta);
}

export async function renameSession(adapter: ChatAdapter, sid: string, name: string): Promise<boolean> {
	const s = await loadSession(adapter, sid);
	if (!s) return false;
	s.name = name || s.name;
	s.updatedAt = Date.now();
	await saveSession(adapter, s);
	return true;
}

export async function setSessionScope(adapter: ChatAdapter, sid: string, scope: ChatSearchScope): Promise<boolean> {
	const s = await loadSession(adapter, sid);
	if (!s) return false;
	s.scope = scope;
	await saveSession(adapter, s);
	return true;
}

export async function setActiveSession(adapter: ChatAdapter, sid: string): Promise<void> {
	const meta = await loadMeta(adapter);
	meta.activeSessionId = sid;
	await saveMeta(adapter, meta);
}