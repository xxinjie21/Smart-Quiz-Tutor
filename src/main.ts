import { Plugin, TFile, TFolder, Notice, Editor, Menu, MarkdownView, MarkdownFileInfo } from "obsidian";
import { Document, Packer } from "docx";
import * as fs from "fs";
import * as path from "path";

import { DEFAULT_SETTINGS, SIDEBAR_VIEW_TYPE, NOTICE_DURATION_MS, REVIEW_REMINDER_DELAY_MS, WRONG_NOTES_CACHE_TTL_MS } from "./constants";
import type { HistoryEntry, WrongAnswerNote, PluginSettings } from "./types";
import { parseFM, buildFM, knowledgeTags } from "./utils/frontmatter";
import { isAbs, ensureFolderAbs, writeFileStr, readFileStr, listMdFiles, ensureFolder } from "./utils/fs-utils";
import { safeName } from "./utils/text";
import { todayStr, isDueForReview } from "./utils/review";
import { stripAnswerSummarySection } from "./utils/layout";
import { buildWordParagraphs, exportPdfDirect } from "./utils/exporter";
import { getElectronRemote } from "./utils/electron";
import { MainSidebarView } from "./views/sidebarView";
import { QuestionGeneratorSettingTab } from "./views/settingTab";

// ===================== 主插件入口 =====================

export default class QuestionGeneratorPlugin extends Plugin {
	settings!: PluginSettings;
	history: HistoryEntry[] = [];

	async loadSettings() {
		const data = await this.loadData() as { history?: HistoryEntry[]; wrongAnswers?: { timestamp?: number; fileName?: string; note?: string; resultText?: string }[] } | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		if (data?.history) this.history = data.history;
	}
	rootPath(subFolder: string): string {
		const root = this.settings.rootFolder;
		if (!root) return subFolder;
		if (isAbs(subFolder)) return subFolder;
		return root + "/" + subFolder;
	}
	async saveSettings() {
		await this.saveData({ ...this.settings, history: this.history });
	}
	async saveHistory() {
		await this.saveData({ ...this.settings, history: this.history });
	}
	async addHistory(entry: HistoryEntry) {
		this.history.push(entry);
		await this.saveHistory();
	}

	async migrateOldWrongAnswers() {
		const data = await this.loadData() as { wrongAnswers?: { timestamp?: number; fileName?: string; note?: string; resultText?: string }[] } | null;
		if (data?.wrongAnswers && data.wrongAnswers.length > 0) {
			const folder = this.rootPath(this.settings.wrongBookFolder);
			await ensureFolder(this.app, folder);
			let migrated = 0;
			for (const old of data.wrongAnswers) {
				const dateStr = old.timestamp ? new Date(old.timestamp).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
				const tags = ["错题"];
				const fm = buildFM({ source: old.fileName || "未知", date: dateStr, tags, note: old.note || "" });
				const content = fm + (old.resultText || "");
				const fileName = safeName(old.fileName || "未知") + "_错题_" + dateStr + "_" + migrated + ".md";
				try {
					if (isAbs(folder)) writeFileStr(folder + "\\" + fileName, content);
					else await this.app.vault.create(folder + "/" + fileName, content);
					migrated++;
				} catch { /* empty */ }
			}
			if (migrated > 0) new Notice("已迁移 " + migrated + " 条旧错题到 " + folder);
			data.wrongAnswers = [];
			await this.saveData({ ...this.settings, history: this.history, wrongAnswers: [] });
		}
	}

	// ===================== 集中数据管理 =====================
	private _wrongNotesCache: WrongAnswerNote[] | null = null;
	private _cacheTime = 0;
	private _refreshCallbacks: (() => void)[] = [];

	invalidateCache() { this._wrongNotesCache = null; this._cacheTime = 0; }

	onDataChanged(callback: () => void) { this._refreshCallbacks.push(callback); }

	offDataChanged(callback: () => void) { this._refreshCallbacks = this._refreshCallbacks.filter(cb => cb !== callback); }

	emitDataChanged() { this.invalidateCache(); for (const cb of this._refreshCallbacks) { try { cb(); } catch { /* empty */ } } }

	async updateKnowledgePointMOC(tags: string[], noteFileName: string) {
		const kp = knowledgeTags(tags);
		if (kp.length === 0) return;
		const mocFolder = this.rootPath(this.settings.wrongKnowledgeFolder);
		await ensureFolder(this.app, mocFolder);
		for (const tag of kp) {
			const mocPath = mocFolder + "/" + safeName(tag) + ".md";
			const link = "[[" + noteFileName.replace(/\.md$/, "") + "]]";
			let existing = "";
			let existingLinks: string[] = [];
			try {
				if (isAbs(mocFolder)) {
					existing = readFileStr(mocPath);
				} else {
					const f = this.app.vault.getAbstractFileByPath(mocPath);
					if (f instanceof TFile) existing = await this.app.vault.read(f);
				}
				const { meta, body } = parseFM(existing);
				existingLinks = Array.isArray(meta.relatedLinks) ? meta.relatedLinks : [];
				const linkPattern = /\[\[([^\]]+)\]\]/g;
				let m;
				while ((m = linkPattern.exec(body)) !== null) { if (!existingLinks.includes(m[1]!)) existingLinks.push(m[1]!); }
			} catch { /* empty */ }
			if (!existingLinks.includes(link.replace(/\[\[|\]\]/g, ""))) existingLinks.push(link.replace(/\[\[|\]\]/g, ""));
			const fm = buildFM({ tags: ["知识点", tag], relatedLinks: existingLinks, date: todayStr() });
			let body = "# " + tag + "\n\n";
			body += "> 知识点索引（MOC），由智学助手自动维护\n\n";
			body += "## 相关错题\n\n";
			for (const l of existingLinks) {
				body += "- [[" + l.replace(/\[\[|\]\]/g, "") + "]]\n";
			}
			try {
				if (isAbs(mocFolder)) {
					writeFileStr(mocPath, fm + body);
				} else {
					const existingFile = this.app.vault.getAbstractFileByPath(mocPath);
					if (existingFile instanceof TFile) await this.app.vault.modify(existingFile, fm + body);
					else await this.app.vault.create(mocPath, fm + body);
				}
			} catch { /* empty */ }
		}
	}

	async loadAllWrongNotes(forceRefresh = false): Promise<WrongAnswerNote[]> {
		const now = Date.now();
		if (!forceRefresh && this._wrongNotesCache && (now - this._cacheTime < WRONG_NOTES_CACHE_TTL_MS)) {
			return this._wrongNotesCache;
		}
		const notes: WrongAnswerNote[] = [];
		const folder = this.rootPath(this.settings.wrongBookFolder);
		if (isAbs(folder)) {
			ensureFolderAbs(folder);
			for (const f of listMdFiles(folder)) {
				const { meta, body } = parseFM(readFileStr(folder + "/" + f));
				notes.push({ filePath: folder + "/" + f, baseName: f.replace(/\.md$/, ""), date: (meta.date as string) || "", sourceFile: (meta.source as string) || "", sourcePath: (meta.sourcePath as string) || "", tags: Array.isArray(meta.tags) ? meta.tags : [], resultText: body, note: (meta.note as string) || "", nextReview: (meta.nextReview as string) || "", interval: typeof meta.interval === "number" ? meta.interval : 1, correctCount: typeof meta.correctCount === "number" ? meta.correctCount : 0, wrongCount: typeof meta.wrongCount === "number" ? meta.wrongCount : 1 });
			}
		} else {
			const folderFile = this.app.vault.getAbstractFileByPath(folder);
			if (folderFile instanceof TFolder) {
				for (const child of folderFile.children) {
					if (child instanceof TFile && child.extension === "md") {
						const { meta, body } = parseFM(await this.app.vault.read(child));
						notes.push({ filePath: child.path, baseName: child.basename, date: (meta.date as string) || "", sourceFile: (meta.source as string) || "", sourcePath: (meta.sourcePath as string) || "", tags: Array.isArray(meta.tags) ? meta.tags : [], resultText: body, note: (meta.note as string) || "", nextReview: (meta.nextReview as string) || "", interval: typeof meta.interval === "number" ? meta.interval : 1, correctCount: typeof meta.correctCount === "number" ? meta.correctCount : 0, wrongCount: typeof meta.wrongCount === "number" ? meta.wrongCount : 1 });
					}
				}
			}
		}
		this._wrongNotesCache = notes;
		this._cacheTime = now;
		return notes;
	}

	async loadAllQuestionFilesForReview(): Promise<WrongAnswerNote[]> {
		const folder = this.rootPath(this.settings.questionFolder);
		const notes: WrongAnswerNote[] = [];
		if (isAbs(folder)) {
			ensureFolderAbs(folder);
			for (const f of listMdFiles(folder)) {
				const { meta, body } = parseFM(readFileStr(folder + "/" + f));
				notes.push({ filePath: folder + "/" + f, baseName: f.replace(/\.md$/, ""), date: (meta.date as string) || "", sourceFile: (meta.source as string) || "", sourcePath: (meta.sourcePath as string) || "", tags: Array.isArray(meta.tags) ? meta.tags : [], resultText: body, note: (meta.note as string) || "", nextReview: (meta.nextReview as string) || "", interval: typeof meta.interval === "number" ? meta.interval : 1, correctCount: typeof meta.correctCount === "number" ? meta.correctCount : 0, wrongCount: typeof meta.wrongCount === "number" ? meta.wrongCount : 0 });
			}
		} else {
			const folderFile = this.app.vault.getAbstractFileByPath(folder);
			if (folderFile instanceof TFolder) {
				for (const child of folderFile.children) {
					if (child instanceof TFile && child.extension === "md") {
						const { meta, body } = parseFM(await this.app.vault.read(child));
						notes.push({ filePath: child.path, baseName: child.basename, date: (meta.date as string) || "", sourceFile: (meta.source as string) || "", sourcePath: (meta.sourcePath as string) || "", tags: Array.isArray(meta.tags) ? meta.tags : [], resultText: body, note: (meta.note as string) || "", nextReview: (meta.nextReview as string) || "", interval: typeof meta.interval === "number" ? meta.interval : 1, correctCount: typeof meta.correctCount === "number" ? meta.correctCount : 0, wrongCount: typeof meta.wrongCount === "number" ? meta.wrongCount : 0 });
					}
				}
			}
		}
		return notes;
	}

	async loadAllVaultNotesForReview(): Promise<WrongAnswerNote[]> {
		const folder = this.rootPath(this.settings.noteViewFolder);
		const notes: WrongAnswerNote[] = [];
		if (!folder) return notes;
		if (isAbs(folder)) {
			ensureFolderAbs(folder);
			for (const f of listMdFiles(folder)) {
				const { meta, body } = parseFM(readFileStr(folder + "/" + f));
				notes.push({ filePath: folder + "/" + f, baseName: f.replace(/\.md$/, ""), date: (meta.date as string) || "", sourceFile: (meta.source as string) || f.replace(/\.md$/, ""), sourcePath: (meta.sourcePath as string) || "", tags: Array.isArray(meta.tags) ? meta.tags : [], resultText: body, note: (meta.note as string) || "", nextReview: (meta.nextReview as string) || "", interval: typeof meta.interval === "number" ? meta.interval : 1, correctCount: typeof meta.correctCount === "number" ? meta.correctCount : 0, wrongCount: typeof meta.wrongCount === "number" ? meta.wrongCount : 0 });
			}
		} else {
			const folderFile = this.app.vault.getAbstractFileByPath(folder);
			if (folderFile instanceof TFolder) {
				for (const child of folderFile.children) {
					if (child instanceof TFile && child.extension === "md") {
						const { meta, body } = parseFM(await this.app.vault.read(child));
						notes.push({ filePath: child.path, baseName: child.basename, date: (meta.date as string) || "", sourceFile: (meta.source as string) || child.basename, sourcePath: (meta.sourcePath as string) || "", tags: Array.isArray(meta.tags) ? meta.tags : [], resultText: body, note: (meta.note as string) || "", nextReview: (meta.nextReview as string) || "", interval: typeof meta.interval === "number" ? meta.interval : 1, correctCount: typeof meta.correctCount === "number" ? meta.correctCount : 0, wrongCount: typeof meta.wrongCount === "number" ? meta.wrongCount : 0 });
					}
				}
			}
		}
		return notes;
	}

	async loadExistingKnowledgeTags(): Promise<string[]> {
		const folders = [this.rootPath(this.settings.questionKnowledgeFolder), this.rootPath(this.settings.noteKnowledgeFolder), this.rootPath(this.settings.wrongKnowledgeFolder)];
		const tagSet = new Set<string>();
		for (const folder of folders) {
			if (!folder) continue;
			if (isAbs(folder)) {
				if (!fs.existsSync(folder)) continue;
				for (const f of listMdFiles(folder)) {
					tagSet.add(f.replace(/\.md$/, ""));
				}
			} else {
				const folderFile = this.app.vault.getAbstractFileByPath(folder);
				if (folderFile instanceof TFolder) {
					for (const child of folderFile.children) {
						if (child instanceof TFile && child.extension === "md") {
							tagSet.add(child.basename);
						}
					}
				}
			}
		}
		return [...tagSet];
	}

	async syncKnowledgeFolder(tags: string[], links: { label: string; path: string }[], folderOverride?: string) {
		const folder = folderOverride || this.rootPath(this.settings.wrongKnowledgeFolder);
		if (!folder) return;
		if (isAbs(folder)) {
			if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
			for (const tag of tags) {
				const fp = folder + "\\" + tag + ".md";
				const existingLinks: string[] = [];
				if (fs.existsSync(fp)) {
					const content = fs.readFileSync(fp, "utf-8");
					const linkMatches = content.match(/\[\[([^\]]+)\]\]/g);
					if (linkMatches) existingLinks.push(...linkMatches.map(l => l.replace(/\[\[|\]\]/g, "")));
				}
				const allLinks = [...new Set([...existingLinks, ...links.map(l => l.label)])].sort();
				const body = `---\ntags: [知识点]\n---\n# ${tag}\n\n## 相关题目\n${allLinks.filter(l => l.includes("试题")).map(l => "-[[" + l + "]]").join("\n") || "暂无"}\n\n## 相关错题\n${allLinks.filter(l => !l.includes("试题")).map(l => "-[[" + l + "]]").join("\n") || "暂无"}\n`;
				fs.writeFileSync(fp, body, "utf-8");
			}
		} else {
			const folderObj = this.app.vault.getAbstractFileByPath(folder);
			if (!folderObj || !(folderObj instanceof TFolder)) {
				await this.app.vault.createFolder(folder).catch(() => {});
			}
			for (const tag of tags) {
				const fp = folder + "/" + tag + ".md";
				const existingFile = this.app.vault.getAbstractFileByPath(fp);
				const existingLinks: string[] = [];
				if (existingFile instanceof TFile) {
					const content = await this.app.vault.read(existingFile);
					const linkMatches = content.match(/\[\[([^\]]+)\]\]/g);
					if (linkMatches) existingLinks.push(...linkMatches.map(l => l.replace(/\[\[|\]\]/g, "")));
				}
				const allLinks = [...new Set([...existingLinks, ...links.map(l => l.label)])].sort();
				const body = `---\ntags: [知识点]\n---\n# ${tag}\n\n## 相关题目\n${allLinks.filter(l => l.includes("试题")).map(l => "-[[" + l + "]]").join("\n") || "暂无"}\n\n## 相关错题\n${allLinks.filter(l => !l.includes("试题")).map(l => "-[[" + l + "]]").join("\n") || "暂无"}\n`;
				if (existingFile instanceof TFile) {
					await this.app.vault.modify(existingFile, body);
				} else {
					await this.app.vault.create(fp, body);
				}
			}
		}
	}

	async rebuildKnowledgeIndex() {
		const tagMap: Record<string, { label: string; path: string }[]> = {};
		const addLink = (tag: string, label: string, p: string) => {
			const arr = tagMap[tag] || (tagMap[tag] = []);
			if (!arr.some(l => l.label === label)) arr.push({ label, path: p });
		};
		const wrongNotes = await this.loadAllWrongNotes();
		for (const n of wrongNotes) {
			for (const t of knowledgeTags(n.tags)) addLink(t, n.baseName, n.filePath);
		}
		const extractTagsFromFile = async (file: TFile, folder: string) => {
			try {
				let content = "";
				if (isAbs(folder)) { content = readFileStr(file.path); } else { content = await this.app.vault.read(file); }
				const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
				if (fmMatch) {
					const tagMatch = fmMatch[1]!.match(/tags:\s*\[([^\]]*)\]/);
					if (tagMatch) {
						const tags = tagMatch[1]!.split(",").map(s => s.trim()).filter(Boolean);
						for (const t of knowledgeTags(tags)) addLink(t, file.basename, file.path);
					}
				}
			} catch { /* skip */ }
		};
		const listMdFiles = (folder: string): TFile[] => {
			if (isAbs(folder)) {
				try {
					if (!fs.existsSync(folder)) return [];
					return fs.readdirSync(folder).filter((f: string) => f.endsWith(".md")).map((f: string) => {
						const fp = path.join(folder, f);
						const stat = fs.statSync(fp);
						return { name: f, path: fp, basename: f.replace(/\.md$/, ""), stat: { mtime: stat.mtimeMs, size: stat.size } } as unknown as TFile;
					});
				} catch { return []; }
			}
			try {
				const tfolder = this.app.vault.getAbstractFileByPath(folder);
				if (!tfolder || !(tfolder instanceof TFolder)) return [];
				return (tfolder.children as TFile[]).filter(f => f instanceof TFile && f.name.endsWith(".md"));
			} catch { return []; }
		};
		const qFolder = this.rootPath(this.settings.questionFolder);
		if (qFolder) {
			for (const f of listMdFiles(qFolder)) await extractTagsFromFile(f, qFolder);
		}
		const nFolder = this.rootPath(this.settings.noteViewFolder);
		if (nFolder) {
			for (const f of listMdFiles(nFolder)) await extractTagsFromFile(f, nFolder);
		}
		const allTags = Object.keys(tagMap);
		const knowledgeFolders = [this.rootPath(this.settings.questionKnowledgeFolder), this.rootPath(this.settings.noteKnowledgeFolder), this.rootPath(this.settings.wrongKnowledgeFolder)];
		for (const kf of knowledgeFolders) {
			if (!kf) continue;
			if (allTags.length > 0) await this.syncKnowledgeFolder(allTags, [], kf);
			for (const [tag, links] of Object.entries(tagMap)) {
				await this.syncKnowledgeFolder([tag], links, kf);
			}
		}
	}

	async deleteWrongNote(filePath: string) {
		if (isAbs(filePath)) {
			if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
		} else {
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile) await this.app.fileManager.trashFile(file);
		}
		this.invalidateCache();
		void this.rebuildKnowledgeIndex();
	}

	async getWeakPoints(): Promise<{ tag: string; count: number; questions: WrongAnswerNote[] }[]> {
		const notes = await this.loadAllWrongNotes();
		const threshold = this.settings.weakPointThreshold || 2;
		const tagMap: Record<string, WrongAnswerNote[]> = {};
		for (const n of notes) {
			for (const t of knowledgeTags(n.tags)) {
				if (!tagMap[t]) tagMap[t] = [];
				tagMap[t].push(n);
			}
		}
		return Object.entries(tagMap)
			.filter(([_, list]) => list.length >= threshold)
			.map(([tag, list]) => ({ tag, count: list.length, questions: list }))
			.sort((a, b) => b.count - a.count);
	}

	async migrateKnowledgeLinks() {
		const notes = await this.loadAllWrongNotes(true);
		const mocFolder = this.rootPath(this.settings.wrongKnowledgeFolder);
		await ensureFolder(this.app, mocFolder);
		const allTagLinks: Record<string, string[]> = {};
		let updated = 0;

		for (const note of notes) {
			const kp = knowledgeTags(note.tags);
			if (kp.length === 0) continue;
			const hasLinks = note.resultText.includes("**知识点：**");
			if (hasLinks) {
				for (const tag of kp) {
					const noteBaseName = note.baseName;
					if (!allTagLinks[tag]) allTagLinks[tag] = [];
					if (!allTagLinks[tag].includes(noteBaseName)) allTagLinks[tag].push(noteBaseName);
				}
				continue;
			}
			const knowledgeLinkText = "\n\n**知识点：** " + kp.map(t => "[[" + t + "]]").join(" ") + "\n";
			if (isAbs(this.rootPath(this.settings.wrongBookFolder))) {
				const content = readFileStr(note.filePath);
				writeFileStr(note.filePath, content + knowledgeLinkText);
			} else {
				const file = this.app.vault.getAbstractFileByPath(note.filePath);
				if (file instanceof TFile) {
					const content = await this.app.vault.read(file);
					await this.app.vault.modify(file, content + knowledgeLinkText);
				}
			}
			for (const tag of kp) {
				const noteBaseName = note.baseName;
				if (!allTagLinks[tag]) allTagLinks[tag] = [];
				if (!allTagLinks[tag].includes(noteBaseName)) allTagLinks[tag].push(noteBaseName);
			}
			updated++;
		}

		for (const [tag, linkNames] of Object.entries(allTagLinks)) {
			const mocPath = mocFolder + "/" + safeName(tag) + ".md";
			const fm = buildFM({ tags: ["知识点", tag], date: todayStr() });
			let body = "# " + tag + "\n\n";
			body += "> 知识点索引（MOC），由智学助手自动维护\n\n";
			body += "## 相关错题\n\n";
			for (const name of linkNames) {
				body += "- [[" + name + "]]\n";
			}
			try {
				if (isAbs(mocFolder)) {
					writeFileStr(mocPath, fm + body);
				} else {
					const existingFile = this.app.vault.getAbstractFileByPath(mocPath);
					if (existingFile instanceof TFile) await this.app.vault.modify(existingFile, fm + body);
					else await this.app.vault.create(mocPath, fm + body);
				}
			} catch { /* empty */ }
		}

		if (updated > 0) new Notice("已为 " + updated + " 条错题补充知识点链接");
		this.invalidateCache();
	}

	async exportToFile(text: string, defaultName: string, format: "md" | "word" | "pdf", title?: string, source?: string) {
		try {
			
			if (format === "md") {
				const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: defaultName + ".md", filters: [{ name: "Markdown", extensions: ["md"] }] });
				if (r.canceled || !r.filePath) return;
				const dateStr = new Date().toISOString().slice(0, 10);
				const mdHeader = title ? "# " + title + "\n\n> 来源：" + (source || title) + "　|　日期：" + dateStr + "\n\n" : "";
				fs.writeFileSync(r.filePath, mdHeader + stripAnswerSummarySection(text), "utf-8");
				new Notice("Md文件已保存");
			} else if (format === "word") {
				const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: defaultName + ".docx", filters: [{ name: "Word", extensions: ["docx"] }] });
				if (r.canceled || !r.filePath) return;
				const children = buildWordParagraphs(text, title, source);
				const doc = new Document({ sections: [{ properties: {}, children }] });
				const buffer = await Packer.toBuffer(doc);
				fs.writeFileSync(r.filePath, Buffer.from(buffer));
				new Notice("Word文件已保存");
			} else if (format === "pdf") {
				const r = await getElectronRemote().dialog.showSaveDialog({ defaultPath: defaultName + ".pdf", filters: [{ name: "PDF", extensions: ["pdf"] }] });
				if (r.canceled || !r.filePath) return;
				await exportPdfDirect(r.filePath, text, title, source);
				new Notice("PDF文件已保存");
			}
		} catch (err) { new Notice("导出失败：" + (err as Error).message); }
	}

	async activateSidebar(): Promise<MainSidebarView | null> {
		const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
		if (leaves.length > 0) {
			await this.app.workspace.revealLeaf(leaves[0]!);
			return leaves[0]!.view as MainSidebarView;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
			return leaf.view as MainSidebarView;
		}
		return null;
	}

	async onload() {
		await this.loadSettings();

		try {
			if (this.settings.rootFolder) await ensureFolder(this.app, this.settings.rootFolder);
			await ensureFolder(this.app, this.rootPath(this.settings.questionFolder));
			await ensureFolder(this.app, this.rootPath(this.settings.wrongBookFolder));
			await ensureFolder(this.app, this.rootPath(this.settings.noteViewFolder));
			await ensureFolder(this.app, this.rootPath(this.settings.extractedExamFolder));
			await ensureFolder(this.app, this.rootPath(this.settings.questionKnowledgeFolder));
			await ensureFolder(this.app, this.rootPath(this.settings.noteKnowledgeFolder));
			await ensureFolder(this.app, this.rootPath(this.settings.wrongKnowledgeFolder));
			await this.migrateOldWrongAnswers();
			await this.migrateKnowledgeLinks();
		} catch (err) {
			console.error("[question-generator] 启动初始化错误:", err);
		}

		this.registerView(SIDEBAR_VIEW_TYPE, (leaf) => new MainSidebarView(leaf, this));
		this.addSettingTab(new QuestionGeneratorSettingTab(this.app, this));

		this.addRibbonIcon("pencil", "智学助手", async () => {
			const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
			if (leaves.length > 0) {
				await this.app.workspace.revealLeaf(leaves[0]!);
			} else {
				const leaf = this.app.workspace.getRightLeaf(false);
				if (leaf) {
					await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
				}
			}
		});

		this.app.workspace.onLayoutReady(async () => {
			const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
			if (leaves.length === 0) {
				const leaf = this.app.workspace.getRightLeaf(false);
				if (leaf) {
					await leaf.setViewState({ type: SIDEBAR_VIEW_TYPE, active: true });
				}
			}
			if (this.settings.autoReviewReminder) {
				try {
					const notes = await this.loadAllWrongNotes();
					const dueCount = notes.filter(n => isDueForReview(n)).length;
					if (dueCount > 0) {
						this.registerInterval(window.setTimeout(() => {
							const notice = new Notice("你有 " + dueCount + " 道错题待复习，点击开始", NOTICE_DURATION_MS);
							notice.messageEl.addEventListener("click", () => {
								void (async () => {
									const view = await this.activateSidebar();
									if (view) { view.activeSection = "wrong"; view.wrongView = "list"; await view.render(); }
								})();
							});
						}, REVIEW_REMINDER_DELAY_MS));
					}
				} catch { /* empty */ }
			}
		});

		this.addCommand({ id: "open-sidebar", name: "打开智学助手侧边栏", callback: async () => {
			await this.activateSidebar();
		}});
		this.addCommand({ id: "view-history", name: "查看题目生成历史记录", callback: async () => {
			const view = await this.activateSidebar();
			if (view) { view.activeSection = "wrong"; view.wrongView = "list"; await view.render(); }
		}});
		this.addCommand({ id: "view-wrong-answers", name: "查看错题本", callback: async () => {
			const view = await this.activateSidebar();
			if (view) { view.activeSection = "wrong"; view.wrongView = "list"; await view.render(); }
		}});
		this.addCommand({ id: "rebuild-knowledge-index", name: "重建知识点索引", callback: async () => { await this.migrateKnowledgeLinks(); new Notice("知识点索引已重建"); } });
		this.addCommand({
			id: "generate-from-current",
			name: "基于当前文档生成试题",
			callback: async () => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") { new Notice("请先打开一个Markdown文档"); return; }
				const text = await this.app.vault.read(file);
				const view = await this.activateSidebar();
				if (view) { view.activeSection = "home"; view.homeView = "generate"; view.genSourceText = text; view.genFileName = file.name; view.genSourcePath = file.path; await view.render(); }
			}
		});

		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			try {
				if (file instanceof TFolder) {
					menu.addItem(item => item.setTitle("选择文件生成题目").onClick(async () => {
						const view = await this.activateSidebar();
						if (view) { view.activeSection = "home"; view.homeView = "filePicker"; await view.render(); }
					}));
				}
				if (file instanceof TFile && file.extension === "md") {
					menu.addItem(item => item.setTitle("基于本文档生成试题").onClick(async () => {
						const text = await this.app.vault.read(file);
						const view = await this.activateSidebar();
						if (view) { view.activeSection = "home"; view.homeView = "generate"; view.genSourceText = text; view.genFileName = file.name; view.genSourcePath = file.path; await view.render(); }
					}));
				}
			} catch (e) {
				console.error("[question-generator] file-menu error:", e);
			}
		}));

		this.registerEvent(this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
			try {
				const selectText = editor.getSelection();
				if (selectText && selectText.trim().length > 0) {
					const fileName = ("file" in info ? info.file?.name : undefined) || "片段";
					const filePath = ("file" in info ? info.file?.path : undefined) || "";
					menu.addItem(item => item.setTitle("基于选中内容生成试题").onClick(async () => {
						let fullText = selectText;
						if (fileName && fileName !== "片段") {
							try {
								const file = this.app.vault.getAbstractFileByPath(filePath);
								if (file instanceof TFile) {
									const fileTitle = file.basename;
									fullText = "文档标题：" + fileTitle + "\n\n" + selectText;
								}
							} catch { /* empty */ }
						}
						const sidebarView = await this.activateSidebar();
						if (sidebarView) { sidebarView.activeSection = "home"; sidebarView.homeView = "generate"; sidebarView.genSourceText = fullText; sidebarView.genFileName = fileName; sidebarView.genSourcePath = filePath; await sidebarView.render(); }
					}));
				}
			} catch (e) {
				console.error("[question-generator] editor-menu error:", e);
			}
		}));

		this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => {
			try {
				if (evt.ctrlKey && evt.key === "q") {
					evt.preventDefault();
					const file = this.app.workspace.getActiveFile();
					if (file && file.extension === "md") {
						this.app.vault.read(file).then(async text => {
							const view = await this.activateSidebar();
							if (view) { view.activeSection = "home"; view.homeView = "generate"; view.genSourceText = text; view.genFileName = file.name; view.genSourcePath = file.path; await view.render(); }
						}).catch(e => console.error("[question-generator]", e));
					} else {
						new Notice("请先打开一个Markdown文档再使用 Ctrl+Q");
					}
				}
				if (evt.ctrlKey && evt.key === "w") {
					evt.preventDefault();
					this.activateSidebar().then(async view => {
						if (view) { view.activeSection = "wrong"; view.wrongView = "list"; await view.render(); }
					}).catch(e => console.error("[question-generator]", e));
				}
			} catch (e) {
				console.error("[question-generator] keydown error:", e);
			}
		});
	}
	onunload() {
		const leaves = this.app.workspace.getLeavesOfType(SIDEBAR_VIEW_TYPE);
		for (const leaf of leaves) { leaf.detach(); }
	}
}

// ===================== 公共导出（保持向后兼容） =====================
export { DEFAULT_SETTINGS, SYSTEM_TAGS, SIDEBAR_VIEW_TYPE } from "./constants";
export { parseFM, buildFM, knowledgeTags, buildKnowledgeLinks } from "./utils/frontmatter";
export { isAbs, daysUntil, ensureFolderAbs, writeFileStr, readFileStr, listMdFiles, deleteFileAbs, ensureFolder } from "./utils/fs-utils";
export { safeName, cleanSourceText, estimateTokens, stripAnswersForExport, htmlEscape } from "./utils/text";
export { DEFAULT_WRONG_INTERVALS, DEFAULT_QUESTION_INTERVALS, DEFAULT_NOTE_INTERVALS, parseReviewIntervals, reviewUpdate, todayStr, isDueForReview } from "./utils/review";
export { stripMd, parseQuestions } from "./utils/parse";
export { extractKnowledgeTags } from "./utils/tags";
export { debounce } from "./utils/debounce";
export { buildFileTree } from "./utils/filetree";
export { stripAnswerSummarySection, splitSemantic, normalizeAnswerSteps, splitAnswerContent, fixSequentialNumbers, normalizeExamContent, highlightTechTerms, highlightTechHtml } from "./utils/layout";
export { buildWordParagraphs, buildExportHtml, exportPdfDirect } from "./utils/exporter";
export { getElectronRemote } from "./utils/electron";
export type { OllamaResponse, OpenAIResponse, FmValue, HistoryEntry, WrongAnswerNote, QuestionType, ParsedQuestion, PluginSettings, TreeNode, SectionKey, HomeViewKey, SortMode, ReviewFilterType, ReviewSource } from "./types";
export { MainSidebarView } from "./views/sidebarView";
export { QuestionGeneratorSettingTab } from "./views/settingTab";
