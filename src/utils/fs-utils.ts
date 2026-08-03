import { App } from "obsidian";
import * as fs from "fs";
import * as path from "path";

export function isAbs(p: string): boolean {
	return /^[A-Za-z]:[/\\]/.test(p) || p.startsWith("/");
}

export function daysUntil(dateStr: string): number {
	const today = new Date().toISOString().slice(0, 10);
	const diff = new Date(dateStr).getTime() - new Date(today).getTime();
	return Math.max(0, Math.ceil(diff / 86400000));
}

export function ensureFolderAbs(dir: string) {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function writeFileStr(filePath: string, content: string) {
	fs.writeFileSync(filePath, content, "utf-8");
}

export function readFileStr(filePath: string): string {
	return fs.readFileSync(filePath, "utf-8");
}

export const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp"] as const;
export const DOCUMENT_EXTS = ["txt", "rtf", "docx", "pdf"] as const;
export const EXAM_SOURCE_EXTS = [...IMAGE_EXTS, ...DOCUMENT_EXTS] as string[];

export function isImageFile(name: string): boolean {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	return (IMAGE_EXTS as readonly string[]).includes(ext);
}

export function isDocumentFile(name: string): boolean {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	return (DOCUMENT_EXTS as readonly string[]).includes(ext);
}

export function listMdFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir).filter((f: string) => f.endsWith(".md"));
}

export function listFilesRecursive(dir: string, exts: readonly string[], excludePrefixes: string[] = []): string[] {
	if (!fs.existsSync(dir)) return [];
	const ex = excludePrefixes.filter(Boolean).map(p => path.normalize(p));
	const out: string[] = [];
	const walk = (d: string) => {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			const fp = path.join(d, entry.name);
			if (entry.isDirectory()) {
				if (ex.some(p => fp === p || fp.startsWith(p + path.sep))) continue;
				walk(fp);
			} else {
				const ext = path.extname(entry.name).slice(1).toLowerCase();
				if (exts.includes(ext)) out.push(fp);
			}
		}
	};
	walk(dir);
	return out;
}

export function listMdFilesRecursive(dir: string, excludePrefixes: string[] = []): string[] {
	if (!fs.existsSync(dir)) return [];
	const ex = excludePrefixes.filter(Boolean).map(p => path.normalize(p));
	const out: string[] = [];
	const walk = (d: string) => {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			const fp = path.join(d, entry.name);
			if (entry.isDirectory()) {
				if (ex.some(p => fp === p || fp.startsWith(p + path.sep))) continue;
				walk(fp);
			}
			else if (entry.name.endsWith(".md")) out.push(fp);
		}
	};
	walk(dir);
	return out;
}

export function deleteFileAbs(filePath: string) {
	if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

export async function ensureFolder(app: App, folderPath: string) {
	if (isAbs(folderPath)) {
		ensureFolderAbs(folderPath);
	} else {
		if (folderPath && !app.vault.getAbstractFileByPath(folderPath)) {
			await app.vault.createFolder(folderPath);
		}
	}
}

export function parseExcludeFolderNames(cfgStr: string): string[] {
	return cfgStr.split(",").map(s => s.trim()).filter(Boolean);
}

export function isExcludedPath(p: string, excludeConfig: string): boolean {
	const names = parseExcludeFolderNames(excludeConfig);
	if (names.length === 0) return false;
	const segments = p.replace(/\\/g, "/").split("/");
	return names.some(n => segments.includes(n));
}

export function joinPath(dir: string, name: string): string {
	const base = dir.replace(/\\/g, "/").replace(/\/+$/, "");
	const file = name.replace(/\\/g, "/").replace(/^\/+/, "");
	return base + "/" + file;
}
