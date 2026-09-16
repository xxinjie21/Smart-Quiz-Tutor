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

/** 简单打分：查询词在文件中的命中次数（文件名加权更高）。 */
function scoreFile(queryTerms: string[], name: string, content: string): number {
	let score = 0;
	for (const term of queryTerms) {
		if (name.toLowerCase().includes(term)) score += 4;
		const occ = content.split(term).length - 1;
		if (occ > 0) score += Math.min(3, occ);
	}
	return score;
}

/** 取内容中首个命中词附近的片段。 */
function makeSnippet(content: string, terms: string[], maxLen = 220): string {
	let start = 0;
	for (const term of terms) {
		const idx = content.indexOf(term);
		if (idx >= 0) { start = idx; break; }
	}
	const from = Math.max(0, start - 40);
	return content.slice(from, from + maxLen).replace(/\s+/g, " ").trim();
}

/** 检索：对候选文件打分，返回 Top-K 片段。contents 为 path -> 文本。 */
export function retrieveContext(
	query: string,
	files: ScopeFile[],
	contents: Record<string, string>,
	limit = 5,
): RetrievedChunk[] {
	const terms = query
		.split(/[\s，。！？、,.;:：]+/)
		.map(t => t.trim().toLowerCase())
		.filter(t => t.length >= 2 && t.length <= 24);
	if (terms.length === 0) return [];
	const ranked: RetrievedChunk[] = [];
	for (const f of files) {
		const content = contents[f.path] || "";
		const sc = scoreFile(terms, f.basename, content);
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