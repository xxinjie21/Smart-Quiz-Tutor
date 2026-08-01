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
			const { extractRawText } = await import("mammoth");
			const result = await extractRawText({ path: filePath });
			return result.value || "";
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

function stripRtf(raw: string): string {
	let text = raw
		.replace(/\\par[d]?\b/g, "\n")
		.replace(/\\tab\b/g, "\t")
		.replace(/\\[a-zA-Z]+(-?\d+)?\s?/g, "")
		.replace(/[{}]/g, "")
		.replace(/\\(?:[a-z]|'[0-9a-fA-F]{2})/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	text = text.replace(/\u2028/g, "\n");
	return text;
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
