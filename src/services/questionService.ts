import { cleanSourceText } from "../utils/text";

export function buildExamExtractPrompt(content: string, chunkIndex?: number, totalChunks?: number): string {
	const chunkHint = (chunkIndex && totalChunks && totalChunks > 1) ? "\n【重要】这是第" + chunkIndex + "/" + totalChunks + "段内容，请提取本段中所有题目，不要遗漏。" : "";
	return `你是专业的试卷识别助手。请仔细阅读以下文档内容，精准识别并提取其中所有的考试题目。必须提取所有题目，不要遗漏任何一道题。

【核心原则 - 必须遵守】
1. 尊重原文：试卷上是什么题型，识别出来就是什么题型，不要改变题型、不要新增题型、不要删减题型；原卷有什么题就提取什么题，绝对不要按数量限制抽取，也不要为了凑数量而重复或改写题目
2. 答案优先级：试卷上给了答案的，必须按试卷原样保留；试卷上没给答案的，由你根据题目内容生成规范的参考答案
3. 题目完整性：完整保留题干、选项、分值等信息，不要删减
4. 如果文档中有分值标注（如"每题2分"），保留该信息
5. 全量提取：必须提取文档中出现的每一道题，不要只提取部分题目${chunkHint}

【输出格式要求 - 必须严格遵守】
必须按以下格式输出，否则系统无法解析：

## 题型名称（如：单选题/多选题/判断题/填空题/简答题/论述题/计算题/名词解释/案例分析 等）
1. 题干文本
A. 选项A文本
B. 选项B文本
C. 选项C文本
D. 选项D文本

答案：A
解析：概述一句话
(1) 解析要点1
(2) 解析要点2

2. 下一道题题干文本
...

【各类题型输出规则】
- 选择题：必须列出所有选项（A. B. C. D.），答案用字母表示，单行（答案：A 或 答案：ABD）
- 多选题：答案为多个字母，如 答案：ABD
- 判断题：选项为 A. 正确 B. 错误，答案为 A 或 B，单行
- 填空题：题干中用（）或____标记空缺位置，答案填写具体内容，单行（答案：Python智能体）
- 简答题/论述题：答案必须用括号数字序号（(1) (2) (3)）列出要点，禁止用 1. 2. 3. 这类与题号相同的序号；要点较多或分阶段时，用「#### 阶段名称」分组小标题（如「#### 离线建库阶段」「#### 在线问答阶段」），每组要点序号独立从头排列；补充说明用「> 补充说明：xxx」单独一行标注，不编入序号；每道简答题必须是独立一道题、拥有独立题号，绝对禁止把两道题粘连在同一题号下
- 计算题：保留完整计算过程
- 案例分析：完整保留案例材料和问题
- 如果原文有解析/解释，一并保留；如果没有，由你补充简要解析
- 解析如果较长，按逻辑要点用 (1) (2) (3) 拆成多行（每行一个要点），禁止用 2. 3. 4. 这类阿拉伯数字顺延，避免与题号冲突

【铁律 - 绝对禁止】
1. 绝对不要使用任何Markdown装饰符号（#号、星号、反引号等）。唯一例外：答案内分组小标题必须用「#### 分组标题」，补充说明必须用「> 补充说明：xxx」块引用，这两类属于结构标记必须使用
2. 题号格式固定为：数字. 题干文本
3. 选项格式固定为：A. 选项文本
4. 答案行格式固定为：答案：xxx（单选/多选/判断/填空等短答案单行：答案：A、答案：AB、答案：Python智能体；简答/论述等多要点答案：答案： 单独一行，后续 (1)(2)(3) 每行一个要点）
5. 解析行格式固定为：解析：xxx；解析分点用 (1)(2)(3)，禁止用 2. 3. 4. 这类与题号冲突的阿拉伯数字顺延
6. 每道题之间必须空一行
7. 不要在文末输出答案汇总
8. 简答题答案必须用括号数字序号（(1) (2) (3)）列出踩分点，每个序号单独一行，禁止用 1. 2. 3. 这类与题号相同的序号
9. 答案中多个要点（(1) xxx (2) xxx (3) xxx）必须每个要点单独一行，每道题答案独立从头排序
10. 题号与题型严格对应原文：同一个题型标题下的题号连续递增（1. 2. 3. ...），绝对禁止跳号（如 1. 3. 5.）或乱序，也禁止把不同题型的题号混在一起排
11. 每道简答题必须是独立一道题、拥有独立题号，绝对禁止把两道简答题粘连在同一题号下
12. 答案每个要点必须紧跟有效内容，禁止输出空序号占位（如 (1)() 或 (1)（ ））
13. 全文使用书面、正式语体，剔除口语化表述（如"这样排障会简单很多"），答案与解析采用教材式书面风格
14. 在所有题目输出完毕后，最后一行必须输出：知识点：tag1, tag2, tag3（根据内容精准提取3-8个核心知识点，用逗号分隔）

【重要提示】
- 如果文档中包含多套试卷，全部提取出来
- 如果文档不是试卷格式（如笔记、教材等），请从中提炼可能的考点并出题
- 保持题目的完整性和准确性
- 题型分类标题必须准确反映原文题型（如原文是"论述题"就写"论述题"，不要统一改成"简答题"）

### 文档内容：
${content}`;
}

export function parseTypeSpec(typeStr: string): { type: string; count: number }[] {
	const out: { type: string; count: number }[] = [];
	for (const piece of typeStr.split(/[、,，;；]/).map((s) => s.trim()).filter(Boolean)) {
		const m = piece.match(/^(.+?)(\d+)$/);
		if (m && m[1]) {
			const type = m[1]!.trim();
			const count = parseInt(m[2]!, 10);
			if (type && count > 0) out.push({ type, count });
		}
	}
	return out;
}

export function buildGeneratePrompt(sourceText: string, typeStr: string, existingTags: string[]): string {
	const cleanSource = cleanSourceText(sourceText);
	const existingTagsHint = existingTags.length > 0 ? "\n【已有的知识点标签（请优先使用这些标签）】\n" + existingTags.join("、") + "\n" : "";
	const spec = parseTypeSpec(typeStr);
	let typeRules = "";
	if (spec.length > 0) {
		typeRules = "\n\n【出题规格 - 必须精确保留，缺失即扣分】\n只允许出下面列出的题型与数量，未列出的题型一律禁止出现：\n";
		for (const { type, count } of spec) {
			typeRules += "- " + type + "：" + count + " 道\n";
		}
		typeRules += "上述每种题型的题数必须不多不少、精确一致，少出或多出都算任务失败。";
	}
	const noMdRules = "\n\n【铁律 - 绝对禁止】\n1. 绝对不要使用任何Markdown装饰符号（#号、星号、反引号等）。唯一例外：答案内要点分组用 #### 分组标题、补充说明用 > 补充说明：xxx 块引用\n2. 题号格式固定为：**数字.** 题干文本（注意加粗）\n3. 选项格式固定为：A. 选项文本\n4. 答案行格式固定为：答案：A 或 答案：AB 或 答案：填写内容（短答案单行）；简答题答案：答案： 单独一行 + (1)(2)(3) 每行一个要点\n5. 解析行格式固定为：解析：解释文本；解析分点用 (1)(2)(3)，禁止阿拉伯数字顺延\n6. 每道题之间必须空一行\n7. 不要在文末输出答案汇总\n8. 简答题答案必须用括号数字序号（(1) (2) (3)）列出踩分点，每个序号单独一行；要点多或分阶段时用 #### 分组小标题并每组独立从头编号；补充说明用 > 补充说明：xxx 单独标注；禁止输出空序号占位\n9. 答案中多个要点（(1) xxx (2) xxx (3) xxx）必须每个要点单独一行，每道题答案独立从头排序\n10. 解析较长时按逻辑要点用 (1)(2)(3) 拆成多行\n11. 每道简答题独立题号，绝对禁止粘连\n12. 全文使用书面、正式语体，剔除口语化表述\n13. 在所有题目输出完毕后，最后一行必须输出：知识点：tag1, tag2, tag3（根据已有知识点标签优先匹配，也可新增，3-8个，逗号分隔）\n";
	return `你是专业出题教师，严格依据原文内容出题，禁止编造不存在知识点。

【输出格式要求 - 必须严格遵守】
必须用 ## 题型名称 作为大类标题，标题下逐题编号。仅输出本次要求出现的题型，其余题型一律不出现。

【各类题型通用格式规范】
- 单选题 / 多选题：题干 + A. B. C. D. 四个选项，答案用字母；单选答案：A，多选答案：AB（多选答案写全部正确字母）
- 判断题：选项 A. 正确 B. 错误，答案为 A 或 B，单行
- 填空题：题干中用（ ）或____标记空缺，答案：填写具体内容，单行
- 简答题 / 论述题 / 名词解释 / 计算题 / 案例分析题：多要点答案，格式为「答案：」单独一行，随后 (1)(2)(3) 每行一个要点，踩分点明确，禁止"第一步/第二步"等文字描述
- 其他题型：按其对应规则输出

【题型与数量的精确保留】
严格遵循下方【出题规格】给出本次要出（且只出）的题型及其数量。
${typeRules || "\n\n（未提供明确的题型数量规格，请围绕原文核心内容出 5 道左右不同题型的题目，不要编造知识点。）"}
${noMdRules}
${existingTagsHint}
### 参考原文：
${cleanSource}

题目数量：${typeStr}
规则：无对应知识点直接跳过，不要虚构内容。
【知识点提取】
在所有题目输出完毕后，最后一行必须输出：
知识点：根据已有知识点标签优先匹配，也可新增（3-8个，逗号分隔）`;
}

const EXAM_NUM_LINE = /^(?:\*\*)?\d+(?:\*\*)?[.、）)]\s*/;
const EXAM_SECTION_HEADING = /^#{1,6}\s+(.+)/;
const EXAM_KNOWLEDGE_LINE = /^知识点[：:]\s*.*/;
const EXAM_EMPTY_ANSWER_LINE = /^(?:标准)?(?:答案|参考答案)[：:]\s*$/;

function repairBrokenNumberLines(text: string): string {
	return text
		.replace(/([A-Za-z0-9])\n(\d+)\n(?=\d+[、，。)）])/g, "$1$2")
		.replace(/([A-Za-z0-9])\n(?=\d+[、，。)）])/g, "$1");
}

function splitExamBlocks(lines: string[]): string[][] {
	const blocks: string[][] = [];
	let cur: string[] | null = null;
	let inAnswer = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const isNum = EXAM_NUM_LINE.test(trimmed);
		if (isNum && !inAnswer) {
			cur = [trimmed];
			blocks.push(cur);
			continue;
		}
		if (!cur) continue;
		cur.push(trimmed);
		if (/^解析[：:]/.test(trimmed)) inAnswer = false;
		else if (EXAM_EMPTY_ANSWER_LINE.test(trimmed)) inAnswer = true;
	}
	return blocks;
}

function dedupeExamBlocks(blocks: string[][]): string[][] {
	const seen = new Set<string>();
	const result: string[][] = [];
	for (const b of blocks) {
		const key = b.map(l => l.replace(EXAM_NUM_LINE, "")).join("\n").trim();
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(b);
	}
	return result;
}

export function mergeExamChunks(text: string): string {
	const lines = repairBrokenNumberLines(text).split("\n");

	const sections: { name: string; lines: string[] }[] = [];
	const knowledgeLines: string[] = [];
	let cur: { name: string; lines: string[] } | null = null;
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		const heading = line.match(EXAM_SECTION_HEADING);
		if (heading) {
			cur = { name: heading[1]!.trim(), lines: [] };
			sections.push(cur);
			continue;
		}
		if (EXAM_KNOWLEDGE_LINE.test(line)) {
			knowledgeLines.push(line);
			continue;
		}
		if (cur) cur.lines.push(line);
	}

	const merged: { name: string; lines: string[] }[] = [];
	for (const sec of sections) {
		const existing = merged.find(m => m.name === sec.name);
		if (existing) existing.lines.push(...sec.lines);
		else merged.push({ name: sec.name, lines: [...sec.lines] });
	}

	const out: string[] = [];
	for (const sec of merged) {
		const blocks = dedupeExamBlocks(splitExamBlocks(sec.lines));
		if (blocks.length === 0) continue;
		out.push("## " + sec.name);
		blocks.forEach((b, i) => {
			out.push(b[0]!.replace(EXAM_NUM_LINE, (i + 1) + ". "));
			for (let j = 1; j < b.length; j++) out.push(b[j]!);
			out.push("");
		});
	}

	let result = out.join("\n").trim();
	if (knowledgeLines.length > 0) result += "\n\n" + knowledgeLines[knowledgeLines.length - 1];
	return result;
}

export function parseAITagsFromResult(text: string): { tags: string[]; cleanText: string } {
	const lines = text.split("\n");
	const lastLines = lines.slice(-5);
	for (let i = lastLines.length - 1; i >= 0; i--) {
		const line = lastLines[i]!.trim();
		const match = line.match(/^知识点[：:]\s*(.+)/);
		if (match) {
			const tags = match[1]!.split(/[,，]/).map(s => s.trim()).filter(Boolean);
			const cleanLines = lines.slice(0, lines.length - lastLines.length + i);
			return { tags, cleanText: cleanLines.join("\n").trim() };
		}
	}
	return { tags: [], cleanText: text };
}

export function buildExamFrontmatter(sourceName: string, tags: string[]): string {
	const now = new Date();
	const dateStr = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
	const timeStr = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
	return "---\ntitle: \"" + sourceName + " - AI识别试卷\"\ndate: " + dateStr + "T" + timeStr + "\ntags:\n  - 试卷\n  - AI识别" + (tags.length > 0 ? "\n" + tags.map(t => "  - " + t).join("\n") : "") + "\nsourceType: ai-extracted\nsource: \"" + sourceName + "\"\n---\n\n";
}
