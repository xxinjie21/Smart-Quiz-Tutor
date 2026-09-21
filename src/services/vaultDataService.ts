import { Notice, TFile, TFolder, type App } from "obsidian";
import { Document, Packer } from "docx";
import * as fs from "fs";
import * as path from "path";

import { WRONG_NOTES_CACHE_TTL_MS } from "../constants";
import type { FmValue, HistoryEntry, PluginSettings, WrongAnswerNote } from "../types";
import { parseFM, buildFM } from "../utils/frontmatter";
import { isAbs, ensureFolderAbs, writeFileStr, readFileStr, listMdFilesRecursive, ensureFolder, isExcludedPath, joinPath, trashFileAbs } from "../utils/fs-utils";
import { safeName } from "../utils/text";
import { localDateStr } from "../utils/date";
import { stripAnswerSummarySection } from "../utils/layout";
import { buildWordParagraphs, exportPdfDirect } from "../utils/exporter";
import { getElectronRemote } from "../utils/electron";
import { t, tf } from "../i18n/index";
import { logError } from "../utils/log";

/** 插件向数据服务暴露的最小能力集（避免运行时循环依赖）。 */
export interface VaultDataProvider {
	app: App;
	readonly settings: PluginSettings;
	readonly history: HistoryEntry[];
	loadData(): Promise<unknown>;
	saveData(data: unknown): Promise<void>;
	rootPath(subFolder: string): string;
	rebuildKnowledgeIndex(): Promise<{ brokenLinks: number; duplicates: number }>;
}

/**
 * 从 frontmatter + 正文构造复习条目的读取默认值。
 *
 * 三种扫描（错题本 / 题库 / 笔记视图）的映射规则只有这两处不同，其余字段完全一致。
 * 原先这段映射被复制了 6 遍（每遍都是一整行 60+ 字符的字面量），任何字段改动都要改 6 处，
 * 极易漏改；现在统一走 {@link toNote}。
 */
export interface NoteParseDefaults {
	/** `wrongCount` 缺失时的默认值：错题本按 1 计（历史文件必然错过），题库 / 笔记按 0。 */
	wrongCount: number;
	/** `source` 缺失时是否回退为文件名本身（笔记视图需要，错题 / 题库留空）。 */
	sourceFallbackToSelf: boolean;
}

/** 错题本：没有 wrongCount 视为错过 1 次。 */
export const WRONG_NOTE_DEFAULTS: NoteParseDefaults = { wrongCount: 1, sourceFallbackToSelf: false };
/** 题库 / 笔记：没有 wrongCount 视为 0 次。 */
export const QUESTION_NOTE_DEFAULTS: NoteParseDefaults = { wrongCount: 0, sourceFallbackToSelf: false };
/** 笔记视图：`source` 缺失时用文件名兜底（笔记本身就是来源）。 */
export const NOTE_VIEW_DEFAULTS: NoteParseDefaults = { wrongCount: 0, sourceFallbackToSelf: true };

/**
 * 把一份 frontmatter + 正文映射成 `WrongAnswerNote`。
 *
 * 纯函数，便于测试；所有「缺字段时取什么默认值」的决策都集中在这里。
 */
export function toNote(
	meta: Record<string, FmValue>,
	body: string,
	filePath: string,
	baseName: string,
	d: NoteParseDefaults,
): WrongAnswerNote {
	// 注意 `noUncheckedIndexedAccess` 会让 meta.xxx 带上 undefined，这里正好一并兜住。
	const num = (v: FmValue | undefined, fallback: number): number => (typeof v === "number" ? v : fallback);
	const correctCount = num(meta.correctCount, 0);
	return {
		filePath,
		baseName,
		date: (meta.date as string) || "",
		sourceFile: (meta.source as string) || (d.sourceFallbackToSelf ? baseName : ""),
		sourcePath: (meta.sourcePath as string) || "",
		tags: Array.isArray(meta.tags) ? meta.tags : [],
		resultText: body,
		note: (meta.note as string) || "",
		nextReview: (meta.nextReview as string) || "",
		interval: num(meta.interval, 1),
		correctCount,
		wrongCount: num(meta.wrongCount, d.wrongCount),
		easeFactor: num(meta.easeFactor, 2.5),
		repetitions: num(meta.repetitions, Math.min(correctCount, 3)),
		// lapses 的兜底固定为 1，与「错题本」的 wrongCount 默认值一致（三种扫描原本都是 1）。
		lapses: num(meta.lapses, num(meta.wrongCount, 1)),
	};
}

/**
 * 负责知识库文件的读取/缓存/迁移/导出等纯数据与 IO 逻辑。
 * 缓存集中于本服务，插件通过同名薄封装转发，保持 `plugin.xxx` 调用点不变。
 */
export class VaultDataService {
	private _wrongNotesCache: WrongAnswerNote[] | null = null;
	private _wrongNotesCacheTime = 0;
	private _questionCache: WrongAnswerNote[] | null = null;
	private _questionCacheTime = 0;
	private _noteCache: WrongAnswerNote[] | null = null;
	private _noteCacheTime = 0;

	constructor(private p: VaultDataProvider) {}

	private fresh(cache: unknown, time: number): boolean {
		return !!cache && (Date.now() - time < WRONG_NOTES_CACHE_TTL_MS);
	}

	invalidateCache(): void {
		this._wrongNotesCache = null;
		this._wrongNotesCacheTime = 0;
		this._questionCache = null;
		this._questionCacheTime = 0;
		this._noteCache = null;
		this._noteCacheTime = 0;
	}

	async loadAllWrongNotes(forceRefresh = false): Promise<WrongAnswerNote[]> {
		const now = Date.now();
		if (!forceRefresh && this.fresh(this._wrongNotesCache, this._wrongNotesCacheTime)) {
			return this._wrongNotesCache!;
		}
		const notes: WrongAnswerNote[] = [];
		const folder = this.p.rootPath(this.p.settings.wrongBookFolder);
		const excludes = this.p.settings.excludeFolders || "";
		if (isAbs(folder)) {
			ensureFolderAbs(folder);
			for (const f of listMdFilesRecursive(folder)) {
				const fp = f.replace(/\\/g, "/");
				if (isExcludedPath(fp, excludes)) continue;
				const { meta, body } = parseFM(readFileStr(fp));
				notes.push(toNote(meta, body, fp, path.basename(fp).replace(/\.md$/, ""), WRONG_NOTE_DEFAULTS));
			}
		} else {
			const prefix = folder.endsWith("/") ? folder : folder + "/";
			for (const child of this.p.app.vault.getFiles()) {
				if (child.extension !== "md" || !child.path.startsWith(prefix)) continue;
				if (isExcludedPath(child.path, excludes)) continue;
				const { meta, body } = parseFM(await this.p.app.vault.read(child));
				notes.push(toNote(meta, body, child.path, child.basename, WRONG_NOTE_DEFAULTS));
			}
		}
		this._wrongNotesCache = notes;
		this._wrongNotesCacheTime = now;
		return notes;
	}

	async loadAllQuestionFilesForReview(forceRefresh = false): Promise<WrongAnswerNote[]> {
		const now = Date.now();
		if (!forceRefresh && this.fresh(this._questionCache, this._questionCacheTime)) {
			return this._questionCache!;
		}
		const folder = this.p.rootPath(this.p.settings.questionFolder);
		const excludes = [this.p.rootPath(this.p.settings.knowledgeFolder)].filter(Boolean);
		const excludeCfg = this.p.settings.excludeFolders || "";
		const notes: WrongAnswerNote[] = [];
		if (isAbs(folder)) {
			ensureFolderAbs(folder);
			for (const f of listMdFilesRecursive(folder, excludes)) {
				const fp = f.replace(/\\/g, "/");
				if (isExcludedPath(fp, excludeCfg)) continue;
				const { meta, body } = parseFM(readFileStr(fp));
				notes.push(toNote(meta, body, fp, path.basename(fp).replace(/\.md$/, ""), QUESTION_NOTE_DEFAULTS));
			}
		} else {
			const folderFile = this.p.app.vault.getAbstractFileByPath(folder);
			if (folderFile instanceof TFolder) {
				const prefix = folder.endsWith("/") ? folder : folder + "/";
				const exclPrefixes = excludes.map(p => (p.endsWith("/") ? p : p + "/"));
				const children = this.p.app.vault.getFiles().filter(f => f.path.startsWith(prefix) && f.extension === "md" && !exclPrefixes.some(e => f.path.startsWith(e)) && !isExcludedPath(f.path, excludeCfg));
				for (const child of children) {
					const { meta, body } = parseFM(await this.p.app.vault.read(child));
					notes.push(toNote(meta, body, child.path, child.basename, QUESTION_NOTE_DEFAULTS));
				}
			}
		}
		this._questionCache = notes;
		this._questionCacheTime = now;
		return notes;
	}

	async loadAllVaultNotesForReview(forceRefresh = false): Promise<WrongAnswerNote[]> {
		const now = Date.now();
		if (!forceRefresh && this.fresh(this._noteCache, this._noteCacheTime)) {
			return this._noteCache!;
		}
		const folder = this.p.rootPath(this.p.settings.noteViewFolder);
		const excludeCfg = this.p.settings.excludeFolders || "";
		const notes: WrongAnswerNote[] = [];
		if (!folder) return notes;
		if (isAbs(folder)) {
			ensureFolderAbs(folder);
			for (const f of listMdFilesRecursive(folder)) {
				const fp = f.replace(/\\/g, "/");
				if (isExcludedPath(fp, excludeCfg)) continue;
				const { meta, body } = parseFM(readFileStr(fp));
				notes.push(toNote(meta, body, fp, path.basename(fp).replace(/\.md$/, ""), NOTE_VIEW_DEFAULTS));
			}
		} else {
			const prefix = folder.endsWith("/") ? folder : folder + "/";
			for (const child of this.p.app.vault.getFiles()) {
				if (child.extension !== "md" || !child.path.startsWith(prefix)) continue;
				if (isExcludedPath(child.path, excludeCfg)) continue;
				const { meta, body } = parseFM(await this.p.app.vault.read(child));
				notes.push(toNote(meta, body, child.path, child.basename, NOTE_VIEW_DEFAULTS));
			}
		}
		this._noteCache = notes;
		this._noteCacheTime = now;
		return notes;
	}

	async migrateOldWrongAnswers(): Promise<void> {
		const data = await this.p.loadData() as { wrongAnswers?: { timestamp?: number; fileName?: string; note?: string; resultText?: string }[] } | null;
		if (data?.wrongAnswers && data.wrongAnswers.length > 0) {
			const folder = this.p.rootPath(this.p.settings.wrongBookFolder);
			await ensureFolder(this.p.app, folder);
			let migrated = 0;
			for (const old of data.wrongAnswers) {
				const dateStr = old.timestamp ? localDateStr(new Date(old.timestamp)) : localDateStr();
				const tags = ["错题"];
				const fm = buildFM({ source: old.fileName || "未知", date: dateStr, tags, note: old.note || "" });
				const content = fm + (old.resultText || "");
				const fileName = safeName(old.fileName || "未知") + "_错题_" + dateStr + "_" + migrated + ".md";
				try {
					if (isAbs(folder)) writeFileStr(joinPath(folder, fileName), content);
					else await this.p.app.vault.create(folder + "/" + fileName, content);
					migrated++;
				} catch (err) { logError("migrate wrong answer failed: " + fileName, err); }
			}
			if (migrated > 0) new Notice(tf("已迁移 {n} 条旧错题到 {folder}", { n: migrated, folder }));
			data.wrongAnswers = [];
			await this.p.saveData({ ...this.p.settings, history: this.p.history, wrongAnswers: [] });
		}
	}

	/**
	 * 删除一条错题记录（vault 外走系统回收站，不再永久删除）。
	 *
	 * @param skipRebuild 批量删除时传 `true`，由调用方在循环结束后统一重建一次索引，
	 *                    避免「删 N 条 = 全量重建 N 次」。
	 */
	async deleteWrongNote(filePath: string, skipRebuild = false): Promise<void> {
		if (isAbs(filePath)) {
			await trashFileAbs(filePath);
		} else {
			const file = this.p.app.vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile) await this.p.app.fileManager.trashFile(file);
		}
		this.invalidateCache();
		if (!skipRebuild) await this.p.rebuildKnowledgeIndex();
	}

	async exportToFile(text: string, defaultName: string, format: "md" | "word" | "pdf", title?: string, source?: string): Promise<void> {
		try {
			if (format === "md") {
				const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: defaultName + ".md", filters: [{ name: "Markdown", extensions: ["md"] }] });
				if (r.canceled || !r.filePath) return;
				const dateStr = localDateStr();
				const mdHeader = title ? "# " + title + "\n\n> 来源：" + (source || title) + "　|　日期：" + dateStr + "\n\n" : "";
				fs.writeFileSync(r.filePath, mdHeader + stripAnswerSummarySection(text), "utf-8");
				new Notice(t("Md文件已保存"));
			} else if (format === "word") {
				const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: defaultName + ".docx", filters: [{ name: "Word", extensions: ["docx"] }] });
				if (r.canceled || !r.filePath) return;
				const children = buildWordParagraphs(text, title, source);
				const doc = new Document({ sections: [{ properties: {}, children }] });
				const buffer = await Packer.toBuffer(doc);
				fs.writeFileSync(r.filePath, Buffer.from(buffer));
				new Notice(t("Word文件已保存"));
			} else if (format === "pdf") {
				const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: defaultName + ".pdf", filters: [{ name: "PDF", extensions: ["pdf"] }] });
				if (r.canceled || !r.filePath) return;
				await exportPdfDirect(r.filePath, text, title, source);
				new Notice(t("PDF文件已保存"));
			}
		} catch (err) { new Notice(tf("导出失败：{msg}", { msg: (err as Error).message })); }
	}
}
