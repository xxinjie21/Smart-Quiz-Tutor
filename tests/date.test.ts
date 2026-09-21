import { describe, it, expect } from "vitest";
import { localDateStr, addDaysStr } from "../src/utils/date";

describe("localDateStr", () => {
	it("formats a local date as YYYY-MM-DD", () => {
		expect(localDateStr(new Date(2026, 8, 3))).toBe("2026-09-03");
		expect(localDateStr(new Date(2026, 0, 1))).toBe("2026-01-01");
	});
	it("uses local components, not UTC", () => {
		const d = new Date(2026, 0, 31, 23, 30);
		expect(localDateStr(d)).toBe("2026-01-31");
	});
});

describe("addDaysStr", () => {
	it("adds days across month and year boundaries", () => {
		expect(addDaysStr("2026-01-31", 1)).toBe("2026-02-01");
		expect(addDaysStr("2026-12-31", 1)).toBe("2027-01-01");
		expect(addDaysStr("2026-03-01", -1)).toBe("2026-02-28");
	});
	it("handles leap years", () => {
		expect(addDaysStr("2028-02-28", 1)).toBe("2028-02-29");
	});
});