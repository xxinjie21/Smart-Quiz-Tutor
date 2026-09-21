import { App } from "obsidian";
import * as fs from "fs";
import * as path from "path";

import { localDateStr } from "./date";
import { getElectronShell } from "./electron";

/** vault 之外的文件被删除时移入的同级子目录名（回收站不可用时的兜底）。 */
export const TRASH_DIR_NAME = ".qg-trash";

export function isAbs(p: string): boolean {
	return /^[A-Za-z]:[/\\]/.test(p) || p.startsWith("/");
}

export function daysUntil(dateStr: string): number {
	const today = localDateStr();
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

/** 递归遍历时跳过的目录名（兜底回收站目录）。 */
function shouldSkipDir(name: string): boolean {
	return name === TRASH_DIR_NAME;
}

export function listFilesRecursive(dir: string, exts: readonly string[], excludePrefixes: string[] = []): string[] {
	if (!fs.existsSync(dir)) return [];
	const ex = excludePrefixes.filter(Boolean).map(p => path.normalize(p));
	const out: string[] = [];
	const walk = (d: string) => {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			const fp = path.join(d, entry.name);
			if (entry.isDirectory()) {
				if (shouldSkipDir(entry.name)) continue;
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
				if (shouldSkipDir(entry.name)) continue;
				if (ex.some(p => fp === p || fp.startsWith(p + path.sep))) continue;
				walk(fp);
			}
			else if (entry.name.endsWith(".md")) out.push(fp);
		}
	};
	walk(dir);
	return out;
}

/**
 * 删除 vault 之外的绝对路径文件。
 *
 * 优先移入**系统回收站**；回收站不可用（Electron 版本不支持等）时退回同目录下的
 * `.qg-trash/` 子目录——仍然可以人工找回，**绝不静默永久删除**。
 *
 * @returns 是否已成功移走（文件本就不存在也视为成功）
 */
export async function trashFileAbs(filePath: string): Promise<boolean> {
	if (!fs.existsSync(filePath)) return true;

	const shell = getElectronShell();
	if (shell?.trashItem) {
		try {
			await shell.trashItem(filePath);
			return true;
		} catch { /* 回收站不可用，走本地兜底 */ }
	}

	try {
		const dir = path.dirname(filePath);
		const trashDir = path.join(dir, TRASH_DIR_NAME);
		if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true });
		const target = path.join(trashDir, path.basename(filePath) + "." + Date.now().toString(36));
		fs.renameSync(filePath, target);
		return true;
	} catch {
		return false;
	}
}

/**
 * 把文件移入回收站（系统回收站优先，不可用时退回同目录 `.qg-trash` 兜底）。
 * 这是本插件唯一的删除入口——所有删除都必须是可恢复的。
 */
async function vaultPathExists(app: App, p: string): Promise<boolean> {
	try { return await app.vault.adapter.exists(p); } catch { return false; }
}

/**
 * 幂等地确保文件夹存在：
 * - 相对路径按 `/` 逐级创建（父目录缺失也能补齐）；
 * - 存在性同时参考 vault 索引与文件系统真值（onload 早期索引可能未就绪）；
 * - 吞掉 "already exists" 类错误，其余再抛出。
 */
export async function ensureFolder(app: App, folderPath: string) {
	if (!folderPath) return;
	if (isAbs(folderPath)) {
		ensureFolderAbs(folderPath);
		return;
	}
	const parts = folderPath.split("/").filter(Boolean);
	let cur = "";
	for (const part of parts) {
		cur = cur ? cur + "/" + part : part;
		if (app.vault.getAbstractFileByPath(cur)) continue;
		if (await vaultPathExists(app, cur)) continue;
		try {
			await app.vault.createFolder(cur);
		} catch (err) {
			if (await vaultPathExists(app, cur)) continue;
			if (/already exists/i.test(String((err as Error)?.message ?? err))) continue;
			throw err;
		}
	}
}

export function parseExcludeFolderNames(cfgStr: string): string[] {
	return cfgStr.split(",").map(s => s.trim()).filter(Boolean);
}

export function isExcludedPath(p: string, excludeConfig: string): boolean {
	const segments = p.replace(/\\/g, "/").split("/");
	// 兜底回收站目录永远不参与扫描，避免「已删除」的文件重新出现在列表里
	if (segments.includes(TRASH_DIR_NAME)) return true;
	const names = parseExcludeFolderNames(excludeConfig);
	if (names.length === 0) return false;
	return names.some(n => segments.includes(n));
}

export function joinPath(dir: string, name: string): string {
	const base = dir.replace(/\\/g, "/").replace(/\/+$/, "");
	const file = name.replace(/\\/g, "/").replace(/^\/+/, "");
	return base + "/" + file;
}
