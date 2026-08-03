import { describe, it, expect } from "vitest";
import { stripRtf, htmlToMarkdown } from "../src/main";

describe("stripRtf", () => {
	it("decodes signed unicode escapes (Chinese)", () => {
		// 汉 = U+6C49 = 27721, stored as \u-37815
		expect(stripRtf("\\u-37815\\'3f")).toBe("汉");
	});

	it("decodes utf-8 hex byte escapes", () => {
		// 你好 in UTF-8 bytes
		expect(stripRtf("\\'e4\\'bd\\'a0\\'e5\\'a5\\'bd")).toBe("你好");
	});

	it("keeps plain ascii", () => {
		expect(stripRtf("Hello RTF")).toBe("Hello RTF");
	});

	it("maps par and tab", () => {
		expect(stripRtf("a\\par b\\tab c")).toBe("a\nb\tc");
	});

	it("skips font table and generator destinations", () => {
		const rtf = "{\\fonttbl{\\f0 Times New Roman;}}{\\*\\generator Msftedit 5.41}Hello";
		expect(stripRtf(rtf)).toBe("Hello");
	});

	it("decodes em dash and quotes", () => {
		expect(stripRtf("\\emdash\\lquote hi\\rquote")).toBe("—‘hi’");
	});

	it("handles literal escaped backslash and braces", () => {
		expect(stripRtf("a\\\\b \\{c\\}")).toBe("a\\b {c}");
	});

	it("collapses excess blank lines", () => {
		expect(stripRtf("a\\par\\par\\par\\par b")).toBe("a\n\nb");
	});

	it("strips formatting control words but keeps text", () => {
		// 控制字后的空格是分隔符会被吞掉，字面空格需写成 \  转义
		expect(stripRtf("{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Arial;}}Hello\\b\\ world}")).toBe("Hello world");
	});
});

describe("htmlToMarkdown", () => {
	it("skips empty bookmark anchors (Word TOC bookmarks)", () => {
		const html = "<p><a id=\"_Toc1\"></a><a id=\"_Toc2\"></a><strong>面向中医电子病历</strong></p>";
		expect(htmlToMarkdown(html)).toBe("**面向中医电子病历**");
	});

	it("converts a standalone Word TOC link to plain text without page numbers", () => {
		const html = "<p>正文 <a href=\"#_Toc15920\">1 引言\t2</a> 结束</p>";
		expect(htmlToMarkdown(html)).toBe("正文 1 引言 结束");
	});

	it("nests an unordered list between two ordered lists under the last item", () => {
		const html = "<ol><li>事前质控</li><li>事中质控</li></ol><ul><li>规则一</li><li>规则二</li></ul><ol><li>终末质控</li><li>区分合规数据</li></ol>";
		expect(htmlToMarkdown(html)).toBe("1. 事前质控\n2. 事中质控\n\n    - 规则一\n    - 规则二\n\n3. 终末质控\n4. 区分合规数据");
	});

	it("keeps separate ordered lists numbered independently when split by a heading", () => {
		const html = "<ol><li>第一</li></ol><h3>小结</h3><ol><li>第二</li></ol>";
		expect(htmlToMarkdown(html)).toBe("1. 第一\n\n### 小结\n\n1. 第二");
	});

	it("indents br line breaks inside a list item to keep the list continuous", () => {
		const html = "<ol><li>数据管理员（核心数据操作角色）<br />输入操作：上传病历<br />输出操作：导出数据集</li><li>病历审核人员</li></ol>";
		expect(htmlToMarkdown(html)).toBe("1. 数据管理员（核心数据操作角色）\n   输入操作：上传病历\n   输出操作：导出数据集\n2. 病历审核人员");
	});

	it("indents br line breaks inside a nested bullet item", () => {
		const html = "<ol><li>事前质控</li></ol><ul><li>必填项完整性规则：缺失则标记异常<br />系统仅实现固定规则校验。</li></ul><ol><li>终末质控</li></ol>";
		expect(htmlToMarkdown(html)).toBe("1. 事前质控\n\n    - 必填项完整性规则：缺失则标记异常\n      系统仅实现固定规则校验。\n\n2. 终末质控");
	});

	it("drops the whole Word TOC block including the 目录 heading", () => {
		const html = "<p><a id=\"_Toc1\"></a><strong>报告标题</strong></p><p><a id=\"heading_0\"></a>目录</p><p><a href=\"#_Toc15920\">1 引言\t2</a></p><p><a href=\"#_Toc2824\">1.1 项目背景\t2</a></p><p><a id=\"_Toc2\"></a><strong>1 引言</strong></p><p>正文内容</p>";
		expect(htmlToMarkdown(html)).toBe("**报告标题**\n\n**1 引言**\n\n正文内容");
	});
});
