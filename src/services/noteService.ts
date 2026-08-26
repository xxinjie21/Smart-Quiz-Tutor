import { buildFM } from "../utils/frontmatter";
import type { FmValue } from "../types";
import { DEFAULT_NOTE_INTERVALS } from "../utils/review";
import { getLanguage } from "../i18n/index";

export type NoteGenSourceType = "current" | "doc" | "question" | "wrong" | "note";

export function buildNotePrompt(sourceText: string, sourceName: string): string {
	if (getLanguage() === "en") {
		return [
			"You are a senior knowledge-condensing assistant. Based on the provided material, generate a review note that preserves the original structure and condenses the body text to its essence.",
			"",
			"Rules (strictly follow):",
			"1. Copy all headings, subheadings, numbering and chapter structure exactly from the source, word for word.",
			"2. Only condense the body paragraphs under each heading: remove fluff, keep the skeleton, extract the core, compress sentences.",
			"3. Keep: key definitions, core conditions, key features, causal logic, exam-critical information.",
			"4. Remove: modifiers, repeated sentences, filler phrasing, redundant examples, transition sentences.",
			"5. Condensing standard: fluent, logically complete, short yet comprehensive, no loss of knowledge points.",
			"",
			"Output format:",
			"- 【Original level-1 heading: copied exactly】（condensed essence of paragraph）",
			"- 【Original level-2 heading: copied exactly】（condensed essence of paragraph）",
			"- 【Original level-3/other heading: copied exactly】（condensed essence of paragraph: distill core content item by item, simplify long sentences, keep key elements, rules, features, conclusions）",
			"",
			"Condensing standard:",
			"- Turn long sentences into short ones; merge multiple sentences into one core summary;",
			"- Remove all adjectives, modifiers, and filler sentences;",
			"- Keep all technical terms, core concepts, and qualifying conditions;",
			"- Do not change the logic, order, or number of knowledge points;",
			"- Only compress text; never drop exam points or add content.",
			"",
			"Output requirements:",
			"1. Use Markdown headings to restore the source chapter structure; condense the body per the rules above.",
			"2. Use the same language as the material (Chinese material → Chinese note).",
			"3. After the body, output a knowledge-tag line on its own, strictly formatted as: Tags: tag1, tag2, tag3 (3-6 short tags).",
			"4. Output nothing but the note content; no explanations, prefaces, or postscripts.",
			"",
			"Material source: " + sourceName,
			"---",
			"Material content:",
			sourceText,
		].join("\n");
	}
	return [
		"你是资深的学科知识浓缩助手。请根据提供的材料，生成一份「保留原文结构、正文精华缩写」的复习笔记。",
		"",
		"使用规则（严格遵守）：",
		"1. 所有标题、小标题、序号、章节结构完全照搬原文，一字不改。",
		"2. 仅对每个标题下的段落正文进行缩写：去废话、留主干、提炼核心、压缩语句。",
		"3. 保留：关键定义、核心条件、重点特征、因果逻辑、必考信息。",
		"4. 删除：修饰词、重复语句、铺垫话术、举例废话、过渡语句。",
		"5. 缩写要求：语句通顺、逻辑完整，短而全，不丢知识点。",
		"",
		"通用套用格式（固定模板）：",
		"- 【原文一级标题：完全照搬】（原文段落精华缩写）",
		"- 【原文二级标题：完全照搬】（原文段落精华缩写）",
		"- 【原文三级标题/小标题：完全照搬】（原文段落精华缩写：逐条浓缩核心内容，简化长句，保留关键要素、规则、特点、结论）",
		"",
		"实操示例：",
		"原文：",
		"第一章 计算机基础概述",
		"计算机是一种能够按照事先存储的程序，自动、高速地进行大量数值计算和各种信息处理的现代化智能电子设备，广泛应用于生活、工作、科研等各个领域。",
		"缩写后：",
		"第一章 计算机基础概述",
		"计算机是可按照预设程序，自动、高速完成数值计算与信息处理的智能电子设备，应用场景广泛。",
		"",
		"缩写标准：",
		"- 长句变短句，多句合并为一句核心总结；",
		"- 形容词、修饰语、铺垫句全部删除；",
		"- 专业名词、核心概念、限定条件全部保留；",
		"- 不改变原文逻辑、顺序、知识点数量；",
		"- 只精简文字，不删减考点、不新增内容。",
		"",
		"输出要求：",
		"1. 使用 Markdown 标题还原原文章节结构，正文按上述规则缩写。",
		"2. 语言与材料一致（中文材料用中文）。",
		"3. 正文结束后单独一行输出知识点标签，格式严格为：Tags: 标签1, 标签2, 标签3（3-6 个简短标签）。",
		"4. 除笔记内容外，不要输出任何解释、前言或后记。",
		"",
		"材料来源：" + sourceName,
		"---",
		"材料内容：",
		sourceText,
	].join("\n");
}

export function parseNoteResult(text: string): { tags: string[]; body: string } {
	let tags: string[] = [];
	const lines = (text || "").split("\n");
	const tagLine = lines.find(l => /^\s*(Tags?|标签)\s*[:：]/i.test(l.trim()));
	if (tagLine) {
		tags = tagLine
			.replace(/^\s*(Tags?|标签)\s*[:：]\s*/i, "")
			.split(/[,，、;；]/)
			.map(s => s.trim().replace(/^#+/, ""))
			.filter(Boolean);
		lines.splice(lines.indexOf(tagLine), 1);
	}
	let body = lines.join("\n").trim();
	body = body.replace(/^\s*```[a-zA-Z0-9]*\s*\n?/, "").replace(/\n?\s*```\s*$/, "");
	return { tags, body: body.trim() };
}

export function buildNoteFrontmatter(sourceName: string, sourcePath: string, tags: string[], extra?: Record<string, FmValue>, noteIntervals?: number[]): string {
	const ivls = noteIntervals && noteIntervals.length > 0 ? noteIntervals : DEFAULT_NOTE_INTERVALS;
	const next = new Date();
	next.setDate(next.getDate() + (ivls[0] || DEFAULT_NOTE_INTERVALS[0]!));
	return buildFM({
		date: new Date().toISOString().slice(0, 10),
		source: sourceName ? "[[" + sourceName.replace(/\[\[|\]\]/g, "") + "]]" : "",
		sourcePath,
		tags,
		nextReview: next.toISOString().slice(0, 10),
		interval: ivls[0] || DEFAULT_NOTE_INTERVALS[0]!,
		correctCount: 0,
		wrongCount: 0,
		...extra,
	});
}
