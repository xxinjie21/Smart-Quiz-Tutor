import type { ChatSearchScope } from "../types";

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

/** 按总预算拼接全部引用文本，超出部分按引用顺序截断（纯函数）。 */
export function buildReferenceBlock(refs: ReferenceBlockItem[], budget: number): string {
	if (refs.length === 0) return "";
	let used = 0;
	const parts: string[] = [];
	for (const ref of refs) {
		const header = `【${ref.name}${ref.isSelection ? "（选中片段）" : ""}】\n`;
		const remaining = budget - used - header.length;
		if (remaining <= 0) break;
		const body = ref.text.slice(0, remaining);
		parts.push(header + body);
		used += header.length + body.length;
	}
	if (parts.length === 0) return "";
	return "【引用文件】\n" + parts.join("\n\n") + "\n\n回答请优先依据以上引用文件的内容与思想。\n\n";
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
