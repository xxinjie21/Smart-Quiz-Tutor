import type { HistoryEntry } from "../types";

/**
 * 裁剪历史记录：只保留最近 maxEntries 条，并把每条 resultText 截断到 maxResultChars。
 * 纯函数，返回新数组，不修改入参。
 */
export function pruneHistory(history: HistoryEntry[], maxEntries: number, maxResultChars: number): HistoryEntry[] {
	if (history.length === 0) return history;
	const recent = maxEntries > 0 && history.length > maxEntries ? history.slice(-maxEntries) : history;
	return recent.map(e => (e.resultText && e.resultText.length > maxResultChars)
		? { ...e, resultText: e.resultText.slice(0, maxResultChars) }
		: e);
}
