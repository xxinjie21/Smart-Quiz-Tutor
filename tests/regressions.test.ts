import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { parseFM, patchFrontmatter } from "../src/utils/frontmatter";
import { trashFileAbs, TRASH_DIR_NAME, isExcludedPath, isAbs } from "../src/utils/fs-utils";
import { stripAnswersForExport, extractAnswersForExport, safeName } from "../src/utils/text";
import { parseExamBlocks, stripMdBold } from "../src/utils/exporter";
import { normalizePluginDirs, isCasualQuery } from "../src/services/chatService";
import { joinApiUrl } from "../src/services/llmService";
import { stripRtf, decodeTextBytes } from "../src/services/documentService";
import { clampSettingValue, SETTING_SECTIONS, type SettingItem } from "../src/views/settingsSchema";
import { parseAITagsFromResult } from "../src/services/questionService";
import {
	toNote,
	WRONG_NOTE_DEFAULTS,
	QUESTION_NOTE_DEFAULTS,
	NOTE_VIEW_DEFAULTS,
} from "../src/services/vaultDataService";
import { EASE_PRESETS, EASE_MIN, EASE_MAX, MAX_INTERVAL_DAYS, CHAT_HISTORY_LIMIT } from "../src/constants";
import { sm2Update, clampEase, DEFAULT_EASE_FACTOR } from "../src/utils/sm2";
import { isDueForReview, todayStr } from "../src/utils/review";
import { openConfirm, openInput } from "../src/views/ui/modals";
import { capMessages, planCompression, collectSummaries, buildRequestMessages } from "../src/utils/chatStorage";
import type { ChatMessage } from "../src/types";

/** 提示词（QUESTION_FORMAT_RULES 铁律 2）强制 AI 输出加粗题号，这里全部按加粗形式构造。 */
const BOLD_EXAM = [
	"## 单选题",
	"**1.** 下列哪项正确？",
	"A. 甲",
	"B. 乙",
	"答案：A",
	"解析：因为甲。",
	"**2.** 第二题？",
	"A. 甲",
	"B. 乙",
	"答案：B",
	"解析：因为乙。",
].join("\n");

describe("加粗题号兼容（导出侧不再漏题/漏号）", () => {
	it("stripMdBold 归一化题号/选项前缀", () => {
		expect(stripMdBold("**1.** 题干")).toBe("1. 题干");
		expect(stripMdBold("**A.** 选项")).toBe("A. 选项");
		expect(stripMdBold("**(1)** 要点")).toBe("(1) 要点");
		expect(stripMdBold("普通行")).toBe("普通行");
	});

	it("parseExamBlocks 识别加粗题号，且不把 ** 泄漏到导出内容", () => {
		const blocks = parseExamBlocks(BOLD_EXAM);
		const questions = blocks.filter(b => b.type === "question");
		expect(questions).toHaveLength(2);
		expect(questions[0]!.parts[0]).toBe("1. 下列哪项正确？");
		expect(questions[1]!.parts[0]).toBe("2. 第二题？");
		expect(blocks.every(b => b.parts.every(p => !p.includes("**")))).toBe(true);
	});

	it("无答案版保留全部题目（旧实现会整段丢掉第二题）", () => {
		const out = stripAnswersForExport(BOLD_EXAM);
		expect(out).toContain("**1.** 下列哪项正确？");
		expect(out).toContain("**2.** 第二题？");
		expect(out).not.toContain("答案：");
		expect(out).not.toContain("解析：");
	});

	it("仅答案版带上题号（旧实现丢失题号）", () => {
		const out = extractAnswersForExport(BOLD_EXAM);
		expect(out).toContain("1. 答案：A");
		expect(out).toContain("2. 答案：B");
	});

	it("`####` 级标题不被当作题型标题复位（否则答案块会串题）", () => {
		const text = ["## 简答题", "**1.** 题干", "答案：略", "#### 补充", "**2.** 第二题", "答案：略"].join("\n");
		const out = stripAnswersForExport(text);
		expect(out).toContain("**2.** 第二题");
	});
});

describe("删除必须是可恢复的（trashFileAbs）", () => {
	let dir = "";
	beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "qg-trash-")); });
	afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

	it("系统回收站不可用时移入 .qg-trash，而不是永久删除", async () => {
		const file = path.join(dir, "a.md");
		fs.writeFileSync(file, "hi", "utf-8");

		expect(await trashFileAbs(file)).toBe(true);
		expect(fs.existsSync(file)).toBe(false);

		const trashed = fs.readdirSync(path.join(dir, TRASH_DIR_NAME));
		expect(trashed).toHaveLength(1);
		expect(trashed[0]!.startsWith("a.md.")).toBe(true);
		expect(fs.readFileSync(path.join(dir, TRASH_DIR_NAME, trashed[0]!), "utf-8")).toBe("hi");
	});

	it("文件本就不存在时视为成功", async () => {
		expect(await trashFileAbs(path.join(dir, "missing.md"))).toBe(true);
	});

	it(".qg-trash 被排除在扫描之外（不会被当成知识点/题目）", () => {
		expect(isExcludedPath(dir + "/" + TRASH_DIR_NAME + "/a.md", "")).toBe(true);
		expect(isExcludedPath("题目/" + TRASH_DIR_NAME + "/a.md", "笔记")).toBe(true);
	});
});

describe("patchFrontmatter 只改目标键，不再整体重写 frontmatter", () => {
	const CONTENT = [
		"---",
		'source: "[[原题]]"',
		"tags: [题目, 函数]",
		"note: |",
		"  第一行",
		"  第二行",
		"meta:",
		"  nested: true",
		"interval: 1",
		"---",
		"",
		"正文",
	].join("\n");

	it("保留块标量、嵌套结构与未涉及的键", () => {
		const out = patchFrontmatter(CONTENT, { interval: 6, correctCount: 1 });
		expect(out).toContain("note: |");
		expect(out).toContain("  第一行");
		expect(out).toContain("  第二行");
		expect(out).toContain("meta:");
		expect(out).toContain("  nested: true");
		expect(out).toContain("tags: [题目, 函数]");
		expect(out).toContain('source: "[[原题]]"');
		expect(out).toContain("interval: 6");
		expect(out).toContain("correctCount: 1");
		expect(out.endsWith("正文")).toBe(true);
	});

	it("回填结果仍能被 parseFM 解析回原值（round-trip）", () => {
		const { meta, body } = parseFM(patchFrontmatter(CONTENT, { interval: 6 }));
		expect(meta.interval).toBe(6);
		expect(meta.note).toBe("第一行\n第二行");
		expect(meta.tags).toEqual(["题目", "函数"]);
		expect(body).toBe("正文");
	});

	it("替换块标量键时把整个块一起换掉（不留残行）", () => {
		const out = patchFrontmatter(CONTENT, { note: "改过了" });
		expect(out).toContain('note: "改过了"');
		expect(out).not.toContain("  第一行");
		expect(out).not.toContain("  第二行");
		expect(out).toContain("meta:");
	});

	it("目标键不存在时追加到 frontmatter 末尾", () => {
		const out = patchFrontmatter(CONTENT, { nextReview: "2026-01-01" });
		expect(out).toContain('nextReview: "2026-01-01"');
		const { meta } = parseFM(out);
		expect(meta.nextReview).toBe("2026-01-01");
		expect(meta.interval).toBe(1);
	});

	it("没有 frontmatter 时补一个块，且不改动正文", () => {
		const out = patchFrontmatter("# 标题\n正文", { tags: ["a"] });
		expect(out.startsWith("---\n")).toBe(true);
		expect(out).toContain("tags: [a]");
		expect(out).toContain("# 标题\n正文");
		expect(parseFM(out).body).toBe("# 标题\n正文");
	});

	it("CRLF 文件保持 CRLF，不混入裸换行", () => {
		const out = patchFrontmatter(CONTENT.replace(/\n/g, "\r\n"), { interval: 9 });
		expect(out).toContain("interval: 9");
		expect(out.replace(/\r\n/g, "")).not.toContain("\n");
	});
});

describe("parseFM 硬化", () => {
	it("块标量解析为多行字符串", () => {
		const { meta } = parseFM("---\nnote: |\n  甲\n  乙\n---\n\nbody");
		expect(meta.note).toBe("甲\n乙");
	});

	it("引号内的逗号不当作列表分隔符", () => {
		const { meta } = parseFM('---\ntags: ["a, b", c]\n---\n\nbody');
		expect(meta.tags).toEqual(["a, b", "c"]);
	});

	it("只有行首 --- 才是结束符（值里的 --- 不会截断 frontmatter）", () => {
		const { meta, body } = parseFM("---\nnote: a---b\ntitle: T\n---\n\n正文");
		expect(meta.title).toBe("T");
		expect(meta.note).toBe("a---b");
		expect(body).toBe("正文");
	});

	it("缩进的续行不会被误当成新的键", () => {
		const { meta } = parseFM("---\nmeta:\n  nested: true\ninterval: 2\n---\n\nbody");
		expect(meta.interval).toBe(2);
		expect(meta.nested).toBeUndefined();
	});
});

describe("normalizePluginDirs（修复「仅插件知识库」检索恒为空）", () => {
	it("绝对路径转成 vault 相对路径", () => {
		expect(normalizePluginDirs(["D:\\Vault\\智学助手\\题目"], "D:/Vault")).toEqual(["智学助手/题目"]);
	});

	it("Windows 路径大小写不敏感", () => {
		expect(normalizePluginDirs(["d:/vault/题目"], "D:/Vault")).toEqual(["题目"]);
	});

	it("vault 之外的目录被丢弃（无法通过 vault API 读取）", () => {
		expect(normalizePluginDirs(["E:/其他/题目"], "D:/Vault")).toEqual([]);
	});

	it("相对路径原样保留并去掉首尾斜杠", () => {
		expect(normalizePluginDirs(["题目/", "笔记"], "D:/Vault")).toEqual(["题目", "笔记"]);
	});

	it("拿不到 vault 根目录时丢弃绝对路径（移动端）", () => {
		expect(normalizePluginDirs(["/题目"], "")).toEqual([]);
	});
});

describe("isCasualQuery 不再用长度一刀切", () => {
	it("3~4 字的真实提问仍然检索", () => {
		expect(isCasualQuery("什么是熵")).toBe(false);
		expect(isCasualQuery("为什么")).toBe(false);
	});

	it("寒暄与纯应答仍视为闲聊", () => {
		expect(isCasualQuery("你好")).toBe(true);
		expect(isCasualQuery("yes")).toBe(true);
		expect(isCasualQuery("谢谢")).toBe(true);
		expect(isCasualQuery("ok")).toBe(true);
	});
});

describe("clampSettingValue 真正约束 min/max", () => {
	const item = (key: string): SettingItem => {
		const found = SETTING_SECTIONS.flatMap(s => s.items).find(i => i.key === key);
		if (!found) throw new Error("未找到设置项：" + key);
		return found;
	};

	it("超过上限夹到上限", () => {
		expect(clampSettingValue(item("countSingle"), 999)).toBe(50);
	});

	it("低于下限夹到下限", () => {
		expect(clampSettingValue(item("countSingle"), -5)).toBe(0);
	});

	it("范围内的值原样保留", () => {
		expect(clampSettingValue(item("temperature"), 0.7)).toBe(0.7);
	});

	it("非数值原样返回（避免把非法输入变成 0）", () => {
		expect(clampSettingValue(item("countSingle"), "abc")).toBe("abc");
	});

	it("文本项不受影响", () => {
		expect(clampSettingValue(item("rootFolder"), "任意/路径")).toBe("任意/路径");
	});
});

describe("parseAITagsFromResult 扫描窗口", () => {
	it("标签行之后还有答案汇总时仍能解析（旧实现只看最后 5 行）", () => {
		const text = [
			"## 单选题",
			"**1.** 题干",
			"答案：A",
			"",
			"知识点：函数, 导数",
			"",
			"---",
			"",
			"## 答案汇总",
			"1. A",
			"2. B",
			"",
			"（以上为本次生成结果）",
		].join("\n");
		const { tags, cleanText } = parseAITagsFromResult(text);
		expect(tags).toEqual(["函数", "导数"]);
		expect(cleanText).not.toContain("知识点：");
		expect(cleanText).toContain("## 单选题");
	});

	it("加粗与顿号分隔的标签行也能识别", () => {
		const { tags } = parseAITagsFromResult("题干\n\n**知识点：** 力学、光学");
		expect(tags).toEqual(["力学", "光学"]);
	});

	it("没有标签行时原样返回", () => {
		const text = "## 单选题\n**1.** 题干\n答案：A";
		expect(parseAITagsFromResult(text)).toEqual({ tags: [], cleanText: text });
	});
});

describe("EASE_PRESETS 文案方向与因子一致", () => {
	it("因子大 = 复习少，标签不能再写成「慢速/快速」", () => {
		expect(EASE_PRESETS.find(p => p.factor === 2.7)!.label).toContain("少复习");
		expect(EASE_PRESETS.find(p => p.factor === 2.3)!.label).toContain("多复习");
	});
});

describe("safeName Windows 边界", () => {
	it("去掉结尾的点与空格、开头的空格", () => {
		expect(safeName("abc...")).toBe("abc");
		expect(safeName("abc  ")).toBe("abc");
		expect(safeName("  abc")).toBe("abc");
		expect(safeName("a.md")).toBe("a");
	});
});

describe("弹窗关闭一定结算 Promise（Esc / 点击遮罩不再永久 pending）", () => {
	it("确认弹窗被直接关闭时按「取消」结算", async () => {
		const instances: { close(): void }[] = [];
		const { Modal } = await import("obsidian");
		const proto = Modal.prototype as unknown as { open(): void };
		const originalOpen = proto.open;
		proto.open = function (this: { close(): void }) { instances.push(this); };

		try {
			const p = openConfirm({} as never, { text: "确定？" });
			expect(instances).toHaveLength(1);
			instances[0]!.close();
			await expect(p).resolves.toBe(false);
		} finally {
			proto.open = originalOpen;
		}
	});

	it("输入弹窗被直接关闭时按「取消」结算（返回 null）", async () => {
		const instances: { close(): void }[] = [];
		const { Modal } = await import("obsidian");
		const proto = Modal.prototype as unknown as { open(): void };
		const originalOpen = proto.open;
		proto.open = function (this: { close(): void }) { instances.push(this); };

		try {
			const p = openInput({} as never, { title: "命名" });
			instances[0]!.close();
			await expect(p).resolves.toBeNull();
		} finally {
			proto.open = originalOpen;
		}
	});
});

// ============================================================
// 第四轮复审（2026-09-20）：边界压测发现的问题
// 全部按「必须成立」的防回归断言写死，失败即代表修复被回退。
// ============================================================

describe("patchFrontmatter 幂等与 BOM", () => {
	it("连打两次结果完全一致（旧实现每次多插一个空行）", () => {
		const src = "---\ntitle: A\ninterval: 1\nnote: |\n  第一行\n  第二行\n---\n\n正文\n";
		const once = patchFrontmatter(src, { interval: 6 });
		const twice = patchFrontmatter(once, { interval: 6 });
		expect(twice).toBe(once);
		const thrice = patchFrontmatter(twice, { interval: 6 });
		expect(thrice).toBe(once);
	});

	it("重复评分 30 次不会让 frontmatter 增长", () => {
		const original = "---\ntitle: A\ninterval: 1\n---\n\n正文\n";
		let c = original;
		for (let i = 0; i < 30; i++) c = patchFrontmatter(c, { interval: i + 1 });
		expect(c.split("\n").length).toBe(original.split("\n").length);
		expect(c).toContain("title: A");
		expect(c).toContain("interval: 30");
	});

	it("块标量正文里 `xxx:` 形状的行不能被误改", () => {
		const src = "---\ntitle: A\nnote: |\n  interval: 999\n  正常内容\n---\n\n正文\n";
		const out = patchFrontmatter(src, { interval: 6 });
		expect(out).toContain("  interval: 999");
		expect(out).toContain("interval: 6");
	});

	it("重复 key 只保留一行", () => {
		const out = patchFrontmatter("---\ninterval: 1\ninterval: 2\n---\n\n正文\n", { interval: 6 });
		expect(out.split("\n").filter(l => l.startsWith("interval:")).length).toBe(1);
	});

	it("带 BOM 的文件不产生第二个 frontmatter 块", () => {
		const out = patchFrontmatter("\uFEFF---\ntitle: A\ninterval: 1\n---\n\n正文\n", { interval: 6 });
		expect(out.split("---").length - 1).toBe(2);
		expect(out.startsWith("\uFEFF---")).toBe(true);
	});

	it("带 BOM 的文件 parseFM 仍能读出 frontmatter", () => {
		const { meta, body } = parseFM("\uFEFF---\ntitle: A\ninterval: 3\n---\n\n正文\n");
		expect(meta.title).toBe("A");
		expect(meta.interval).toBe(3);
		expect(body).toContain("正文");
	});

	it("CRLF 文件改完仍是纯 CRLF", () => {
		const out = patchFrontmatter("---\r\ntitle: A\r\ninterval: 1\r\n---\r\n\r\n正文\r\n", { interval: 6 });
		expect(out.includes("\r\n")).toBe(true);
		expect(/[^\r]\n/.test(out)).toBe(false);
	});

	it("多行值与数组值写入后能原样读回", () => {
		const withNote = patchFrontmatter("---\ntitle: A\n---\n\n正文\n", { note: "一\n二" });
		expect(parseFM(withNote).meta.note).toBe("一\n二");
		const withTags = patchFrontmatter("---\ntitle: A\n---\n\n正文\n", { tags: ["a", "b: c", "d, e"] });
		expect(parseFM(withTags).meta.tags).toEqual(["a", "b: c", "d, e"]);
	});
});

describe("normalizePluginDirs 越界防护", () => {
	const base = "D://Vault";
	it("绝对路径转 vault 相对路径", () => {
		expect(normalizePluginDirs([base + "\\题目"], base)).toEqual(["题目"]);
	});
	it("vault 外目录被丢弃", () => {
		expect(normalizePluginDirs(["E://其它//题目"], base)).toEqual([]);
	});
	it("前缀相似的兄弟目录不被误判（D://Vault2 不属于 D://Vault）", () => {
		expect(normalizePluginDirs(["D://Vault2//题目"], base)).toEqual([]);
	});
	it("含 `..` 的相对/绝对路径都被丢弃", () => {
		expect(normalizePluginDirs(["..\\..\\Windows"], base)).toEqual([]);
		expect(normalizePluginDirs([base + "\\..\\其它"], base)).toEqual([]);
	});
	it("末尾斜杠被规整、大小写不敏感、重复斜杠被折叠", () => {
		expect(normalizePluginDirs([base + "\\题目\\"], base)).toEqual(["题目"]);
		expect(normalizePluginDirs(["d://vault//题目"], base)).toEqual(["题目"]);
		expect(normalizePluginDirs(["D:/Vault/题目"], base)).toEqual(["题目"]);
	});
});

describe("stripMdBold 两种星号位置", () => {
	it("`**1.**`（点号在星号内）与 `**1**.`（点号在星号外）都要处理干净", () => {
		expect(stripMdBold("**1.** 题干")).toBe("1. 题干");
		expect(stripMdBold("**1**. 题干")).toBe("1. 题干");
		expect(stripMdBold("**1** 题干")).toBe("1 题干");
		expect(stripMdBold("**A.** 选项")).toBe("A. 选项");
		expect(stripMdBold("**A**. 选项")).toBe("A. 选项");
		expect(stripMdBold("**(1)** 小问")).toBe("(1) 小问");
	});
	it("行首整段加粗不应残留星号", () => {
		expect(stripMdBold("**注意** 这是重点")).toBe("注意 这是重点");
		expect(stripMdBold("**整行加粗**")).toBe("整行加粗");
	});
	it("非加粗行原样返回", () => {
		expect(stripMdBold("1. 普通题号")).toBe("1. 普通题号");
		expect(stripMdBold("答案：A")).toBe("答案：A");
	});
});

describe("SM-2 上下界", () => {
	const base = { interval: 0, repetitions: 0, easeFactor: DEFAULT_EASE_FACTOR, lapses: 0 };

	it("EF 不会超过 EASE_MAX（旧实现可涨到 7.5）", () => {
		let s = { ...base };
		for (let i = 0; i < 60; i++) s = sm2Update(s, 5);
		expect(s.easeFactor).toBeLessThanOrEqual(EASE_MAX);
	});

	it("间隔有硬上限，且反复评分不会算成 NaN 日期", () => {
		let s = { ...base };
		for (let i = 0; i < 60; i++) s = sm2Update(s, 5);
		expect(s.interval).toBeLessThanOrEqual(MAX_INTERVAL_DAYS);
		expect(s.interval).toBeGreaterThan(0);
		expect(s.nextReview).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(s.nextReview).not.toContain("NaN");
	});

	it("答错仍然重置并保住下限", () => {
		const r = sm2Update({ ...base, interval: 30, repetitions: 5, easeFactor: 1.4 }, 1);
		expect(r.repetitions).toBe(0);
		expect(r.interval).toBe(1);
		expect(r.lapses).toBe(1);
		expect(r.easeFactor).toBeGreaterThanOrEqual(EASE_MIN);
	});

	it("clampEase 结果恒在 [EASE_MIN, EASE_MAX] 内（非有限值退回默认）", () => {
		for (const n of [NaN, Infinity, -Infinity, -5, 0, 0.1, 1.3, 2.5, 3, 1e9]) {
			const v = clampEase(n);
			expect(v).toBeGreaterThanOrEqual(EASE_MIN);
			expect(v).toBeLessThanOrEqual(EASE_MAX);
		}
		expect(clampEase(NaN)).toBe(DEFAULT_EASE_FACTOR);
	});
});

describe("复习到期判定", () => {
	it("今天及更早到期", () => {
		expect(isDueForReview({ nextReview: todayStr() } as never)).toBe(true);
		expect(isDueForReview({ nextReview: "2000-01-01" } as never)).toBe(true);
	});
	it("未来日期不到期", () => {
		const d = new Date();
		d.setDate(d.getDate() + 5);
		const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		expect(isDueForReview({ nextReview: s } as never)).toBe(false);
	});
	it("nextReview 为空 = 尚未排期，按新条目立即到期（否则旧文件永久复习不到）", () => {
		expect(isDueForReview({ nextReview: "" } as never)).toBe(true);
		expect(isDueForReview({} as never)).toBe(true);
		expect(isDueForReview({ nextReview: undefined } as never)).toBe(true);
	});
	it("非法排期值（旧版 SM-2 写出的 NaN-NaN-NaN）也算到期，评一次分即自愈", () => {
		for (const bad of ["not-a-date", "NaN-NaN-NaN", "2026-9-1", "20260901"]) {
			expect(isDueForReview({ nextReview: bad } as never)).toBe(true);
		}
	});
});

// ============================================================
// toNote：把原先复制 6 遍的映射逻辑收敛成单一实现后的语义锁定
// 这里逐条对齐重构前的默认值，任何改动导致行为漂移都会失败。
// ============================================================

describe("toNote 默认值语义", () => {
	it("从完整 frontmatter 读出的字段原样保留", () => {
		const meta = {
			date: "2026-01-02",
			source: "[[来源]]",
			sourcePath: "a/b.md",
			tags: ["错题", "数学"],
			note: "备注",
			nextReview: "2026-02-01",
			interval: 12,
			correctCount: 4,
			wrongCount: 2,
			easeFactor: 2.4,
			repetitions: 3,
			lapses: 5,
		};
		const n = toNote(meta, "正文", "x/y.md", "y", WRONG_NOTE_DEFAULTS);
		expect(n.filePath).toBe("x/y.md");
		expect(n.baseName).toBe("y");
		expect(n.date).toBe("2026-01-02");
		expect(n.sourceFile).toBe("[[来源]]");
		expect(n.sourcePath).toBe("a/b.md");
		expect(n.tags).toEqual(["错题", "数学"]);
		expect(n.resultText).toBe("正文");
		expect(n.note).toBe("备注");
		expect(n.nextReview).toBe("2026-02-01");
		expect(n.interval).toBe(12);
		expect(n.correctCount).toBe(4);
		expect(n.wrongCount).toBe(2);
		expect(n.easeFactor).toBe(2.4);
		expect(n.repetitions).toBe(3);
		expect(n.lapses).toBe(5);
	});

	it("空 frontmatter 的兜底：错题本 wrongCount=1、interval=1、easeFactor=2.5、repetitions=0", () => {
		const n = toNote({}, "", "w.md", "w", WRONG_NOTE_DEFAULTS);
		expect(n.wrongCount).toBe(1);
		expect(n.interval).toBe(1);
		expect(n.easeFactor).toBe(2.5);
		expect(n.correctCount).toBe(0);
		expect(n.repetitions).toBe(0);
		expect(n.lapses).toBe(1);
		expect(n.tags).toEqual([]);
		expect(n.sourceFile).toBe("");
		expect(n.nextReview).toBe("");
	});

	it("题库 / 笔记默认 wrongCount=0（与错题本不同）", () => {
		expect(toNote({}, "", "q.md", "q", QUESTION_NOTE_DEFAULTS).wrongCount).toBe(0);
		expect(toNote({}, "", "n.md", "n", NOTE_VIEW_DEFAULTS).wrongCount).toBe(0);
	});

	it("笔记视图在 source 缺失时回退为文件名，其余两种留空", () => {
		expect(toNote({}, "", "n.md", "笔记甲", NOTE_VIEW_DEFAULTS).sourceFile).toBe("笔记甲");
		expect(toNote({}, "", "q.md", "题甲", QUESTION_NOTE_DEFAULTS).sourceFile).toBe("");
		expect(toNote({}, "", "w.md", "错甲", WRONG_NOTE_DEFAULTS).sourceFile).toBe("");
		// 有 source 时三种都以 frontmatter 为准
		expect(toNote({ source: "[[甲]]" }, "", "n.md", "笔记甲", NOTE_VIEW_DEFAULTS).sourceFile).toBe("[[甲]]");
	});

	it("repetitions 兜底为 min(correctCount, 3)", () => {
		expect(toNote({ correctCount: 1 }, "", "a.md", "a", WRONG_NOTE_DEFAULTS).repetitions).toBe(1);
		expect(toNote({ correctCount: 9 }, "", "a.md", "a", WRONG_NOTE_DEFAULTS).repetitions).toBe(3);
		// 显式给了 repetitions 就用显式值
		expect(toNote({ correctCount: 9, repetitions: 7 }, "", "a.md", "a", WRONG_NOTE_DEFAULTS).repetitions).toBe(7);
	});

	it("lapses 兜底：有 wrongCount 用 wrongCount，否则 1（三种扫描一致）", () => {
		expect(toNote({ wrongCount: 4 }, "", "a.md", "a", QUESTION_NOTE_DEFAULTS).lapses).toBe(4);
		expect(toNote({}, "", "a.md", "a", QUESTION_NOTE_DEFAULTS).lapses).toBe(1);
	});

	it("类型不符的值退回默认（字符串数字不当数字用）", () => {
		const n = toNote({ interval: "12", wrongCount: "2", easeFactor: null }, "", "a.md", "a", WRONG_NOTE_DEFAULTS);
		expect(n.interval).toBe(1);
		expect(n.wrongCount).toBe(1);
		expect(n.easeFactor).toBe(2.5);
	});
});

describe("electron remote 兜底（remote 缺失时不再抛 TypeError）", () => {
	afterEach(() => {
		vi.doUnmock("electron");
		vi.resetModules();
	});

	it("remote 缺失时 getElectronShell 返回 null，getElectronRemote 抛本地化错误", async () => {
		vi.resetModules();
		vi.doMock("electron", () => ({ remote: undefined, shell: undefined }));
		const mod = await import("../src/utils/electron");
		// 旧实现写的是 `[electronShell, remote.shell]`：数组字面量会先求值 remote.shell，
		// remote 缺失时直接抛 TypeError，兜底函数永远返回不了 null，trashFileAbs 也就走不到 .qg-trash。
		expect(mod.getElectronShell()).toBeNull();
		expect(mod.hasElectronRemote()).toBe(false);
		expect(() => mod.getElectronRemote()).toThrow(/electron remote/);
	});

	it("remote 存在但没有 shell 时同样返回 null（有可用的 shell 时优先用它）", async () => {
		vi.resetModules();
		const trashItem = () => Promise.resolve();
		vi.doMock("electron", () => ({ remote: { dialog: {} }, shell: { trashItem } }));
		const mod = await import("../src/utils/electron");
		expect(mod.hasElectronRemote()).toBe(true);
		expect(mod.getElectronShell()?.trashItem).toBe(trashItem);
	});
});

describe("重命名文件名清洗（renameListFile 的前置条件）", () => {
	it("safeName 抹掉路径分隔符，使拼出的路径无法越界", () => {
		expect(safeName("a/b")).toBe("a_b");
		expect(safeName("..\\..\\x")).toBe(".._.._x");
		expect(safeName("../../x")).toBe(".._.._x");
	});

	it("safeName 把纯 `..` 归一化为空串（调用方据此拒绝重命名）", () => {
		expect(safeName("..")).toBe("");
		expect(safeName(".")).toBe("");
		expect(safeName("   ")).toBe("");
	});

	it("正常名字与 .md 后缀处理不受影响", () => {
		expect(safeName("第一章 测试")).toBe("第一章 测试");
		expect(safeName("题目.md")).toBe("题目");
	});
});

describe("RTF / 文本编码（GBK 不再整篇乱码）", () => {
	it("按 \\ansicpg936 解码十六进制字节（你好 = GBK c4e3 bac3）", () => {
		expect(stripRtf("{\\rtf1\\ansi\\ansicpg936\\deff0 \\'c4\\'e3\\'ba\\'c3}")).toBe("你好");
	});

	it("无 ansicpg 时仍按 UTF-8 解码（保持旧行为）", () => {
		expect(stripRtf("\\'e4\\'bd\\'a0\\'e5\\'a5\\'bd")).toBe("你好");
	});

	it("ansicpg1252 + UTF-8 字节（畸形文件）仍能解出正确中文", () => {
		expect(stripRtf("{\\rtf1\\ansi\\ansicpg1252 \\'e4\\'bd\\'a0\\'e5\\'a5\\'bd}")).toBe("你好");
	});

	it("decodeTextBytes 剥离 UTF-8 BOM", () => {
		expect(decodeTextBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x62]))).toBe("ab");
	});

	it("decodeTextBytes 对非 UTF-8 字节回退到 GBK", () => {
		expect(decodeTextBytes(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]))).toBe("你好");
	});

	it("decodeTextBytes 保持 UTF-8 原文不变", () => {
		expect(decodeTextBytes(new TextEncoder().encode("你好 abc"))).toBe("你好 abc");
	});
});

describe("isAbs 支持 UNC 网络共享路径", () => {
	it("识别 UNC / 盘符 / 类 Unix 绝对路径，相对路径不误判", () => {
		expect(isAbs("\\\\server\\share\\a.md")).toBe(true);
		expect(isAbs("//server/share/a.md")).toBe(true);
		expect(isAbs("C://vault//a.md")).toBe(true);
		expect(isAbs("/home/u/a.md")).toBe(true);
		expect(isAbs("题目/a.md")).toBe(false);
		expect(isAbs("")).toBe(false);
	});
});

describe("joinApiUrl 归一化接口地址", () => {
	it("去掉首尾空白与末尾多余斜杠", () => {
		expect(joinApiUrl(" http://127.0.0.1:11434/ ", "/api/chat")).toBe("http://127.0.0.1:11434/api/chat");
		expect(joinApiUrl("http://x///", "/api/generate")).toBe("http://x/api/generate");
	});

	it("base 已带 /v1 时不重复拼出 /v1/v1", () => {
		expect(joinApiUrl("http://x/v1", "/v1/chat/completions")).toBe("http://x/v1/chat/completions");
		expect(joinApiUrl("http://x", "/v1/chat/completions")).toBe("http://x/v1/chat/completions");
	});

	it("path 没有前导斜杠时自动补上", () => {
		expect(joinApiUrl("http://x", "api/chat")).toBe("http://x/api/chat");
	});
});

describe("设置项 baseUrl 归一化", () => {
	const baseUrlItem = SETTING_SECTIONS.flatMap(s => s.items).find(i => i.key === "baseUrl") as SettingItem;

	it("schema 里给 baseUrl 标了 normalize: url", () => {
		expect(baseUrlItem.normalize).toBe("url");
	});

	it("clampSettingValue 去掉首尾空白与末尾斜杠", () => {
		expect(clampSettingValue(baseUrlItem, " http://127.0.0.1:11434/ ")).toBe("http://127.0.0.1:11434");
		expect(clampSettingValue(baseUrlItem, "http://x///")).toBe("http://x");
	});

	it("不擅自补协议（https 与内网域名都要保留原样）", () => {
		expect(clampSettingValue(baseUrlItem, "192.168.1.9:11434")).toBe("192.168.1.9:11434");
		expect(clampSettingValue(baseUrlItem, "https://api.example.com/v1")).toBe("https://api.example.com/v1");
	});
});

describe("上下文压缩（planCompression / buildRequestMessages / capMessages）", () => {
	/** 造 n 条消息：偶数下标是 user，奇数是 assistant。 */
	const mk = (n: number): ChatMessage[] => Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: "m" + i }) as ChatMessage);

	it("planCompression 保留末尾 keepRecent 条，其余交给摘要", () => {
		const plan = planCompression(mk(10), 4);
		expect(plan?.older.length).toBe(6);
		expect(plan?.kept.length).toBe(4);
		expect(plan?.kept[0]?.content).toBe("m6");
		expect(plan?.older[0]?.content).toBe("m0");
	});

	it("可压缩部分不足 2 条时返回 null（避免为 1 条消息发一次请求）", () => {
		expect(planCompression(mk(4), 4)).toBeNull();
		expect(planCompression(mk(5), 4)).toBeNull();
		expect(planCompression(mk(6), 4)?.older.length).toBe(2);
		expect(planCompression([], 4)).toBeNull();
	});

	it("buildRequestMessages 只取末尾 N 条普通消息，且不把 summary 字段带给模型", () => {
		const msgs: ChatMessage[] = [{ role: "assistant", content: "S", summary: true }, ...mk(30)];
		const out = buildRequestMessages(msgs, 10);
		expect(out.length).toBe(10);
		expect(out.some(m => m.content === "S")).toBe(false);
		expect(out[9]?.content).toBe("m29");
		expect(out.every(m => !("summary" in m))).toBe(true);
	});

	it("collectSummaries 按顺序汇总摘要正文，忽略空白摘要", () => {
		const msgs: ChatMessage[] = [
			{ role: "assistant", content: "S1", summary: true },
			{ role: "user", content: "q" },
			{ role: "assistant", content: "S2", summary: true },
			{ role: "assistant", content: "   ", summary: true },
		];
		expect(collectSummaries(msgs)).toEqual(["S1", "S2"]);
		expect(collectSummaries(mk(3))).toEqual([]);
	});

	it("capMessages 不淘汰摘要，否则压缩成果会被后续消息挤掉", () => {
		const msgs: ChatMessage[] = [{ role: "assistant", content: "S", summary: true }, ...mk(CHAT_HISTORY_LIMIT * 2 + 20)];
		const capped = capMessages(msgs);
		expect(capped.length).toBe(CHAT_HISTORY_LIMIT * 2);
		expect(capped[0]?.summary).toBe(true);
		expect(capped[0]?.content).toBe("S");
		// 末尾仍是最新消息
		expect(capped[capped.length - 1]?.content).toBe("m" + (CHAT_HISTORY_LIMIT * 2 + 19));
	});

	it("capMessages 未超限时原样返回（保持引用不变）", () => {
		const msgs = mk(10);
		expect(capMessages(msgs)).toBe(msgs);
	});
});
