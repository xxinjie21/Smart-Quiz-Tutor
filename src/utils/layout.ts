import { TextRun, UnderlineType } from "docx";

export function stripAnswerSummarySection(text: string): string {
	return text.replace(/\n*#{0,3}\s*答案汇总\s*\n[\s\S]*$/, "").trim();
}

export const FONT = "Microsoft YaHei";
export const FSBody = 22;
export const FSSmall = 20;
export const AnswerColor = "2E7D32";
export const ExplainColor = "1565C0";

export const TECH_TERMS = /\b(GPT|API|REST|HTTP|HTTPS|JSON|XML|SQL|CSS|HTML|JavaScript|TypeScript|Python|Java|React|Vue|Angular|Node\.js|Docker|Kubernetes|Git|Linux|Windows|macOS|SDK|IDE|CLI|JWT|OAuth|TCP|UDP|IP|DNS|URL|URI|SSH|FTP|SMTP|WebSocket|GraphQL|gRPC|MQTT|NoSQL|ORM|CRUD|MVC|MVP|MVVM|CI\/CD|DevOps|SaaS|PaaS|IaaS|FaaS|AWS|Azure|GCP|LLM|NLP|AI|ML|DL|CNN|RNN|LSTM|BERT|Transformer|CUDA|GPU|CPU|RAM|ROM|SSD|HDD|LAN|WAN|VPN|CDN|CORS|XSS|CSRF|SQL注入|JWT|RBAC|ABAC|HAL|HATEOAS|WebSocket|Server-Sent Events|Event Loop|Callback|Promise|Async\/Await|Closure|Prototype|Decorator|Middleware|Plugin|Hook|State|Props|Virtual DOM|DOM|BOM|SPA|SSR|SSG|ISR|CSR|PWA|MVC|ORM|DI|IoC|AOP|TDD|BDD|DDD)\b/gi;

export function splitSemantic(text: string): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	if (trimmed.length <= 60) return [trimmed];
	const parts: string[] = [];
	const sentences: string[] = [];
	for (const part of trimmed.split(/([。！？；])\s*/)) {
		if (!part.trim()) continue;
		if (/[。！？；]/.test(part)) {
			if (sentences.length > 0) sentences[sentences.length - 1] += part;
		} else {
			sentences.push(part);
		}
	}
	for (const s of sentences) {
		const st = s.trim();
		if (!st) continue;
		if (st.length <= 60) {
			parts.push(st);
		} else {
			const subParts: string[] = [];
			for (const part of st.split(/([，、])\s*/)) {
				if (!part.trim()) continue;
				if (/[，、]/.test(part)) {
					if (subParts.length > 0) subParts[subParts.length - 1] += part;
				} else {
					subParts.push(part);
				}
			}
			let buf = "";
			for (const sp of subParts) {
				const spTrimmed = sp.trim();
				if (!spTrimmed) continue;
				if (buf.length + spTrimmed.length > 55 && buf) {
					parts.push(buf.trim());
					buf = "";
				}
				buf += spTrimmed;
			}
			if (buf.trim()) parts.push(buf.trim());
		}
	}
	if (parts.length <= 1 && trimmed.length > 60) {
		const numSplit = trimmed.split(POINT_SPLIT);
		if (numSplit.length > 1) {
			return numSplit.map(s => s.trim()).filter(Boolean);
		}
	}
	return parts.length > 0 ? parts : [trimmed];
}

const STEP_TEXT_MAP: Record<string, number> = { "第一": 1, "第二": 2, "第三": 3, "第四": 4, "第五": 5, "第六": 6, "第七": 7, "第八": 8, "第九": 9, "第十": 10, "十一": 11, "十二": 12, "十三": 13, "十四": 14, "十五": 15, "十六": 16, "十七": 17, "十八": 18, "十九": 19, "二十": 20 };

const POINT_SPLIT = /(?<!\()(?=\d+\.(?!\d)|\d+[、）)])|(?=\(\d+[、.）)])/;

export function normalizeAnswerSteps(text: string): string {
	return text.replace(/(第[一二三四五六七八九十]+)[步点个方面]([：:：]?)\s*/g, (_m, step: string, colon: string) => {
		const num = STEP_TEXT_MAP[step];
		if (!num) return _m;
		return num + ". ";
	});
}

function splitAnswerPoints(raw: string): string[] {
	const trimmed = raw.trim();
	if (!trimmed) return [];
	const parts = trimmed.split(POINT_SPLIT);
	const result: string[] = [];
	for (const part of parts) {
		const p = part.trim();
		if (p) result.push(p);
	}
	return result.length > 0 ? result : [trimmed];
}

export function splitAnswerContent(raw: string): string[] {
	const trimmed = normalizeAnswerSteps(raw.trim());
	if (!trimmed) return [];
	if (/\d+[.、）)]/.test(trimmed)) {
		const points = splitAnswerPoints(trimmed);
		if (points.length > 1) return points;
	}
	const lines = trimmed.split("\n").map(l => l.trim()).filter(Boolean);
	if (lines.length > 1) {
		const result: string[] = [];
		for (const line of lines) {
			if (/\d+[.、）)]/.test(line) && line.length > 60) {
				result.push(...splitAnswerPoints(line));
			} else if (line.length <= 80) {
				result.push(line);
			} else {
				result.push(...splitSemantic(line));
			}
		}
		return result;
	}
	if (/\d+[.、）)]/.test(trimmed)) {
		return splitAnswerPoints(trimmed);
	}
	if (trimmed.length > 80) {
		return splitSemantic(trimmed);
	}
	return [trimmed];
}

export function highlightTechTerms(text: string): TextRun[] {
	const runs: TextRun[] = [];
	let lastIndex = 0;
	TECH_TERMS.lastIndex = 0;
	let m;
	while ((m = TECH_TERMS.exec(text)) !== null) {
		if (m.index > lastIndex) {
			runs.push(new TextRun({ text: text.slice(lastIndex, m.index), font: FONT, size: FSBody }));
		}
		runs.push(new TextRun({ text: m[0], font: FONT, size: FSBody, underline: { type: UnderlineType.WAVE, color: "FF0000" } }));
		lastIndex = m.index + m[0].length;
	}
	if (lastIndex < text.length) {
		runs.push(new TextRun({ text: text.slice(lastIndex), font: FONT, size: FSBody }));
	}
	return runs.length > 0 ? runs : [new TextRun({ text, font: FONT, size: FSBody })];
}

export function highlightTechHtml(text: string): string {
	return text.replace(TECH_TERMS, '<span style="text-decoration:underline wavy red;">$&</span>');
}

export function fixSequentialNumbers(text: string): string {
	return text.replace(/((?:^|\n)(?:\*\*)?答案(?:\*\*)?[：:]\s*)(.+?)(?=\n|$)/g, (_match, prefix: string, content: string) => {
		const parts = content.split(/(?=\(\d+\)\s)/);
		if (parts.length < 2) return prefix + content;
		let seq = 0;
		const fixed = parts.map((p: string) => {
			const m = p.match(/^\(\d+\)\s(.+)/);
			if (m) { seq++; return "(" + seq + ") " + m[1]; }
			return p;
		});
		return prefix + fixed.join(" ");
	});
}

function extractLabelContent(line: string, label: string): string | null {
	const m = line.match(new RegExp("^\\*{0,2}" + label + "\\*{0,2}[：:](.*)$"));
	if (!m) return null;
	return (m[1] || "").trim().replace(/^\*{1,2}/, "").replace(/\*{1,2}$/, "").trim();
}

function splitPoints(content: string): string[] {
	return content.split(/(?=\d+\.(?!\d)|\d+[、）)])/).map(s => s.trim()).filter(Boolean);
}

export function normalizeExamContent(text: string): string {
	const lines = text.split("\n");
	const result: string[] = [];
	let lastType = "";
	let inAnswerBlock = false;
	let inExplainBlock = false;
	let answerSeq = 0;
	let expSeq = 0;
	const nextPoint = (raw: string): string => {
		const cleaned = raw.trim().replace(/^(?:\*\*)?(?:\(\d+\)|\d+(?:\*\*)?[.、）)])\s*/, "").trim();
		if (!cleaned.replace(/[（(）)\s]/g, "")) return "";
		answerSeq++;
		return "(" + answerSeq + ") " + cleaned;
	};
	const nextExpPoint = (raw: string): string => {
		const cleaned = raw.trim().replace(/^(?:\*\*)?(?:\(\d+\)|\d+(?:\*\*)?[.、）)])\s*/, "").trim();
		if (!cleaned.replace(/[（(）)\s]/g, "")) return "";
		expSeq++;
		return "(" + expSeq + ") " + cleaned;
	};
	const isPointLine = (t: string): boolean => /^(?:\*\*)?(?:\(\d+\)|\d+(?:\*\*)?[.、）)])/.test(t);
	const isParenPoint = (t: string): boolean => /^(?:\*\*)?\(\d+\)/.test(t);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const trimmed = line.trim();
		if (trimmed === "") {
			inAnswerBlock = false;
			inExplainBlock = false;
			if (result.length > 0 && result[result.length - 1] !== "") result.push("");
			continue;
		}
		if (/^#{1,6}\s+/.test(trimmed)) {
			if (/^####\s+/.test(trimmed) && (inAnswerBlock || lastType === "answer")) {
				answerSeq = 0;
				result.push(trimmed);
				lastType = "answer";
				continue;
			}
			if (result.length > 0 && result[result.length - 1] !== "") result.push("");
			result.push(trimmed);
			lastType = "heading";
			inAnswerBlock = false;
			inExplainBlock = false;
			continue;
		}
		if ((inAnswerBlock || lastType === "answer") && /^[*>\s]*补充说明[：:]/.test(trimmed)) {
			result.push("> " + trimmed.replace(/^[*>\s]+/, "").replace(/[*\s]+$/, "").trim());
			lastType = "answer";
			continue;
		}
		if (isPointLine(trimmed)) {
			if (inAnswerBlock || (isParenPoint(trimmed) && lastType === "answer")) {
				const p = nextPoint(trimmed);
				if (p) result.push(p);
				lastType = "answer";
				continue;
			}
			if (inExplainBlock) {
				const p = nextExpPoint(trimmed);
				if (p) result.push(p);
				lastType = "explanation";
				continue;
			}
			if (lastType === "answer" || lastType === "explanation" || lastType === "option" || lastType === "question") {
				if (result.length > 0 && result[result.length - 1] !== "") result.push("");
			}
			result.push(trimmed);
			lastType = "question";
			continue;
		}
		if (/^[A-D][.、]/.test(trimmed)) {
			if (inAnswerBlock) {
				result.push(trimmed);
				lastType = "answer";
				continue;
			}
			result.push(trimmed);
			lastType = "option";
			continue;
		}
		if (/^(?:\*\*)?(?:答案|标准答案|参考答案)(?:\*\*)?[：:]/.test(trimmed)) {
			const prev = result.length > 0 ? result[result.length - 1]! : "";
			if (lastType === "option" || lastType === "explanation") {
				if (prev !== "") result.push("");
			} else if (lastType === "question" && /(?:____|_{3,}|（\s*）|\(\s*\))/.test(prev)) {
				if (prev !== "") result.push("");
			}
			result.push("**答案：**");
			answerSeq = 0;
			const content = extractLabelContent(trimmed, "(?:答案|标准答案|参考答案)") ?? "";
			if (content) {
				const points = splitPoints(content);
				if (points.length > 1) {
					for (const p of points) {
						const np = nextPoint(p);
						if (np) result.push(np);
					}
				} else if (/^(?:\(\d+\)|\d+[.、）)])/.test(content)) {
					const np = nextPoint(content);
					if (np) result.push(np);
				} else {
					result[result.length - 1] = "**答案：" + content + "**";
				}
			}
			lastType = "answer";
			inAnswerBlock = true;
			inExplainBlock = false;
			continue;
		}
		if (/^(?:\*\*)?解析(?:\*\*)?[：:]/.test(trimmed)) {
			result.push("**解析：**");
			expSeq = 0;
			const content = extractLabelContent(trimmed, "解析") ?? "";
			if (content) {
				const points = splitPoints(content);
				if (points.length > 1) {
					const firstPoint = points.shift();
					if (points.length > 0 && firstPoint && !/^(?:\(\d+\)|\d+[.、）)])/.test(firstPoint)) {
						result.push(firstPoint);
					} else if (firstPoint) {
						points.unshift(firstPoint);
					}
					for (const p of points) {
						const np = nextExpPoint(p);
						if (np) result.push(np);
					}
				} else if (/^(?:\(\d+\)|\d+[.、）)])/.test(content)) {
					const np = nextExpPoint(content);
					if (np) result.push(np);
				} else {
					const prose = content.replace(/^(?:\*\*)?(?:\(\d+\)|\d+(?:\*\*)?[.、）)])\s*/, "").trim();
					result.push(prose);
				}
			}
			lastType = "explanation";
			inAnswerBlock = false;
			inExplainBlock = true;
			continue;
		}
		result.push(trimmed);
		lastType = inExplainBlock ? "explanation" : "text";
	}
	while (result.length > 0 && result[result.length - 1] === "") result.pop();
	return result.join("\n");
}
