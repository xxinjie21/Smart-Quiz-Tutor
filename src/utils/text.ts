export function safeName(name: string): string {
	return name
		// Windows 不允许的字符 + 控制字符（\x00-\x1f 必须剥离，否则写入磁盘会失败）
		// eslint-disable-next-line no-control-regex -- 这里就是要有意匹配控制字符
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
		.replace(/\.md$/, "")
		// Windows 不允许文件名以点或空格结尾，也不允许以空格开头
		.replace(/[. ]+$/, "")
		.replace(/^[ ]+/, "");
}

export function cleanSourceText(text: string): string {
	let clean = text;
	clean = clean.replace(/```[\s\S]*?```/g, "[代码块已省略]");
	clean = clean.replace(/`[^`\n]+`/g, "");
	clean = clean.replace(/%%[\s\S]*?%%/g, "");
	clean = clean.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
	clean = clean.replace(/\[\[([^\]]+)\]\]/g, "$1");
	clean = clean.replace(/!\[\[([^\]]+)\]\]/g, "");
	clean = clean.replace(/!\[([^\]]*)\]\([^)]+\)/g, "");
	clean = clean.replace(/^#{1,6}\s+/gm, "");
	clean = clean.replace(/\*\*([^*]+)\*\*/g, "$1");
	clean = clean.replace(/\*([^*]+)\*/g, "$1");
	clean = clean.replace(/~~([^~]+)~~/g, "$1");
	clean = clean.replace(/^[-*+]\s+/gm, "");
	clean = clean.replace(/^\d+\.\s+/gm, "");
	clean = clean.replace(/^>\s*/gm, "");
	clean = clean.replace(/---+/gm, "");
	clean = clean.replace(/\|[^|\n]+\|/g, "");
	clean = clean.replace(/\n{3,}/g, "\n\n");
	return clean.trim();
}

export function estimateTokens(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.codePointAt(i)!;
		if (code > 0xFFFF) i++;
		count += (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) || (code >= 0x20000 && code <= 0x2A6DF) ? 1.5 : 1;
	}
	return Math.ceil(count);
}

/** 答案/解析行的标签（兼容加粗写法与英文标签）。 */
const ANSWER_LABEL_RE = /^(?:\*\*)?(答案[汇总：:]|解析[：:]|Answer[：:]|Explanation[：:])/i;
/** 题型标题行：只认 1–3 级标题（`####` 是答案内分组标题，不在此列）。 */
const SECTION_HEADING_RE = /^#{1,3}\s+\S/;
/** 题号行：兼容 `1.`、`**1.**` 两种写法。 */
const QUESTION_NUM_RE = /^(?:\*\*)?(\d+)(?:\*\*)?[.、）)]/;

/**
 * 生成「无答案版」：去掉答案与解析，保留题干和选项。
 *
 * 注意：题号行必须同时兼容加粗形式 `**1.**` —— 提示词要求 AI 输出加粗题号，
 * 若只认裸题号，`skip` 一旦置位就无法被下一题复位，会导致该题型下后续题目整段丢失。
 */
export function stripAnswersForExport(text: string): string {
	const lines = text.split("\n");
	const result: string[] = [];
	let skip = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (SECTION_HEADING_RE.test(trimmed)) {
			skip = false;
			result.push(line);
			continue;
		}
		if (ANSWER_LABEL_RE.test(trimmed)) {
			skip = true;
			continue;
		}
		if (QUESTION_NUM_RE.test(trimmed) && skip) {
			skip = false;
		}
		if (!skip) result.push(line);
	}
	return result.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 仅保留答案/解析，按题号汇总，用于「仅答案版」导出。 */
export function extractAnswersForExport(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let currentNum = "";
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		const qm = line.replace(/^#{1,6}\s*/, "").match(QUESTION_NUM_RE);
		if (qm) { currentNum = qm[1]!; continue; }
		if (ANSWER_LABEL_RE.test(line)) {
			out.push((currentNum ? currentNum + ". " : "") + line);
		}
	}
	return out.join("\n").trim();
}

export function htmlEscape(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
