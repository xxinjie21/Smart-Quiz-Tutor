import { App } from "obsidian";
import * as fs from "fs";

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

export function listMdFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir).filter((f: string) => f.endsWith(".md"));
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
