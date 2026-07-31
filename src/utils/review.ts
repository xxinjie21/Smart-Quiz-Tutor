import type { WrongAnswerNote } from "../types";

export const DEFAULT_WRONG_INTERVALS = [1, 2, 4, 7, 15, 30];
export const DEFAULT_QUESTION_INTERVALS = [7, 15, 30, 60, 90];
export const DEFAULT_NOTE_INTERVALS = [2, 6, 14, 35, 70];

export function parseReviewIntervals(s: string, fallback: number[]): number[] {
	const nums = s.split(",").map(v => parseInt(v.trim())).filter(v => v > 0);
	return nums.length > 0 ? nums : fallback;
}

export function reviewUpdate(correctCount: number, wasCorrect: boolean, intervals?: number[]): { correctCount: number; interval: number; nextReview: string } {
	const ivls = intervals || DEFAULT_WRONG_INTERVALS;
	let newCorrect = wasCorrect ? correctCount + 1 : 0;
	const idx = Math.min(newCorrect - 1, ivls.length - 1);
	const newInterval = ivls[Math.max(idx, 0)]!;
	const nextDate = new Date();
	nextDate.setDate(nextDate.getDate() + newInterval);
	return { correctCount: newCorrect, interval: newInterval, nextReview: nextDate.toISOString().slice(0, 10) };
}

export function todayStr(): string {
	return new Date().toISOString().slice(0, 10);
}

export function isDueForReview(note: WrongAnswerNote): boolean {
	if (!note.nextReview) return false;
	return note.nextReview <= todayStr();
}
