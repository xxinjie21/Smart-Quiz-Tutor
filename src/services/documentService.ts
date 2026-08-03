import * as fs from "fs";
import * as path from "path";

export async function convertDocumentToText(filePath: string): Promise<string> {
	const ext = path.extname(filePath).slice(1).toLowerCase();
	switch (ext) {
		case "txt":
			return fs.readFileSync(filePath, "utf-8");
		case "rtf": {
			const raw = fs.readFileSync(filePath, "utf-8");
			return stripRtf(raw);
		}
		case "docx": {
			const mammoth = await import("mammoth");
			try {
				const result = await mammoth.convertToHtml({ path: filePath });
				if (result.value) return htmlToMarkdown(result.value);
			} catch { /* 结构转换失败时退回纯文本提取 */ }
			const rawResult = await mammoth.extractRawText({ path: filePath });
			return rawResult.value || "";
		}
		case "pdf": {
			return withPdfEnvironment(async () => {
				const { PDFParse } = await import("pdf-parse");
				const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(filePath)) });
				try {
					const result = await parser.getText({ pageJoiner: "" });
					return result.text || "";
				} finally {
					await parser.destroy();
				}
			});
		}
		default:
			throw new Error("不支持的文件格式：" + (ext || "未知"));
	}
}

const RTF_SPECIAL_CHARS: Record<string, string> = {
	par: "\n", pard: "\n", line: "\n", page: "\n\n", sect: "\n\n",
	tab: "\t", emdash: "—", endash: "–", emspace: "\u2003", enspace: "\u2002",
	lquote: "‘", rquote: "’", ldblquote: "“", rdblquote: "”",
	bullet: "•", hellip: "…", nbspace: "\u00A0", thinspace: "\u2009",
};

const RTF_SKIP_DESTINATIONS = new Set([
	"fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "generator",
	"latentstyles", "rsidtbl", "listtable", "listoverridetable", "themedata",
	"colorschememapping", "xmattributeprop", "pgdsc", "xmlnstbl", "datafield",
	"header", "footer", "headerf", "headerl", "headerr", "footerf", "footerl", "footerr",
	"author", "title", "subject", "keywords", "company", "category", "comment", "operator",
	"ftncn", "ftnsep", "ftnsepc", "footref", "upr", "ud", "alt", "htmltag",
]);

export function stripRtf(raw: string): string {
	const out: string[] = [];
	let bytes: number[] = [];
	const n = raw.length;

	const flushBytes = () => {
		if (bytes.length === 0) return;
		const buf = Uint8Array.from(bytes);
		bytes = [];
		const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buf);
		out.push(utf8.includes("\uFFFD") ? new TextDecoder("latin1").decode(buf) : utf8);
	};

	const skipGroup = (from: number): number => {
		let depth = 1;
		for (let j = from; j < n; j++) {
			if (raw[j] === "{") depth++;
			else if (raw[j] === "}") { depth--; if (depth === 0) return j + 1; }
		}
		return n;
	};

	let i = 0;
	while (i < n) {
		const c = raw[i]!;
		if (c === "\\") {
			const nxt = raw[i + 1];
			if (nxt === undefined) { flushBytes(); out.push("\\"); i++; continue; }
			if (nxt === "\\" || nxt === "{" || nxt === "}") { flushBytes(); out.push(nxt); i += 2; continue; }
			if (nxt === "'") {
				const hex = raw.slice(i + 2, i + 4);
				if (/^[0-9a-fA-F]{2}$/.test(hex)) bytes.push(parseInt(hex, 16));
				i += 4;
				continue;
			}
			if (nxt === " ") { flushBytes(); out.push(" "); i += 2; continue; }
			if (nxt === "~") { flushBytes(); out.push("\u00A0"); i += 2; continue; }
			if (nxt === "-" || nxt === "_" || nxt === "|") { i += 2; continue; }
			if (nxt === "*") { i += 2; continue; }
			let j = i + 1;
			const wordStart = j;
			while (j < n && /[a-zA-Z]/.test(raw[j]!)) j++;
			const word = raw.slice(wordStart, j);
			let param = "";
			if (j < n && (raw[j] === "-" || /[0-9]/.test(raw[j]!))) {
				if (raw[j] === "-") { param = "-"; j++; }
				while (j < n && /[0-9]/.test(raw[j]!)) { param += raw[j]; j++; }
			}
			if (raw[j] === " ") j++;
			if (word === "u" && param) {
				flushBytes();
				let code = parseInt(param, 10);
				if (code < 0) code += 65536;
				if (code !== 0xFFFF && code !== 0xFEFF) {
					try { out.push(String.fromCodePoint(code)); } catch { /* 无效码点直接跳过 */ }
				}
				if (raw[j] === "?") j++;
				else if (raw[j] === "\\" && raw[j + 1] === "'") j += 4;
				i = j;
				continue;
			}
			if (word === "bin") {
				flushBytes();
				let k = i + 4;
				let num = "";
				while (k < n && /[0-9]/.test(raw[k]!)) { num += raw[k]; k++; }
				if (raw[k] === " ") k++;
				i = Math.min(n, k + (parseInt(num || "0", 10) || 0));
				continue;
			}
			if (RTF_SPECIAL_CHARS[word]) {
				flushBytes();
				out.push(RTF_SPECIAL_CHARS[word]);
			}
			i = j;
			continue;
		}
		if (c === "{") {
			flushBytes();
			let k = i + 1;
			while (k < n && raw[k] === " ") k++;
			if (raw[k] === "\\" && raw[k + 1] === "*") { i = skipGroup(i + 1); continue; }
			if (raw[k] === "\\") {
				let m = k + 1;
				const ws = m;
				while (m < n && /[a-zA-Z]/.test(raw[m]!)) m++;
				if (RTF_SKIP_DESTINATIONS.has(raw.slice(ws, m))) { i = skipGroup(i + 1); continue; }
			}
			i++;
			continue;
		}
		if (c === "}") { flushBytes(); i++; continue; }
		flushBytes();
		out.push(c);
		i++;
	}
	flushBytes();

	return out.join("")
		.replace(/\u2028|\u2029/g, "\n")
		.replace(/\r/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/ {2,}/g, " ")
		.replace(/[ \t]+$/gm, "")
		.trim();
}

export function htmlToMarkdown(html: string): string {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const out: string[] = [];

	const esc = (s: string): string => s.replace(/([\\*_`[\]])/g, "\\$1");

	const inline = (el: Element): string => {
		let s = "";
		for (const child of Array.from(el.childNodes)) {
			if (child.nodeType === 3) { s += esc(child.textContent || ""); continue; }
			if (child.nodeType !== 1) continue;
			const e = child as HTMLElement;
			const t = e.tagName.toLowerCase();
			if (t === "br") { s += "\n"; continue; }
			const inner = inline(e);
			if (t === "strong" || t === "b") s += "**" + inner + "**";
			else if (t === "em" || t === "i") s += "*" + inner + "*";
			else if (t === "code") s += "`" + inner + "`";
			else if (t === "a") {
				const href = e.getAttribute("href") || "";
				if (inner.trim() === "") { /* 书签锚点（如 <a id="_Toc..."></a>），跳过 */ }
				else if (href.startsWith("#_Toc") || href.startsWith("#heading_")) s += inner.replace(/\t+\d+\s*$/, "");
				else s += "[" + inner + "](" + href + ")";
			}
			else if (t === "img") s += "![" + (e.getAttribute("alt") || "") + "](" + (e.getAttribute("src") || "") + ")";
			else s += inner;
		}
		return s;
	};

	const walkList = (list: HTMLElement, indent: string, start: number): number => {
		let idx = start;
		for (const li of Array.from(list.children)) {
			if (li.tagName.toLowerCase() !== "li") { idx = walkList(li as HTMLElement, indent, idx); continue; }
			const marker = list.tagName.toLowerCase() === "ul" ? "- " : idx + ". ";
			const lines = inline(li).trim().split("\n");
			if (lines[0]) out.push(indent + marker + lines[0]);
			for (let k = 1; k < lines.length; k++) {
				if (lines[k]!.trim()) out.push(indent + " ".repeat(marker.length) + lines[k]!.trim());
			}
			for (const inner of Array.from(li.children)) {
				const it = inner.tagName.toLowerCase();
				if (it === "ul" || it === "ol") walkList(inner as HTMLElement, indent + "    ", it === "ol" ? 1 : 0);
			}
			idx++;
		}
		return idx;
	};

	const walkTable = (table: HTMLElement): void => {
		const rows: string[][] = [];
		for (const tr of Array.from(table.querySelectorAll("tr"))) {
			const cells: string[] = [];
			for (const cell of Array.from(tr.children)) {
				const ct = cell.tagName.toLowerCase();
				if (ct === "td" || ct === "th") cells.push(inline(cell).replace(/\|/g, "\\|").trim().replace(/\s+/g, " "));
			}
			if (cells.length > 0) rows.push(cells);
		}
		if (rows.length === 0) return;
		const cols = Math.max(...rows.map(r => r.length));
		const norm = rows.map(r => {
			const c = r.slice(0, cols);
			while (c.length < cols) c.push("");
			return c;
		});
		out.push("| " + norm[0]!.join(" | ") + " |");
		out.push("|" + norm[0]!.map(() => "---").join("|") + "|");
		for (let r = 1; r < norm.length; r++) out.push("| " + norm[r]!.join(" | ") + " |");
	};

const gap = () => { if (out.length > 0 && out[out.length - 1] !== "") out.push(""); };

	const walk = (el: Element): void => {
		let contOlNext = 1;
		for (const child of Array.from(el.childNodes)) {
			if (child.nodeType === 3) {
				const t = (child.textContent || "").replace(/\s+/g, " ").trim();
				if (t) { gap(); out.push(t); }
				continue;
			}
			if (child.nodeType !== 1) continue;
			const e = child as HTMLElement;
			const t = e.tagName.toLowerCase();
			if (t === "h1" || t === "h2" || t === "h3" || t === "h4" || t === "h5" || t === "h6") {
				gap();
				out.push("#".repeat(parseInt(t[1]!, 10)) + " " + inline(e));
			} else if (t === "p") {
				const tocAnchors = Array.from(e.children).filter(c => {
					const cn = c as HTMLElement;
					return cn.tagName.toLowerCase() === "a" && (cn.getAttribute("href") || "").startsWith("#_Toc");
				});
				const otherContent = Array.from(e.childNodes).filter(n => {
					if (n.nodeType === 3) return (n.textContent || "").trim() !== "";
					if (n.nodeType !== 1) return false;
					const nn = n as HTMLElement;
					const isTocA = nn.tagName.toLowerCase() === "a" && (nn.getAttribute("href") || "").startsWith("#_Toc");
					return !isTocA;
				});
				const hasBold = e.querySelectorAll("strong").length > 0 || e.querySelectorAll("b").length > 0;
				if ((tocAnchors.length > 0 && otherContent.length === 0 && !hasBold) || e.textContent?.trim() === "目录") continue;
				const lines = inline(e).split("\n").map(l => l.trim()).filter(Boolean);
				if (lines.length === 0) continue;
				gap();
				for (const line of lines) out.push(line);
			} else if (t === "hr") {
				gap();
				out.push("---");
			} else if (t === "blockquote") {
				gap();
				const inner = inline(e).replace(/\n/g, "\n> ");
				out.push("> " + inner);
			} else if (t === "ul" || t === "ol") {
				const prevEl = e.previousElementSibling as HTMLElement | null;
				const inFlow = !!prevEl && ["ul", "ol"].includes(prevEl.tagName.toLowerCase());
				const ordered = t === "ol";
				gap();
				if (inFlow && ordered) {
					walkList(e, "", contOlNext);
					contOlNext = contOlNext + (e.children.length || 0);
				} else if (inFlow) {
					walkList(e, "    ", 0);
					gap();
				} else {
					contOlNext = walkList(e, "", 1);
				}
			} else if (t === "table") {
				gap();
				walkTable(e);
			} else if (t === "br" || t === "li" || t === "tr" || t === "td" || t === "th" || t === "thead" || t === "tbody") {
				/* 由 walkList / walkTable 处理，忽略零散出现的 */
			} else {
				walk(e);
			}
		}
	};

	walk(doc.body);
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

type PdfWorkerNamespace = { WorkerMessageHandler: unknown };

let pdfWorkerNamespacePromise: Promise<PdfWorkerNamespace> | null = null;

async function loadPdfWorkerNamespace(): Promise<PdfWorkerNamespace> {
	if (!pdfWorkerNamespacePromise) {
		pdfWorkerNamespacePromise = import("pdfjs-dist/legacy/build/pdf.worker.mjs").then((m) => m as PdfWorkerNamespace);
	}
	return pdfWorkerNamespacePromise;
}

class DOMMatrixPolyfill {
	a: number; b: number; c: number; d: number; e: number; f: number;
	constructor(init?: Array<number> | DOMMatrixPolyfill) {
		const m = init === undefined ? [1, 0, 0, 1, 0, 0] : Array.isArray(init) ? init.slice() : [init.a, init.b, init.c, init.d, init.e, init.f];
		this.a = m[0]!; this.b = m[1]!; this.c = m[2]!; this.d = m[3]!; this.e = m[4]!; this.f = m[5]!;
	}
	get m(): number[] { return [this.a, this.b, this.c, this.d, this.e, this.f]; }
	get m11(): number { return this.a; } get m12(): number { return this.b; } get m13(): number { return 0; } get m14(): number { return 0; }
	get m21(): number { return this.c; } get m22(): number { return this.d; } get m23(): number { return 0; } get m24(): number { return 0; }
	get m31(): number { return 0; } get m32(): number { return 0; } get m33(): number { return 1; } get m34(): number { return 0; }
	get m41(): number { return this.e; } get m42(): number { return this.f; } get m43(): number { return 0; } get m44(): number { return 1; }
	get is2D(): boolean { return true; }
	get isIdentity(): boolean { return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0; }
	multiplySelf(other: DOMMatrixPolyfill): DOMMatrixPolyfill {
		const { a, b, c, d, e, f } = this;
		const o = other;
		this.a = a * o.a + c * o.b; this.b = b * o.a + d * o.b;
		this.c = a * o.c + c * o.d; this.d = b * o.c + d * o.d;
		this.e = a * o.e + c * o.f + e; this.f = b * o.e + d * o.f + f;
		return this;
	}
	multiply(other: DOMMatrixPolyfill): DOMMatrixPolyfill { return new DOMMatrixPolyfill(this.m).multiplySelf(other); }
	translateSelf(tx: number, ty: number): DOMMatrixPolyfill { return this.multiplySelf(new DOMMatrixPolyfill([1, 0, 0, 1, tx || 0, ty || 0])); }
	translate(tx: number, ty: number): DOMMatrixPolyfill { return new DOMMatrixPolyfill(this.m).translateSelf(tx, ty); }
	scaleSelf(sx: number, sy?: number): DOMMatrixPolyfill { return this.multiplySelf(new DOMMatrixPolyfill([sx, 0, 0, sy === undefined ? sx : sy, 0, 0])); }
	scale(sx: number, sy?: number): DOMMatrixPolyfill { return new DOMMatrixPolyfill(this.m).scaleSelf(sx, sy); }
	inverse(): DOMMatrixPolyfill {
		const m = this.m, a = m[0]!, b = m[1]!, c = m[2]!, d = m[3]!, e = m[4]!, f = m[5]!;
		const det = a * d - b * c;
		if (Math.abs(det) < 1e-12) return new DOMMatrixPolyfill([1, 0, 0, 1, 0, 0]);
		return new DOMMatrixPolyfill([d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]);
	}
	inverseSelf(): DOMMatrixPolyfill {
		const inv = this.inverse();
		this.a = inv.a; this.b = inv.b; this.c = inv.c; this.d = inv.d; this.e = inv.e; this.f = inv.f;
		return this;
	}
	rotateSelf(deg: number): DOMMatrixPolyfill {
		const r = deg * Math.PI / 180;
		const s = Math.sin(r), c = Math.cos(r);
		return this.multiplySelf(new DOMMatrixPolyfill([c, s, -s, c, 0, 0]));
	}
	rotate(deg: number): DOMMatrixPolyfill { return new DOMMatrixPolyfill(this.m).rotateSelf(deg); }
	transformPoint(p: { x: number; y: number }) {
		return { x: this.a * p.x + this.c * p.y + this.e, y: this.b * p.x + this.d * p.y + this.f, z: 0, w: 1 };
	}
	toFloat32Array(): Float32Array {
		return new Float32Array([this.a, this.b, 0, 0, this.c, this.d, 0, 0, 0, 0, 1, 0, this.e, this.f, 0, 1]);
	}
	toString(): string { return this.m.join(", "); }
}

const PDF_GLOBALS = ["pdfjsWorker", "pdfjsLib", "_pdfjsTestingUtils", "DOMMatrix", "ImageData", "Path2D", "navigator"] as const;

async function withPdfEnvironment<T>(fn: () => Promise<T>): Promise<T> {
	const g = globalThis as Record<string, unknown>;
	const saved = new Map<string, unknown>();
	for (const key of PDF_GLOBALS) {
		if (key in g) saved.set(key, g[key]);
	}
	try {
		if (!g.DOMMatrix) g.DOMMatrix = DOMMatrixPolyfill;
		if (!g.pdfjsWorker) {
			try {
				const worker = await loadPdfWorkerNamespace();
				if (worker && (worker as { WorkerMessageHandler?: unknown }).WorkerMessageHandler) {
					g.pdfjsWorker = worker;
				}
			} catch { /* empty */ }
		}
		return await fn();
	} finally {
		for (const key of PDF_GLOBALS) {
			try {
				if (saved.has(key)) g[key] = saved.get(key);
				else delete g[key];
			} catch { /* ignore read-only globals (e.g. navigator) */ }
		}
	}
}
