import type { WrongAnswerNote } from "../types";
import { localDateStr } from "./date";

export function todayStr(): string {
	return localDateStr();
}

/** `YYYY-MM-DD` 形状校验，用于识别「不是日期」的排期值。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 是否到了复习时间。
 *
 * `nextReview` 缺失有两种来历，都按「新条目」处理、判定为立即到期：
 * 1. **尚未排期**——手工创建的文件，或早期插件版本写入的文件；
 * 2. **非法值**——旧版 SM-2 间隔无上限时溢出写出的 `NaN-NaN-NaN`。
 *
 * 若把这两种情况一律判为「不到期」，这些条目就永远不会出现在「今日待复习」里，
 * 也就永远复习不到（判为到期后用户评一次分即会写回合法排期，文件就自愈了）。
 *
 * 插件自身写入的条目一定带合法 `nextReview`，因此不受影响。
 */
export function isDueForReview(note: WrongAnswerNote): boolean {
	const next = note.nextReview;
	if (!next || !DATE_RE.test(next)) return true;
	return next <= todayStr();
}