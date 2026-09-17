import { describe, it, expect } from "vitest";
import { matchQuery } from "../src/utils/list";

describe("matchQuery", () => {
	it("matches case-insensitively across fields", () => {
		expect(matchQuery("REDIS", ["说明 Redis", "xxx"])).toBe(true);
		expect(matchQuery("redis", ["nothing", "Redis 分布式锁"])).toBe(true);
	});

	it("matches tags and content fields", () => {
		expect(matchQuery("锁", ["Redis 分布式锁", "a", "b", "c"])).toBe(true);
		expect(matchQuery("缺省", ["这里没有"])).toBe(false);
	});

	it("returns true when query is empty or whitespace", () => {
		expect(matchQuery("", ["a"])).toBe(true);
		expect(matchQuery("   ", ["a"])).toBe(true);
	});
});