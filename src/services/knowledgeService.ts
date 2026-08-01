import { Notice, TFile, TFolder, type App } from "obsidian";
import type { PluginSettings, WrongAnswerNote } from "../types";
import { parseFM, buildFM, knowledgeTags } from "../utils/frontmatter";
import { isAbs, readFileStr, writeFileStr, listMdFiles, listMdFilesRecursive, ensureFolder } from "../utils/fs-utils";
import { safeName } from "../utils/text";
import { todayStr } from "../utils/review";
import * as fs from "fs";
import * as path from "path";

export interface KnowledgeServiceProvider {
	app: App;
	readonly settings: PluginSettings;
	rootPath(subFolder: string): string;
	loadAllWrongNotes(forceRefresh?: boolean): Promise<WrongAnswerNote[]>;
	invalidateCache(): void;
}

export class KnowledgeService {
	constructor(private p: KnowledgeServiceProvider) {}

	async updateKnowledgePointMOC(tags: string[], noteFileName: string) {
		const kp = knowledgeTags(tags);
		if (kp.length === 0) return;
		const mocFolder = this.p.rootPath(this.p.settings.wrongKnowledgeFolder);
		await ensureFolder(this.p.app, mocFolder);
		for (const tag of kp) {
			const mocPath = mocFolder + "/" + safeName(tag) + ".md";
			const link = "[[" + noteFileName.replace(/\.md$/, "") + "]]";
			let existing = "";
			let existingLinks: string[] = [];
			try {
				if (isAbs(mocFolder)) {
					existing = readFileStr(mocPath);
				} else {
					const f = this.p.app.vault.getAbstractFileByPath(mocPath);
					if (f instanceof TFile) existing = await this.p.app.vault.read(f);
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
					const existingFile = this.p.app.vault.getAbstractFileByPath(mocPath);
					if (existingFile instanceof TFile) await this.p.app.vault.modify(existingFile, fm + body);
					else await this.p.app.vault.create(mocPath, fm + body);
				}
			} catch { /* empty */ }
		}
	}

	async loadExistingKnowledgeTags(): Promise<string[]> {
		const folders = [this.p.rootPath(this.p.settings.questionKnowledgeFolder), this.p.rootPath(this.p.settings.noteKnowledgeFolder), this.p.rootPath(this.p.settings.wrongKnowledgeFolder)];
		const tagSet = new Set<string>();
		for (const folder of folders) {
			if (!folder) continue;
			if (isAbs(folder)) {
				if (!fs.existsSync(folder)) continue;
				for (const f of listMdFiles(folder)) {
					tagSet.add(f.replace(/\.md$/, ""));
				}
			} else {
				const folderFile = this.p.app.vault.getAbstractFileByPath(folder);
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
		const folder = folderOverride || this.p.rootPath(this.p.settings.wrongKnowledgeFolder);
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
			const folderObj = this.p.app.vault.getAbstractFileByPath(folder);
			if (!folderObj || !(folderObj instanceof TFolder)) {
				await this.p.app.vault.createFolder(folder).catch(() => {});
			}
			for (const tag of tags) {
				const fp = folder + "/" + tag + ".md";
				const existingFile = this.p.app.vault.getAbstractFileByPath(fp);
				const existingLinks: string[] = [];
				if (existingFile instanceof TFile) {
					const content = await this.p.app.vault.read(existingFile);
					const linkMatches = content.match(/\[\[([^\]]+)\]\]/g);
					if (linkMatches) existingLinks.push(...linkMatches.map(l => l.replace(/\[\[|\]\]/g, "")));
				}
				const allLinks = [...new Set([...existingLinks, ...links.map(l => l.label)])].sort();
				const body = `---\ntags: [知识点]\n---\n# ${tag}\n\n## 相关题目\n${allLinks.filter(l => l.includes("试题")).map(l => "-[[" + l + "]]").join("\n") || "暂无"}\n\n## 相关错题\n${allLinks.filter(l => !l.includes("试题")).map(l => "-[[" + l + "]]").join("\n") || "暂无"}\n`;
				if (existingFile instanceof TFile) {
					await this.p.app.vault.modify(existingFile, body);
				} else {
					await this.p.app.vault.create(fp, body);
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
		const wrongNotes = await this.p.loadAllWrongNotes();
		for (const n of wrongNotes) {
			for (const t of knowledgeTags(n.tags)) addLink(t, n.baseName, n.filePath);
		}
		const extractTagsFromFile = async (file: TFile, folder: string) => {
			try {
				let content = "";
				if (isAbs(folder)) { content = readFileStr(file.path); } else { content = await this.p.app.vault.read(file); }
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
			const excludes = [this.p.rootPath(this.p.settings.questionKnowledgeFolder), this.p.rootPath(this.p.settings.noteKnowledgeFolder), this.p.rootPath(this.p.settings.wrongKnowledgeFolder)].filter(Boolean);
			if (isAbs(folder)) {
				try {
					if (!fs.existsSync(folder)) return [];
					return listMdFilesRecursive(folder, excludes).map((fp: string) => {
						const stat = fs.statSync(fp);
						return { name: path.basename(fp), path: fp, basename: path.basename(fp).replace(/\.md$/, ""), stat: { mtime: stat.mtimeMs, size: stat.size } } as unknown as TFile;
					});
				} catch { return []; }
			}
			try {
				const prefix = folder.endsWith("/") ? folder : folder + "/";
				const exclPrefixes = excludes.map(p => (p.endsWith("/") ? p : p + "/"));
				return this.p.app.vault.getFiles().filter(f => f.path.startsWith(prefix) && f.extension === "md" && !exclPrefixes.some(e => f.path.startsWith(e)));
			} catch { return []; }
		};
		const qFolder = this.p.rootPath(this.p.settings.questionFolder);
		if (qFolder) {
			for (const f of listMdFiles(qFolder)) await extractTagsFromFile(f, qFolder);
		}
		const nFolder = this.p.rootPath(this.p.settings.noteViewFolder);
		if (nFolder) {
			for (const f of listMdFiles(nFolder)) await extractTagsFromFile(f, nFolder);
		}
		const allTags = Object.keys(tagMap);
		const knowledgeFolders = [this.p.rootPath(this.p.settings.questionKnowledgeFolder), this.p.rootPath(this.p.settings.noteKnowledgeFolder), this.p.rootPath(this.p.settings.wrongKnowledgeFolder)];
		for (const kf of knowledgeFolders) {
			if (!kf) continue;
			if (allTags.length > 0) await this.syncKnowledgeFolder(allTags, [], kf);
			for (const [tag, links] of Object.entries(tagMap)) {
				await this.syncKnowledgeFolder([tag], links, kf);
			}
		}
		for (const kf of knowledgeFolders) {
			if (!kf) continue;
			await this.removeStaleTagFiles(kf, allTags);
		}
	}

	private async removeStaleTagFiles(folder: string, keepTags: string[]) {
		const keep = new Set(keepTags);
		if (isAbs(folder)) {
			try {
				if (!fs.existsSync(folder)) return;
				for (const f of listMdFiles(folder)) {
					if (!keep.has(f.replace(/\.md$/, ""))) fs.unlinkSync(folder + "\\" + f);
				}
			} catch { /* skip */ }
			return;
		}
		const folderObj = this.p.app.vault.getAbstractFileByPath(folder);
		if (!(folderObj instanceof TFolder)) return;
		for (const child of folderObj.children) {
			if (child instanceof TFile && child.extension === "md" && !keep.has(child.basename)) {
				try { await this.p.app.fileManager.trashFile(child); } catch { /* skip */ }
			}
		}
	}

	async getWeakPoints(): Promise<{ tag: string; count: number; questions: WrongAnswerNote[] }[]> {
		const notes = await this.p.loadAllWrongNotes();
		const threshold = this.p.settings.weakPointThreshold || 2;
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
		const notes = await this.p.loadAllWrongNotes(true);
		const mocFolder = this.p.rootPath(this.p.settings.wrongKnowledgeFolder);
		await ensureFolder(this.p.app, mocFolder);
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
			if (isAbs(this.p.rootPath(this.p.settings.wrongBookFolder))) {
				const content = readFileStr(note.filePath);
				writeFileStr(note.filePath, content + knowledgeLinkText);
			} else {
				const file = this.p.app.vault.getAbstractFileByPath(note.filePath);
				if (file instanceof TFile) {
					const content = await this.p.app.vault.read(file);
					await this.p.app.vault.modify(file, content + knowledgeLinkText);
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
					const existingFile = this.p.app.vault.getAbstractFileByPath(mocPath);
					if (existingFile instanceof TFile) await this.p.app.vault.modify(existingFile, fm + body);
					else await this.p.app.vault.create(mocPath, fm + body);
				}
			} catch { /* empty */ }
		}

		if (updated > 0) new Notice("已为 " + updated + " 条错题补充知识点链接");
		this.p.invalidateCache();
	}
}

export function buildTaggingPrompt(content: string, existingTags: string[]): string {
	const existingHint = existingTags.length > 0 ? "\n【已有知识点标签（请优先使用这些标签，也可以新增）】\n" + existingTags.join("、") + "\n" : "";
	return `你是专业的知识管理助手。请从以下文档中提取核心知识点标签。

【任务】
分析文档内容，提取3-8个最能概括文档核心主题的知识点标签。

【标签规范】
1. 必须是具体的知识点名称，不能笼统
   ✓ 二项式定理、光合作用、TCP三次握手、法国大革命、牛顿第二定律
   ✗ 数学、生物、计算机、历史、物理（太笼统，无法定位具体知识）
2. 标签必须来自文档实际内容，不要凭空编造
3. 优先使用已有标签（见下方列表），但可新增文档独有的知识点
4. 每个标签2-8个字，不超过10个字
5. 禁止使用"题目""笔记""错题""考试""试卷""选择题""简答题"等通用词
6. 试卷/题目集 → 标签应反映考查的知识领域（如"概率论"而非"单选题"）
7. 笔记/教材 → 标签应反映核心主题和关键概念

【输出格式】
每行一个标签，不编号，不解释，不输出其他内容。${existingHint}

### 文档内容：
${content.slice(0, 12000)}`;
}

export function parseTaggedResult(full: string): string[] {
	return full.split("\n").map(s => s.replace(/^\d+[.、)\s]+/, "").replace(/^[-*]\s*/, "").trim()).filter(s => s.length >= 2 && s.length <= 15 && !/^(标签|知识点|tag)/i.test(s));
}
