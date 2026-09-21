import type { FmValue } from "../types";
import { SYSTEM_TAGS } from "../constants";

/** YAML block scalar header, e.g. `|`, `>-`, `|2`. */
const BLOCK_SCALAR_RE = /^[|>][-+]?\d*$/;
/** Frontmatter keys that must be coerced to numbers when they look numeric. */
const NUMERIC_KEYS = new Set([
	"interval",
	"correctCount",
	"wrongCount",
	"easeFactor",
	"repetitions",
	"lapses",
]);
/** Characters that force an inline list item to be quoted. */
const LIST_SPECIAL_RE = /[,[\]{}:#&*!|>'"%@`\n\r\t]/;
/** UTF-8 BOM；解析/改写时先跳过，但输出时原样保留。 */
const BOM = "\uFEFF";

/** Returns 1 when the content starts with a BOM, otherwise 0. */
function bomOffset(content: string): number {
	return content.charCodeAt(0) === 0xfeff ? 1 : 0;
}

/**
 * Locates the closing `---` of a frontmatter block (line-anchored, not a naive `indexOf`).
 *
 * 匹配串把前面的换行一并吃进去，这样 `end` 指向换行起点：
 * CRLF 文件里如果只匹配 `\n---`，那个 `\r` 会残留在 fmText 末尾、导致重建时混入裸 `\n`。
 *
 * @param from 起始偏移（用于跳过 BOM），返回的索引是相对整个 content 的绝对位置。
 */
function findFrontmatterEnd(content: string, from = 0): { end: number; bodyStart: number } | null {
	if (!content.startsWith("---", from)) return null;
	const rest = content.slice(from + 3);
	const m = /(?:\r?\n)---[ \t]*(?:\r?\n|$)/.exec(rest);
	if (!m) return null;
	return { end: from + 3 + m.index, bodyStart: from + 3 + m.index + m[0].length };
}

/** Removes surrounding quotes (single or double) and unescapes the inner value. */
function unescapeQuoted(s: string): string {
	if (s.length < 2) return s;
	const first = s[0]!;
	const last = s[s.length - 1]!;
	if (first !== last || (first !== '"' && first !== "'")) return s;
	const inner = s.slice(1, -1);
	if (first === "'") return inner.replace(/''/g, "'");
	return inner.replace(/\\(["\\ntr])/g, (_full, c: string) =>
		c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c,
	);
}

/** Splits an inline YAML list body on commas, ignoring commas inside quotes. */
function splitInlineList(inner: string): string[] {
	const out: string[] = [];
	let buf = "";
	let quote = "";
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i]!;
		if (quote) {
			if (ch === "\\" && quote === '"' && i + 1 < inner.length) {
				buf += ch + inner[i + 1]!;
				i++;
				continue;
			}
			if (ch === quote) quote = "";
			buf += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			buf += ch;
			continue;
		}
		if (ch === ",") {
			out.push(buf);
			buf = "";
			continue;
		}
		buf += ch;
	}
	if (buf.length > 0) out.push(buf);
	return out.map(s => unescapeQuoted(s.trim())).filter(s => s.length > 0);
}

/** Parses a single (non-empty, non-list, non-block) scalar value. */
function parseScalar(key: string, raw: string): FmValue {
	if (raw === "true") return true;
	if (raw === "false") return false;
	const val = unescapeQuoted(raw);
	if (NUMERIC_KEYS.has(key) && val.trim() !== "") {
		const num = Number(val);
		if (isFinite(num)) return num;
	}
	return val;
}

/** Quotes a string only when YAML would otherwise misinterpret it. */
function quoteScalar(s: string): string {
	const needsQuotes =
		s === "" ||
		LIST_SPECIAL_RE.test(s) ||
		/^\s|\s$/.test(s) ||
		/^[-?]/.test(s) ||
		/^(true|false|null|~)$/i.test(s);
	if (!needsQuotes) return s;
	return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** Serializes a value into one or more frontmatter lines (no trailing newline). */
function serializeEntry(key: string, value: FmValue, nl: string): string[] {
	if (Array.isArray(value)) {
		const items = value.map(v => {
			const s = String(v);
			return LIST_SPECIAL_RE.test(s) || /^\s|\s$/.test(s) ? quoteScalar(s) : s;
		});
		return [`${key}: [${items.join(", ")}]`];
	}
	if (typeof value === "boolean" || typeof value === "number") {
		return [`${key}: ${String(value)}`];
	}
	const s = String(value);
	if (s.includes("\n") || s.includes("\r")) {
		const body = s.replace(/\r\n?/g, "\n").split("\n").map(l => "  " + l);
		return [`${key}: |`, ...body];
	}
	// Scalars stay quoted for backward compatibility with existing vaults.
	return [`${key}: "${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`];
}

export function parseFM(content: string): { meta: Record<string, FmValue>; body: string } {
	const off = bomOffset(content);
	const loc = findFrontmatterEnd(content, off);
	if (!loc) return { meta: {}, body: content };
	const yaml = content.slice(off + 3, loc.end);
	const body = content.slice(loc.bodyStart).trim();
	const meta: Record<string, FmValue> = {};
	const lines = yaml.split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		// Only column-0 lines can open a key; indented lines belong to the previous value.
		if (/^\s/.test(line)) continue;
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		if (!key) continue;
		const val = line.slice(idx + 1).trim();

		// Inline list: `tags: [a, b]`
		if (val.startsWith("[") && val.endsWith("]")) {
			meta[key] = splitInlineList(val.slice(1, -1));
			continue;
		}

		// Block scalar: `note: |` followed by indented lines.
		if (BLOCK_SCALAR_RE.test(val)) {
			const collected: string[] = [];
			let j = i + 1;
			for (; j < lines.length; j++) {
				const next = lines[j]!;
				if (/^\s+\S/.test(next) || next.trim() === "") {
					collected.push(next.replace(/^\s{1,2}/, ""));
					continue;
				}
				break;
			}
			while (collected.length > 0 && collected[collected.length - 1]!.trim() === "") collected.pop();
			meta[key] = val.startsWith(">") ? collected.join(" ").trim() : collected.join("\n");
			i = j - 1;
			continue;
		}

		// Block list: `tags:` followed by `  - item` lines.
		if (val === "") {
			const list: string[] = [];
			let j = i + 1;
			for (; j < lines.length; j++) {
				const m = /^\s+-\s*(.*)$/.exec(lines[j]!);
				if (!m) break;
				const item = unescapeQuoted(m[1]!.trim());
				if (item) list.push(item);
			}
			if (list.length > 0) {
				meta[key] = list;
				i = j - 1;
			} else {
				meta[key] = "";
			}
			continue;
		}

		meta[key] = parseScalar(key, val);
	}
	return { meta, body };
}

export function buildFM(data: Record<string, FmValue>): string {
	let y = "---\n";
	for (const [k, v] of Object.entries(data)) {
		for (const line of serializeEntry(k, v, "\n")) y += line + "\n";
	}
	return y + "---\n\n";
}

/**
 * Rewrites only the listed keys inside an existing frontmatter block, leaving every other
 * line (block scalars, nested maps, comments, custom keys) byte-for-byte intact.
 *
 * This replaces the lossy `buildFM(parseFM(content).meta)` round-trip, which silently
 * dropped any YAML shape the parser did not understand.
 */
export function patchFrontmatter(content: string, updates: Record<string, FmValue>): string {
	const keys = Object.keys(updates);
	if (keys.length === 0) return content;
	const off = bomOffset(content);
	const bom = off ? BOM : "";
	const nl = content.includes("\r\n") ? "\r\n" : "\n";
	const loc = findFrontmatterEnd(content, off);

	// No frontmatter yet -> prepend a fresh block.
	if (!loc) {
		const lines: string[] = [];
		for (const k of keys) lines.push(...serializeEntry(k, updates[k]!, nl));
		return bom + ["---", ...lines, "---", ""].join(nl) + nl + content.slice(off);
	}

	const fmText = content.slice(off + 3, loc.end);
	const rest = content.slice(loc.end);
	const lines = fmText.split(/\r?\n/);
	// 跳过 `---` 之后紧跟的空行：它们没有语义，留着会让每次调用都多插一行（非幂等）。
	while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
	const out: string[] = [];
	const done = new Set<string>();

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const m = /^([^\s:#][^:]*):/.exec(line);
		if (!m) {
			out.push(line);
			continue;
		}
		const key = m[1]!.trim();
		if (!(key in updates)) {
			out.push(line);
			continue;
		}
		// 同一个 key 重复出现属于非法 YAML：只保留第一处，其余丢弃，避免写出两个相同的键。
		if (done.has(key)) continue;
		const valPart = line.slice(line.indexOf(":") + 1).trim();
		// Consume the value's own continuation lines (block scalar body / block list items).
		let j = i;
		if (valPart === "" || BLOCK_SCALAR_RE.test(valPart)) {
			while (j + 1 < lines.length) {
				const next = lines[j + 1]!;
				if (/^\s+\S/.test(next) || next.trim() === "") {
					j++;
					continue;
				}
				break;
			}
		}
		out.push(...serializeEntry(key, updates[key]!, nl));
		done.add(key);
		i = j;
	}

	for (const k of keys) {
		if (!done.has(k)) out.push(...serializeEntry(k, updates[k]!, nl));
	}

	return bom + "---" + out.map(l => nl + l).join("") + rest;
}

export function knowledgeTags(tags: string[]): string[] {
	return tags.filter(t => !SYSTEM_TAGS.includes(t));
}

export function buildKnowledgeLinks(tags: string[]): string {
	const kp = knowledgeTags(tags);
	if (kp.length === 0) return "";
	return "\n\n**知识点：** " + kp.map(t => "[[" + t + "]]").join(" ") + "\n";
}
