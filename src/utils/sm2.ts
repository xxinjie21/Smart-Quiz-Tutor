import { addDaysStr, localDateStr } from "./date";
import { EASE_MIN, EASE_MAX, MAX_INTERVAL_DAYS } from "../constants";

/** 单条复习项的 SM-2 状态。 */
export interface Sm2State {
	easeFactor: number;
	repetitions: number;
	interval: number;
	lapses: number;
}

export interface Sm2Result extends Sm2State {
	nextReview: string;
}

export const DEFAULT_EASE_FACTOR = 2.5;
export const MIN_EASE_FACTOR = 1.3;

/** 答题质量评分（SM-2 的 q，0–5）。 */
export const QUALITY = { forgot: 1, hard: 3, good: 4, easy: 5 } as const;

/** 把难度因子限制在合理范围内。 */
export function clampEase(n: number): number {
	if (!isFinite(n) || n <= 0) return DEFAULT_EASE_FACTOR;
	return Math.min(EASE_MAX, Math.max(EASE_MIN, n));
}

/**
 * 纯正 SM-2 更新：
 * - q < 3：复习失败，repetitions 归零、interval=1、lapses+1；
 * - q >= 3：I(1)=1、I(2)=6，之后 I=round(上一间隔 × EF)；
 * - EF 每次按质量调整，并夹在 [1.3, 3.0]；
 * - interval 夹在 [1, {@link MAX_INTERVAL_DAYS}]，避免反复「简单」把日期算成 Invalid Date。
 */
export function sm2Update(state: Sm2State, quality: number): Sm2Result {
	const q = Math.max(0, Math.min(5, Math.round(quality)));
	let repetitions: number;
	let interval: number;
	let lapses = state.lapses || 0;

	if (q < 3) {
		repetitions = 0;
		interval = 1;
		lapses += 1;
	} else {
		repetitions = (state.repetitions || 0) + 1;
		if (repetitions === 1) interval = 1;
		else if (repetitions === 2) interval = 6;
		else {
			const prev = state.interval || 1;
			const ef = clampEase(state.easeFactor || DEFAULT_EASE_FACTOR);
			interval = Math.max(1, Math.round(prev * ef));
		}
	}
	// 硬上限：错题卡片允许未到期时反复评分，无上界会让间隔溢出成 Invalid Date。
	if (!isFinite(interval) || interval > MAX_INTERVAL_DAYS) interval = MAX_INTERVAL_DAYS;

	let easeFactor = state.easeFactor || DEFAULT_EASE_FACTOR;
	easeFactor = easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
	// 与 clampEase 保持一致：既守下限也守上限，否则 EF 会一路涨到 7+ 并让间隔提前炸掉。
	easeFactor = Math.min(EASE_MAX, Math.max(EASE_MIN, easeFactor));
	easeFactor = Math.round(easeFactor * 100) / 100;

	return { easeFactor, repetitions, interval, lapses, nextReview: addDaysStr(localDateStr(), interval) };
}