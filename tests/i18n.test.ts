import { describe, it, expect, beforeEach } from "vitest";
import { t, tf, setLanguage, getLanguage, zh, en } from "../src/i18n/index";

describe("i18n 字典", () => {
	it("en 必须覆盖 zh 的所有 key", () => {
		const zhKeys = Object.keys(zh).sort();
		const enKeys = Object.keys(en).sort();
		expect(enKeys).toEqual(zhKeys);
	});
	it("zh 的 value 与 key 相同（原文即 key）", () => {
		for (const [k, v] of Object.entries(zh)) expect(v).toBe(k);
	});
});

describe("t()", () => {
	beforeEach(() => setLanguage("zh"));
	it("zh 模式返回原文", () => {
		expect(t("根文件夹")).toBe("根文件夹");
	});
	it("en 模式返回英文", () => {
		setLanguage("en");
		expect(t("根文件夹")).toBe("Root folder");
	});
	it("缺失 key 回退原文（不空白）", () => {
		setLanguage("en");
		expect(t("不存在的key")).toBe("不存在的key");
	});
	it("getLanguage 反映当前语言", () => {
		setLanguage("en");
		expect(getLanguage()).toBe("en");
	});
});

describe("tf() 占位符", () => {
	beforeEach(() => setLanguage("zh"));
	it("替换 {n} 占位符", () => {
		expect(tf("共 {n} 次学习活动", { n: 3 })).toBe("共 3 次学习活动");
	});
	it("en 模式替换占位符", () => {
		setLanguage("en");
		expect(tf("共 {n} 次学习活动", { n: 3 })).toBe("3 learning activities in total");
	});
	it("多个占位符", () => {
		setLanguage("en");
		expect(tf("已选 {a} 个，共 {b} 个", { a: 2, b: 5 })).toBe("2 selected, 5 in total");
	});
});
