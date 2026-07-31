import type { FmValue } from "../types";
import { SYSTEM_TAGS } from "../constants";

export function parseFM(content: string): { meta: Record<string, FmValue>; body: string } {
	if (!content.startsWith("---")) return { meta: {}, body: content };
	const end = content.indexOf("---", 3);
	if (end === -1) return { meta: {}, body: content };
	const yaml = content.slice(3, end).trim();
	const body = content.slice(end + 3).trim();
	const meta: Record<string, FmValue> = {};
	for (const line of yaml.split("\n")) {
		const i = line.indexOf(":");
		if (i === -1) continue;
		const key = line.slice(0, i).trim();
		let val = line.slice(i + 1).trim();
		if (val.startsWith("[") && val.endsWith("]")) {
			meta[key] = val.slice(1, -1).split(",").map(s => s.trim().replace(/^"|"$/g, ""));
		} else if (val === "true") meta[key] = true;
		else if (val === "false") meta[key] = false;
		else meta[key] = val.replace(/^"|"$/g, "");
	}
	return { meta, body };
}

export function buildFM(data: Record<string, FmValue>): string {
	let y = "---\n";
	for (const [k, v] of Object.entries(data)) {
		if (Array.isArray(v)) y += `${k}: [${v.join(", ")}]\n`;
		else if (typeof v === "boolean") y += `${k}: ${v}\n`;
		else if (typeof v === "number") y += `${k}: ${v}\n`;
		else y += `${k}: "${String(v).replace(/"/g, '\\"')}"\n`;
	}
	return y + "---\n\n";
}

export function knowledgeTags(tags: string[]): string[] {
	return tags.filter(t => !SYSTEM_TAGS.includes(t));
}

export function buildKnowledgeLinks(tags: string[]): string {
	const kp = knowledgeTags(tags);
	if (kp.length === 0) return "";
	return "\n\n**知识点：** " + kp.map(t => "[[" + t + "]]").join(" ") + "\n";
}
