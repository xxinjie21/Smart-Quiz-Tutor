import { Notice, TFile, TFolder, type App } from "obsidian";
import type { PluginSettings, WrongAnswerNote } from "../types";
import { knowledgeTags } from "../utils/frontmatter";
import { isAbs, readFileStr, writeFileStr, listMdFiles, listMdFilesRecursive, ensureFolder, joinPath } from "../utils/fs-utils";
import * as fs from "fs";
import * as path from "path";

export interface KnowledgeServiceProvider {
	app: App;
	readonly settings: PluginSettings;
	rootPath(subFolder: string): string;
	loadAllWrongNotes(forceRefresh?: boolean): Promise<WrongAnswerNote[]>;
	invalidateCache(): void;
}

export type IndexSource = "题目" | "笔记" | "错题";

export function parseIndexSections(content: string): Record<IndexSource, string[]> {
	const sections: Record<IndexSource, string[]> = { 题目: [], 笔记: [], 错题: [] };
	let current: IndexSource | null = null;
	for (const line of content.split("\n")) {
		const h = line.trim();
		if (h === "## 相关题目") { current = "题目"; continue; }
		if (h === "## 相关笔记") { current = "笔记"; continue; }
		if (h === "## 相关错题") { current = "错题"; continue; }
		if (current) {
			const m = line.match(/\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/);
			if (m) { const l = m[1]!.trim(); if (l && !sections[current].includes(l)) sections[current].push(l); }
		}
	}
	return sections;
}

export function isKnowledgeIndexContent(content: string): boolean {
	return /^---\n\s*tags:\s*\[知识点\]\s*\n/.test(content);
}

export function buildIndexBody(tag: string, sections: Record<IndexSource, string[]>): string {
	const sectionLines = (src: IndexSource) => {
		const arr = [...new Set(sections[src])].sort();
		return arr.length > 0 ? arr.map(l => "- [[" + l + "]]").join("\n") : "暂无";
	};
	return `---\ntags: [知识点]\n---\n# ${tag}\n\n## 相关题目\n${sectionLines("题目")}\n\n## 相关笔记\n${sectionLines("笔记")}\n\n## 相关错题\n${sectionLines("错题")}\n`;
}

export class KnowledgeService {
	constructor(private p: KnowledgeServiceProvider) {}

	async loadExistingKnowledgeTags(): Promise<string[]> {
		const folder = this.p.rootPath(this.p.settings.knowledgeFolder);
		const tagSet = new Set<string>();
		if (!folder) return [];
		if (isAbs(folder)) {
			if (!fs.existsSync(folder)) return [];
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
		return [...tagSet];
	}

	async syncKnowledgeFolder(tags: string[], links: { label: string; path: string }[], source: IndexSource = "错题", folderOverride?: string) {
		const folder = folderOverride || this.p.rootPath(this.p.settings.knowledgeFolder);
		if (!folder) return;
		for (const tag of tags) {
			const fp = joinPath(folder, tag + ".md");
			const existing = await this.readFileSmart(fp, folder);
			const sections = parseIndexSections(existing);
			for (const l of links) {
				const name = l.label;
				if (name && !sections[source].includes(name)) sections[source].push(name);
			}
			await this.writeFileSmart(fp, folder, buildIndexBody(tag, sections));
		}
	}

	private async readFileSmart(filePath: string, folder: string): Promise<string> {
		if (isAbs(folder)) {
			try { return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : ""; } catch { return ""; }
		}
		const f = this.p.app.vault.getAbstractFileByPath(filePath);
		if (f instanceof TFile) { try { return await this.p.app.vault.read(f); } catch { return ""; } }
		return "";
	}

	private async writeFileSmart(filePath: string, folder: string, content: string): Promise<void> {
		if (isAbs(folder)) {
			if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
			fs.writeFileSync(filePath, content, "utf-8");
		} else {
			const existing = this.p.app.vault.getAbstractFileByPath(filePath);
			if (existing instanceof TFile) await this.p.app.vault.modify(existing, content);
			else await this.p.app.vault.create(filePath, content);
		}
	}

	async rebuildKnowledgeIndex() {
		const tagMap: Record<string, Record<IndexSource, { label: string; path: string }[]>> = {};
		const addLink = (tag: string, src: IndexSource, label: string, p: string) => {
			const arr = (tagMap[tag] || (tagMap[tag] = { 题目: [], 笔记: [], 错题: [] }))[src];
			if (!arr.some(l => l.label === label)) arr.push({ label, path: p });
		};
		const wrongNotes = await this.p.loadAllWrongNotes();
		for (const n of wrongNotes) {
			for (const t of knowledgeTags(n.tags)) addLink(t, "错题", n.baseName, n.filePath);
		}
		const extractTagsFromFile = async (file: TFile, folder: string, src: IndexSource) => {
			try {
				let content = "";
				if (isAbs(folder)) { content = readFileStr(file.path); } else { content = await this.p.app.vault.read(file); }
				const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
				if (fmMatch) {
					const tags = extractTagsFromFrontmatter(fmMatch[1]!);
					for (const t of knowledgeTags(tags)) addLink(t, src, file.basename, file.path);
				}
			} catch { /* skip */ }
		};
		const listMdFiles = (folder: string): TFile[] => {
			const excludes = [this.p.rootPath(this.p.settings.knowledgeFolder)].filter(Boolean);
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
			for (const f of listMdFiles(qFolder)) await extractTagsFromFile(f, qFolder, "题目");
		}
		const nFolder = this.p.rootPath(this.p.settings.noteViewFolder);
		if (nFolder) {
			for (const f of listMdFiles(nFolder)) await extractTagsFromFile(f, nFolder, "笔记");
		}
		const kf = this.p.rootPath(this.p.settings.knowledgeFolder);
		if (kf) {
			for (const [tag, srcMap] of Object.entries(tagMap)) {
				const sections: Record<IndexSource, string[]> = { 题目: [], 笔记: [], 错题: [] };
				for (const [src, links] of Object.entries(srcMap)) {
					sections[src as IndexSource] = links.map(l => l.label);
				}
				try {
					await this.writeFileSmart(joinPath(kf, tag + ".md"), kf, buildIndexBody(tag, sections));
				} catch { /* 单个标签索引写入失败不应中断整个重建 */ }
			}
			await this.removeStaleTagFiles(kf, Object.keys(tagMap));
		}
	}

	private async removeStaleTagFiles(folder: string, keepTags: string[]) {
		const keep = new Set(keepTags);
		if (isAbs(folder)) {
			try {
				if (!fs.existsSync(folder)) return;
				for (const f of listMdFiles(folder)) {
					if (keep.has(f.replace(/\.md$/, ""))) continue;
					let content = "";
					try { content = readFileStr(joinPath(folder, f)); } catch { /* skip */ }
					if (isKnowledgeIndexContent(content)) fs.unlinkSync(joinPath(folder, f));
				}
			} catch { /* skip */ }
			return;
		}
		const folderObj = this.p.app.vault.getAbstractFileByPath(folder);
		if (!(folderObj instanceof TFolder)) return;
		for (const child of [...folderObj.children]) {
			if (!(child instanceof TFile) || child.extension !== "md" || keep.has(child.basename)) continue;
			try {
				const content = await this.p.app.vault.read(child);
				if (isKnowledgeIndexContent(content)) await this.p.app.fileManager.trashFile(child);
			} catch { /* skip */ }
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
		const mocFolder = this.p.rootPath(this.p.settings.knowledgeFolder);
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
			await this.syncKnowledgeFolder([tag], linkNames.map(name => ({ label: name, path: mocFolder })), "错题", mocFolder);
		}

		if (updated > 0) new Notice("已为 " + updated + " 条错题补充知识点链接");
		this.p.invalidateCache();
	}
}

function extractTagsFromFrontmatter(yaml: string): string[] {
	const tags: string[] = [];
	for (const line of yaml.split("\n")) {
		const i = line.indexOf(":");
		if (i === -1) continue;
		const key = line.slice(0, i).trim();
		if (key.toLowerCase() !== "tags") continue;
		const rest = line.slice(i + 1).trim();
		if (rest.startsWith("[")) {
			const close = rest.indexOf("]");
			const inner = close === -1 ? rest.slice(1) : rest.slice(1, close);
			tags.push(...inner.split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
		} else if (rest) {
			tags.push(...rest.split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
		}
	}
	if (tags.length === 0) {
		// 块列表形式：tags:\n  - 试卷\n  - AI识别
		const lines = yaml.split("\n");
		for (let k = 0; k < lines.length; k++) {
			if (lines[k]!.trim().toLowerCase() === "tags" || lines[k]!.trim().toLowerCase() === "tags:") {
				for (let j = k + 1; j < lines.length; j++) {
					const m = lines[j]!.match(/^\s*-\s*(.+)$/);
					if (!m) break;
					const t = m[1]!.trim().replace(/^["']|["']$/g, "");
					if (t) tags.push(t);
				}
				break;
			}
		}
	}
	return [...new Set(tags)];
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
