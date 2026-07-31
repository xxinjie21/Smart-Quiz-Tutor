export function safeName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\.md$/, "");
}

export function cleanSourceText(text: string): string {
	let clean = text;
	clean = clean.replace(/```[\s\S]*?```/g, "[代码块已省略]");
	clean = clean.replace(/`[^`\n]+`/g, "");
	clean = clean.replace(/%%[\s\S]*?%%/g, "");
	clean = clean.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
	clean = clean.replace(/\[\[([^\]]+)\]\]/g, "$1");
	clean = clean.replace(/!\[\[([^\]]+)\]\]/g, "");
	clean = clean.replace(/!\[([^\]]*)\]\([^)]+\)/g, "");
	clean = clean.replace(/^#{1,6}\s+/gm, "");
	clean = clean.replace(/\*\*([^*]+)\*\*/g, "$1");
	clean = clean.replace(/\*([^*]+)\*/g, "$1");
	clean = clean.replace(/~~([^~]+)~~/g, "$1");
	clean = clean.replace(/^[-*+]\s+/gm, "");
	clean = clean.replace(/^\d+\.\s+/gm, "");
	clean = clean.replace(/^>\s*/gm, "");
	clean = clean.replace(/---+/gm, "");
	clean = clean.replace(/\|[^|\n]+\|/g, "");
	clean = clean.replace(/\n{3,}/g, "\n\n");
	return clean.trim();
}

export function estimateTokens(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.codePointAt(i)!;
		if (code > 0xFFFF) i++;
		count += (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) || (code >= 0x20000 && code <= 0x2A6DF) ? 1.5 : 1;
	}
	return Math.ceil(count);
}

export function stripAnswersForExport(text: string): string {
	const lines = text.split("\n");
	const result: string[] = [];
	let skip = false;
	for (const line of lines) {
		if (/^#{1,6}\s+(单选题|多选题|判断题|填空题|简答题)/.test(line.trim())) {
			skip = false;
			result.push(line);
			continue;
		}
		if (/^(答案[汇总：:]|解析[：:])/.test(line.trim())) {
			skip = true;
			continue;
		}
		if (/^\d+[.、）)]/.test(line.trim()) && skip) {
			skip = false;
		}
		if (!skip) result.push(line);
	}
	return result.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function htmlEscape(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
