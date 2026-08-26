import { zh } from "./zh";
import { en } from "./en";

let current: "zh" | "en" = "zh";

export function setLanguage(lang: "zh" | "en") { current = lang; }
export function getLanguage(): "zh" | "en" { return current; }

export function t(key: string): string {
	if (current === "en") return en[key as keyof typeof en] ?? key;
	return zh[key as keyof typeof zh] ?? key;
}

export function tf(key: string, params: Record<string, string | number>): string {
	let s = t(key);
	for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
	return s;
}

export { zh, en };
