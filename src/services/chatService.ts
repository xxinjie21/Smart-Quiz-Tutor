import type { ChatSearchScope } from "../types";
import { REF_HEAD_CHARS, REF_SNIPPET_CHARS, REF_SNIPPET_MAX } from "../constants";

export interface ScopeFile {
	path: string;
	basename: string;
}

export interface RetrievedChunk {
	path: string;
	basename: string;
	score: number;
	snippet: string;
}

export interface ReferenceBlockItem {
	name: string;
	text: string;
	isSelection: boolean;
}

/** CJK（含假名）字符检测，用于中文无空格分词。 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const WORD_RE = /[a-z0-9]/;
const MAX_TERMS = 60;

/** 寒暄/闲聊式开头，命中则不做笔记检索。 */
const CASUAL_RE = /^(你好|您好|嗨|哈喽|hi+|hello|hey|thanks|thank you|在吗|你是谁|你能做什么|你能干嘛|help)/i;

/** 纯粹的应答/寒暄短词，不含任何检索意图。 */
const CASUAL_SHORT_RE = /^(ok|okay|嗯+|哦+|好+|好的|是的|对|对的|行|谢谢|多谢|感谢|thanks|thx|thks|yes|no|y|n|早|早安|晚安|再见|拜拜|哈哈+|呵呵+)$/i;

/**
 * 判定是否为无需检索的寒暄/短句。
 *
 * 只按“明确的寒暄模式”判断，不再用长度一刀切：旧实现把 `length <= 4` 直接当闲聊，
 * 导致「什么是熵」「为什么」这类 3~4 字的真实提问被跳过检索。
 */
export function isCasualQuery(text: string): boolean {
	const t = (text || "").trim();
	if (!t) return false;
	if (CASUAL_RE.test(t)) return true;
	return CASUAL_SHORT_RE.test(t);
}

/** 绝对路径检测（与 fs-utils.isAbs 保持一致；此处内联以免给纯函数引入 electron 依赖）。 */
const ABS_PATH_RE = /^[A-Za-z]:[/\\]|^\//;

/** 相对路径中是否含 `..` 段（会逃出 vault 根）。 */
function hasPathEscape(rel: string): boolean {
	return rel.split("/").some(seg => seg === "..");
}

/**
 * 把插件的目录配置规范化为 **vault 相对路径**，供 `getScopeFiles` 与 `vault.getMarkdownFiles()`
 * 的 `f.path` 比较使用。
 *
 * `plugin.rootPath()` 在配置了绝对 `rootFolder` 时返回绝对路径，直接拿去和 vault 相对路径做
 * `startsWith` 永远为假——这正是「仅插件知识库」检索始终为空的原因。
 * 位于 vault 之外的目录无法通过 vault API 读取，直接丢弃。
 */
export function normalizePluginDirs(dirs: string[], vaultBasePath: string): string[] {
	// 统一分隔符并折叠重复斜杠：`D://Vault//题目` 若只做 replace 会算出 `/题目` 这种永远不匹配的前缀。
	const base = (vaultBasePath || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
	const out: string[] = [];
	for (const d of dirs) {
		const raw = (d || "").trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
		if (!raw) continue;
		if (!ABS_PATH_RE.test(raw)) {
			const rel = raw.replace(/^\/+/, "").replace(/\/+$/, "");
			// 含 `..` 的相对路径会逃出 vault，且永远不可能匹配任何 f.path —— 丢弃。
			if (rel && !hasPathEscape(rel)) out.push(rel);
			continue;
		}
		if (!base) continue;
		const lower = raw.replace(/\/+$/, "").toLowerCase();
		const baseLower = base.toLowerCase();
		// 目录就是 vault 根：等价于不限制，交给调用方按“全部”处理
		if (lower === baseLower) continue;
		if (!lower.startsWith(baseLower + "/")) continue;
		const rel = raw.slice(base.length + 1).replace(/\/+$/, "");
		if (rel && !hasPathEscape(rel)) out.push(rel);
	}
	return out;
}

/** 按范围过滤出候选 markdown 文件（纯函数，便于测试）。 */
export function getScopeFiles(
	allFiles: ScopeFile[],
	scope: ChatSearchScope,
	pluginDirs: string[],
): ScopeFile[] {
	if (scope === "vault") return allFiles;
	const prefixes = pluginDirs.map(d => (d.endsWith("/") ? d : d + "/"));
	return allFiles.filter(f => prefixes.some(p => f.path.startsWith(p)));
}

/**
 * 查询分词：CJK 连续串生成 2-gram 与 3-gram（长度 1 时保留单字），
 * 拉丁/数字按词切分（长度 ≥2）。去重并限量。
 */
export function tokenize(query: string): string[] {
	const q = (query || "").toLowerCase();
	const terms: string[] = [];
	let i = 0;
	while (i < q.length) {
		const ch = q[i]!;
		if (CJK_RE.test(ch)) {
			let j = i;
			while (j < q.length && CJK_RE.test(q[j]!)) j++;
			const run = q.slice(i, j);
			const L = run.length;
			if (L === 1) {
				terms.push(run);
			} else {
				for (let k = 0; k + 2 <= L; k++) terms.push(run.slice(k, k + 2));
				if (L >= 3) for (let k = 0; k + 3 <= L; k++) terms.push(run.slice(k, k + 3));
			}
			i = j;
		} else if (WORD_RE.test(ch)) {
			let j = i;
			while (j < q.length && WORD_RE.test(q[j]!)) j++;
			const word = q.slice(i, j);
			if (word.length >= 2) terms.push(word);
			i = j;
		} else {
			i++;
		}
	}
	const seen = new Set<string>();
	const out: string[] = [];
	for (const term of terms) {
		if (!seen.has(term)) {
			seen.add(term);
			out.push(term);
			if (out.length >= MAX_TERMS) break;
		}
	}
	return out;
}

/** 文件名/路径命中打分（标题权重最高）。 */
export function scoreByMeta(terms: string[], basename: string, path: string): number {
	const name = basename.toLowerCase();
	const p = path.toLowerCase();
	let score = 0;
	for (const term of terms) {
		if (name.includes(term)) score += 6;
		if (p.includes(term)) score += 2;
	}
	return score;
}

/** 正文命中打分：每个词最多计 3 次出现，避免长文刷分。 */
export function scoreByContent(terms: string[], content: string): number {
	if (!content) return 0;
	const c = content.toLowerCase();
	let score = 0;
	for (const term of terms) {
		let occ = 0;
		let idx = c.indexOf(term);
		while (idx >= 0 && occ < 3) { occ++; idx = c.indexOf(term, idx + term.length); }
		score += occ;
	}
	return score;
}

/** 取内容中首个命中词附近的片段。 */
function makeSnippet(content: string, terms: string[], maxLen = 220): string {
	let start = 0;
	for (const term of terms) {
		const idx = content.toLowerCase().indexOf(term);
		if (idx >= 0) { start = idx; break; }
	}
	const from = Math.max(0, start - 40);
	return content.slice(from, from + maxLen).replace(/\s+/g, " ").trim();
}

/**
 * 两段式检索第一步：仅按文件名/路径粗排候选，返回前 max 个（命中优先，未命中保持原顺序）。
 * 让调用方只读取这些文件，避免全量读盘。
 */
export function rankCandidates(query: string, files: ScopeFile[], max: number): ScopeFile[] {
	const terms = tokenize(query);
	if (terms.length === 0) return files.slice(0, max);
	const scored = files.map(f => ({ f, s: scoreByMeta(terms, f.basename, f.path) }));
	scored.sort((a, b) => b.s - a.s);
	return scored.slice(0, max).map(x => x.f);
}

/** 两段式检索第二步：对已读取内容的文件精排，返回 Top-K 片段。 */
export function retrieveContext(
	query: string,
	files: ScopeFile[],
	contents: Record<string, string>,
	limit = 5,
): RetrievedChunk[] {
	const terms = tokenize(query);
	if (terms.length === 0) return [];
	const ranked: RetrievedChunk[] = [];
	for (const f of files) {
		const content = contents[f.path] || "";
		const sc = scoreByContent(terms, content) + scoreByMeta(terms, f.basename, f.path);
		if (sc <= 0) continue;
		ranked.push({
			path: f.path,
			basename: f.basename,
			score: sc,
			snippet: makeSnippet(content, terms),
		});
	}
	ranked.sort((a, b) => b.score - a.score);
	return ranked.slice(0, limit);
}

/** 在自然边界处截断，尽量不切断句子/代码。 */
export function cutAtBoundary(text: string, max: number): string {
	if (text.length <= max) return text;
	const slice = text.slice(0, max);
	const seps = ["\n\n", "\n", "。", "！", "？", "；", ". ", "! ", "? ", "; "];
	for (const sep of seps) {
		const idx = slice.lastIndexOf(sep);
		if (idx >= Math.floor(max * 0.6)) return slice.slice(0, idx + sep.length);
	}
	return slice;
}

/** 在长文中选取与查询相关的若干片段（词法匹配、确定性）。 */
export function selectRelevantSnippets(text: string, terms: string[], snippetChars: number, maxCount: number): string[] {
	if (terms.length === 0 || !text) return [];
	const lower = text.toLowerCase();
	const spans: { start: number; end: number }[] = [];
	for (const term of terms) {
		if (!term) continue;
		let idx = lower.indexOf(term);
		let hits = 0;
		while (idx >= 0 && hits < 3) {
			const start = Math.max(0, idx - Math.floor(snippetChars / 3));
			spans.push({ start, end: Math.min(text.length, start + snippetChars) });
			hits++;
			idx = lower.indexOf(term, idx + term.length);
		}
	}
	if (spans.length === 0) return [];
	spans.sort((a, b) => a.start - b.start);
	const merged: { start: number; end: number }[] = [];
	for (const s of spans) {
		const last = merged[merged.length - 1];
		if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
		else merged.push({ ...s });
	}
	return merged.slice(0, maxCount).map(s => text.slice(s.start, s.end).replace(/\s+/g, " ").trim());
}

/** 注水法：按引用长度公平分配预算，短引用的余额回收给长引用（确定性）。 */
export function distributeBudget(lens: number[], total: number): number[] {
	const alloc = lens.map(() => 0);
	const pending = new Set(lens.map((_, i) => i));
	let remaining = Math.max(0, total);
	while (pending.size > 0 && remaining > 0) {
		const share = Math.floor(remaining / pending.size);
		if (share <= 0) break;
		let removed = false;
		for (const i of [...pending]) {
			if (lens[i]! <= share) { alloc[i] = lens[i]!; remaining -= lens[i]!; pending.delete(i); removed = true; }
		}
		if (!removed) {
			for (const i of pending) alloc[i] = share;
			break;
		}
	}
	return alloc;
}

export interface ReferenceBuildOptions { query?: string; }

/**
 * 按总预算公平拼接全部引用：预算按引用长度注水分配（短引用整篇、长引用取份额），
 * 长引用保留开头并在有关键词命中时补相关片段，保持单次请求、确定性、无 IO。
 */
export function buildReferenceBlock(refs: ReferenceBlockItem[], budget: number, opts: ReferenceBuildOptions = {}): string {
	if (refs.length === 0) return "";
	const blockHeader = "【引用文件】\n";
	const blockFooter = "\n\n回答请优先依据以上引用文件的内容与思想。\n\n";
	const headers = refs.map(r => `【${r.name}${r.isSelection ? "（选中片段）" : ""}】\n`);
	const overhead = blockHeader.length + blockFooter.length + headers.reduce((a, h) => a + h.length, 0);
	const usable = Math.max(0, budget - overhead);
	const shares = distributeBudget(refs.map(r => r.text.length), usable);
	const terms = opts.query ? tokenize(opts.query) : [];
	let truncated = false;
	const parts: string[] = [];
	refs.forEach((ref, i) => {
		const share = shares[i] ?? 0;
		const text = ref.text;
		let body: string;
		if (share <= 0) { body = ""; truncated = true; }
		else if (text.length <= share) { body = text; }
		else {
			truncated = true;
			const head = cutAtBoundary(text, Math.min(REF_HEAD_CHARS, share));
			const snippets = terms.length > 0
				? selectRelevantSnippets(text.slice(head.length), terms, REF_SNIPPET_CHARS, REF_SNIPPET_MAX)
				: [];
			const mid = snippets.length > 0 ? "\n……（以下为相关片段）……\n" + snippets.join("\n……\n") : "……";
			body = (head + mid).slice(0, share);
		}
		parts.push(headers[i]! + body);
	});
	if (parts.length === 0) return "";
	const note = truncated ? "\n\n（注：部分引用因长度受限仅保留开头/相关片段。）" : "";
	return blockHeader + parts.join("\n\n") + note + blockFooter;
}

/** 组装聊天 prompt：要求基于上下文回答并注明来源。 */
export function buildChatPrompt(query: string, chunks: RetrievedChunk[], scope: ChatSearchScope): string {
	if (chunks.length === 0) {
		return `请回答以下问题：\n${query}`;
	}
	const lines = chunks.map(c => `【来源：[[${c.basename}]]】\n${c.snippet}`);
	const scopeNote = scope === "plugin" ? "插件知识库" : "当前 vault";
	return `请基于以下来自${scopeNote}的资料回答问题。回答要准确、简洁，并在每条关键信息后标注来源 [[文件名]]。如果资料不足以回答，请说明。
如果资料与问题无关，请基于你的知识回答并明确说明这不是来自笔记资料。

--- 参考资料 ---
${lines.join("\n\n")}

--- 问题 ---
${query}`;
}
