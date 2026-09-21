import { describe, it, expect } from "vitest";
import { sm2Update, clampEase, DEFAULT_EASE_FACTOR, MIN_EASE_FACTOR, QUALITY } from "../src/utils/sm2";

const fresh = { easeFactor: 2.5, repetitions: 0, interval: 1, lapses: 0 };

describe("sm2Update", () => {
	it("uses strict SM-2 1/6 then EF growth when no warm-up list", () => {
		let s = sm2Update(fresh, QUALITY.good);
		expect(s.interval).toBe(1);
		s = sm2Update(s, QUALITY.good);
		expect(s.interval).toBe(6);
		const before = s;
		s = sm2Update(s, QUALITY.good);
		expect(s.interval).toBe(Math.round(before.interval * before.easeFactor));
		expect(s.repetitions).toBe(3);
	});

	it("resets repetitions and bumps lapses on failure", () => {
		const s = sm2Update({ easeFactor: 2.5, repetitions: 4, interval: 60, lapses: 1 }, QUALITY.forgot);
		expect(s.repetitions).toBe(0);
		expect(s.interval).toBe(1);
		expect(s.lapses).toBe(2);
	});

	it("raises EF for easy and lets it drop (floor 1.3) for hard/failed", () => {
		const easy = sm2Update(fresh, QUALITY.easy);
		expect(easy.easeFactor).toBeGreaterThan(DEFAULT_EASE_FACTOR);
		let s = { ...fresh };
		for (let i = 0; i < 10; i++) s = sm2Update(s, QUALITY.forgot);
		expect(s.easeFactor).toBe(MIN_EASE_FACTOR);
	});

	it("returns a nextReview date string", () => {
		const s = sm2Update(fresh, QUALITY.good);
		expect(s.nextReview).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});

describe("clampEase", () => {
	it("clamps into [1.3, 3.0]", () => {
		expect(clampEase(1.0)).toBe(MIN_EASE_FACTOR);
		expect(clampEase(5)).toBe(3.0);
		expect(clampEase(2.4)).toBe(2.4);
	});
	it("falls back to the default for invalid input", () => {
		expect(clampEase(NaN)).toBe(DEFAULT_EASE_FACTOR);
		expect(clampEase(0)).toBe(DEFAULT_EASE_FACTOR);
	});
});