import { cleanSourceText } from "../utils/text";

export function buildExamExtractPrompt(content: string, chunkIndex?: number, totalChunks?: number): string {
	const chunkHint = (chunkIndex && totalChunks && totalChunks > 1) ? "\n【重要】这是第" + chunkIndex + "/" + totalChunks + "段内容，请提取本段中所有题目，不要遗漏。" : "";
	return `你是专业的试卷识别助手。请仔细阅读以下文档内容，精准识别并提取其中所有的考试题目。必须提取所有题目，不要遗漏任何一道题。

【核心原则 - 必须遵守】
1. 尊重原文：试卷上是什么题型，识别出来就是什么题型，不要改变题型
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
答案：答案内容
解析：解析文本

【各类题型输出规则】
- 选择题：必须列出所有选项（A. B. C. D.），答案用字母表示
- 多选题：答案为多个字母，如 答案：ABD
- 判断题：选项为 A. 正确 B. 错误，答案为 A 或 B
- 填空题：题干中用（）标记空缺位置，答案填写具体内容
- 简答题/论述题：答案必须用数字序号（1. 2. 3.）列出要点
- 计算题：保留完整计算过程
- 案例分析：完整保留案例材料和问题
- 如果原文有解析/解释，一并保留；如果没有，由你补充简要解析

【铁律 - 绝对禁止】
1. 绝对不要使用任何Markdown格式（不要用#号、星号、反引号等标记符号）
2. 题号格式固定为：数字. 题干文本
3. 选项格式固定为：A. 选项文本
4. 答案行格式固定为：答案：xxx
5. 解析行格式固定为：解析：xxx
6. 每道题之间必须空一行
7. 不要在文末输出答案汇总
8. 简答题答案必须用数字序号（1. 2. 3.）列出踩分点，每个序号单独一行
9. 答案中多个要点（1. xxx 2. xxx 3. xxx）必须每个要点单独一行
11. 编号必须连续递增：1. 2. 3. 4. 5.，绝对禁止跳号（如 1. 3. 5.）或乱序
10. 在所有题目输出完毕后，最后一行必须输出：知识点：tag1, tag2, tag3（根据内容精准提取3-8个核心知识点，用逗号分隔）

【重要提示】
- 如果文档中包含多套试卷，全部提取出来
- 如果文档不是试卷格式（如笔记、教材等），请从中提炼可能的考点并出题
- 保持题目的完整性和准确性
- 题型分类标题必须准确反映原文题型（如原文是"论述题"就写"论述题"，不要统一改成"简答题"）

### 文档内容：
${content}`;
}

export function buildGeneratePrompt(sourceText: string, typeStr: string, existingTags: string[]): string {
	const cleanSource = cleanSourceText(sourceText);
	const existingTagsHint = existingTags.length > 0 ? "\n【已有的知识点标签（请优先使用这些标签）】\n" + existingTags.join("、") + "\n" : "";
	const noMdRules = "\n\n【铁律 - 绝对禁止】\n1. 绝对不要使用任何Markdown格式\n2. 题号格式固定为：**数字.** 题干文本（注意加粗）\n3. 选项格式固定为：A. 选项文本\n4. 答案行格式固定为：答案：A 或 答案：AB 或 答案：填写内容\n5. 解析行格式固定为：解析：解释文本\n6. 每道题之间必须空一行\n7. 不要在文末输出答案汇总\n8. 简答题答案必须用括号数字序号（(1) (2) (3)）列出踩分点，每个序号单独一行\n9. 答案中多个要点（(1) xxx (2) xxx (3) xxx）必须每个要点单独一行，每道题答案独立从头排序\n10. 在所有题目输出完毕后，最后一行必须输出：知识点：tag1, tag2, tag3（根据已有知识点标签优先匹配，也可新增，3-8个，逗号分隔）\n";
	return `你是专业出题教师，严格依据原文内容出题，禁止编造不存在知识点。

【输出格式要求 - 必须严格遵守】
必须按以下格式输出，否则系统无法解析：

## 单选题
**1.** 题干文本
A. 选项A文本
B. 选项B文本
C. 选项C文本
D. 选项D文本
答案：A
解析：解释文本

## 多选题
**2.** 题干文本
A. 选项A文本
B. 选项B文本
C. 选项C文本
D. 选项D文本
答案：AB
解析：解释文本

## 判断题
**3.** 题干文本
A. 正确
B. 错误
答案：A
解析：解释文本

## 填空题
**4.** 题干文本，其中空缺部分用（）表示
答案：填写的内容
解析：解释文本

## 简答题
**5.** 题干文本
答案：(1) 第一个踩分点内容 (2) 第二个踩分点内容 (3) 第三个踩分点内容
解析：解释文本
${noMdRules}
${existingTagsHint}
### 参考原文：
${cleanSource}

题目数量：${typeStr}
规则：无对应知识点直接跳过，不要虚构内容。
		【简答题答案格式要求】
		简答题答案必须使用括号数字序号（(1) (2) (3)）列出踩分点，禁止使用"第一步""第二步"等文字描述。每道题的答案序号独立从头编号。
【知识点提取】
在所有题目输出完毕后，最后一行必须输出：
知识点：根据已有知识点标签优先匹配，也可新增（3-8个，逗号分隔）`;
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
