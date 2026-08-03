import type { FmValue } from "../types";
import { SYSTEM_TAGS } from "../constants";

export function parseFM(content: string): { meta: Record<string, FmValue>; body: string } {
	if (!content.startsWith("---")) return { meta: {}, body: content };
	const end = content.indexOf("---", 3);
	if (end === -1) return { meta: {}, body: content };
	const yaml = content.slice(3, end).trim();
	const body = content.slice(end + 3).trim();
	const meta: Record<string, FmValue> = {};
	const lines = yaml.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		let val = line.slice(idx + 1).trim();
		if (val.startsWith("[") && val.endsWith("]")) {
			meta[key] = val.slice(1, -1).split(",").map(s => s.trim().replace(/^"|"$/g, ""));
		} else if (val === "true") meta[key] = true;
		else if (val === "false") meta[key] = false;
		else if (val === "") {
			const list: string[] = [];
			for (let j = i + 1; j < lines.length; j++) {
				const m = lines[j]!.match(/^\s*-\s*(.+)$/);
				if (!m) break;
				const item = m[1]!.trim().replace(/^"|"$/g, "");
				if (item) list.push(item);
			}
			if (list.length > 0) meta[key] = list;
			else meta[key] = "";
		}
		else {
			const raw = val.replace(/^"|"$/g, "");
			if (key === "interval" || key === "correctCount" || key === "wrongCount") {
				const num = Number(raw);
				meta[key] = isFinite(num) ? num : raw;
			} else {
				meta[key] = raw;
			}
		}
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
