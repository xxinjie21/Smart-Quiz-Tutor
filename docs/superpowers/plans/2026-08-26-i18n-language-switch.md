# 一键中英文切换（i18n）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Obsidian 插件 question-generator 添加设置页一键中英文切换：界面文案 + AI 提示词模板可切英文，出题语言跟随材料，历史数据不动。

**Architecture:** 新建 `src/i18n/`（`zh.ts`/`en.ts` 双字典 + `t()`/`tf()` 翻译函数），key 用中文原文；`PluginSettings` 新增 `language: "zh" | "en"`。阶段 1 替换 UI 文案（sidebarView/settingTab/main.ts/constants），阶段 2 替换 AI 提示词模板并给 `parse.ts`/`exporter.ts` 补英文解析分支。切换后重渲染视图，命令面板提示重启。

**Tech Stack:** TypeScript (ES2021, strict), vitest, esbuild, Obsidian API。

## Global Constraints

- **只在本地工作，不推送 GitHub**：不 commit push、不打 tag、不动 Release、不碰远程分支
- **零回归硬性要求**：中文模式 `t()` 返回原文，界面与改动前逐字一致；vitest 131+ 全通过、`tsc --noEmit` 零错误、`npm run lint` 无新增 error、`npm run build` 成功，全部通过才允许更新 `main.js`
- **不翻译的数据红线**（永远保持中文，不进字典）：`DEFAULT_SETTINGS` 文件夹名（`智学助手/题目/错题/笔记/知识点/识别试卷/md文件`）、`SYSTEM_TAGS`、`IndexSource` 类型值、`tags.ts` 停用词表、`layout.ts`/`exporter.ts` 解析正则关键词、`knowledgeService.ts` 的 `## 相关题目` 等索引结构、文件名模板（`_错题_`/`_试题_`/`_笔记_`/`AI识别`）
- **设置值不翻译**：只对 `setName`/`setDesc`/`setPlaceholder`/按钮文字调 `t()`，绝不翻译输入框 value（vault 真实文件夹名）
- 动态文案用 `tf(key, params)` 占位符，不用字符串拼接直译
- 提交信息用英文 Conventional Commits，加 `(local only)` 后缀
- 每个任务结束跑：`npm test`（若改动涉及被测代码）、`npx tsc --noEmit`、`npm run lint`

---

### Task 1: i18n 基础设施（字典 + t()/tf() + settings.language）

**Files:**
- Create: `src/i18n/index.ts`
- Create: `src/i18n/zh.ts`
- Create: `src/i18n/en.ts`
- Modify: `src/types.ts:44-71`（PluginSettings 加 `language`）
- Modify: `src/constants.ts:3-30`（DEFAULT_SETTINGS 加 `language: "zh"`）
- Modify: `src/main.ts`（`loadSettings` 后调用 `setLanguage`；导出 i18n API）
- Test: `tests/i18n.test.ts`（新建）

**Interfaces:**
- Produces: `t(key: string): string`、`tf(key: string, params: Record<string, string | number>): string`、`setLanguage(lang: "zh" | "en"): void`、`getLanguage(): "zh" | "en"`、`zh`/`en` 字典
- Consumes: 无（独立基础设施）

- [ ] **Step 1: 写失败测试** `tests/i18n.test.ts`

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/i18n.test.ts`
Expected: FAIL（`../src/i18n/index` 模块不存在）

- [ ] **Step 3: 创建 `src/i18n/zh.ts`**

```ts
// key = 中文原文；value 与 key 相同
export const zh = {
	"根文件夹": "根文件夹",
	"Root folder": "Root folder", // 占位防遗漏；实际按需填充
} as const;
```

**注意**：`zh` 字典随各任务逐步填充。**初始只放 Task 1 测试用到的 3 个 key**（"根文件夹"、"共 {n} 次学习活动"、"已选 {a} 个，共 {b} 个"），其余 key 由后续任务按需添加。

- [ ] **Step 4: 创建 `src/i18n/en.ts`**

```ts
import type { zh } from "./zh";

export const en: Record<keyof typeof zh, string> = {
	"根文件夹": "Root folder",
	"共 {n} 次学习活动": "{n} learning activities in total",
	"已选 {a} 个，共 {b} 个": "{a} selected, {b} in total",
};
```

- [ ] **Step 5: 创建 `src/i18n/index.ts`**

```ts
import { zh } from "./zh";
import { en } from "./en";

let current: "zh" | "en" = "zh";

export function setLanguage(lang: "zh" | "en") { current = lang; }
export function getLanguage(): "zh" | "en" { return current; }

export function t(key: string): string {
	if (current === "en") return en[key as keyof typeof en] ?? key;
	return zh[key as keyof typeof zh] ?? key;
}

export function tf(key: string, params: Record<string, string | number>): string {
	let s = t(key);
	for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
	return s;
}

export { zh, en };
```

- [ ] **Step 6: `types.ts` 加 `language` 字段**

在 `PluginSettings` 接口末尾（`knowledgeFolder: string;` 之后）加：

```ts
	language: "zh" | "en";
```

- [ ] **Step 7: `constants.ts` 默认值加 `language: "zh"`**

在 `DEFAULT_SETTINGS` 对象 `knowledgeFolder: "知识点",` 之后加：

```ts
	language: "zh",
```

- [ ] **Step 8: `main.ts` 集成 + 导出**

`loadSettings()` 方法末尾（`if (data?.history) this.history = data.history;` 之后）加：

```ts
		setLanguage(this.settings.language || "zh");
```

文件顶部 import 区加：

```ts
import { setLanguage } from "./i18n/index";
```

文件底部公共导出区（`export { ... } from "./constants";` 附近）加：

```ts
export { t, tf, setLanguage, getLanguage, zh, en } from "./i18n/index";
```

- [ ] **Step 9: 跑测试确认通过**

Run: `npx vitest run tests/i18n.test.ts`
Expected: PASS（4 describe 全绿）

- [ ] **Step 10: 全量验证 + 提交**

Run: `npm test` → 全部通过；`npx tsc --noEmit` → 零错误；`npm run lint` → 无新增 error

```bash
git add src/i18n src/types.ts src/constants.ts src/main.ts tests/i18n.test.ts
git commit -m "feat(i18n): add dictionary-based t()/tf() infrastructure (local only)"
```

---

### Task 2: 设置页语言下拉 + settingTab.ts 全量翻译

**Files:**
- Modify: `src/views/settingTab.ts`（全部 32 条 setName/setDesc/setPlaceholder 文案）
- Modify: `src/i18n/zh.ts` / `src/i18n/en.ts`（新增设置页 key）
- Test: `tests/i18n.test.ts`（追加：字典新增 key 后 en 覆盖断言仍成立）

**Interfaces:**
- Consumes: `t()`、`setLanguage()`、`getLanguage()`（Task 1）
- Produces: 设置页语言下拉（中文 / English），切换后调用 `setLanguage` + `saveSettings` + `this.display()`

- [ ] **Step 1: 在 `zh.ts`/`en.ts` 添加设置页 key**

`zh.ts` 追加（value 同 key）：

```ts
	"智学助手设置": "智学助手设置",
	"文件夹": "文件夹",
	"根文件夹下包含所有模块子文件夹，修改后需重启插件生效": "根文件夹下包含所有模块子文件夹，修改后需重启插件生效",
	"所有模块子文件夹的父目录": "所有模块子文件夹的父目录",
	"题目文件夹": "题目文件夹",
	"错题文件夹": "错题文件夹",
	"笔记文件夹": "笔记文件夹",
	"知识点文件夹": "知识点文件夹",
	"统一的知识点索引目录（与题目/笔记/错题同层），索引文件内含「相关题目/相关笔记/相关错题」三段": "统一的知识点索引目录（与题目/笔记/错题同层），索引文件内含「相关题目/相关笔记/相关错题」三段",
	"转换md文件夹": "转换md文件夹",
	"对非md文件（txt/rtf/docx/PDF/图片）生成题目或识别试卷时，把转换后的文本保存为md文件到这里，留空则关闭": "对非md文件（txt/rtf/docx/PDF/图片）生成题目或识别试卷时，把转换后的文本保存为md文件到这里，留空则关闭",
	"AI识别文件夹": "AI识别文件夹",
	"排除文件夹": "排除文件夹",
	"逗号分隔的文件夹名，扫描时跳过": "逗号分隔的文件夹名，扫描时跳过",
	"生成后自动保存到题库": "生成后自动保存到题库",
	"默认题目数量": "默认题目数量",
	"单选题": "单选题",
	"多选题": "多选题",
	"判断题": "判断题",
	"填空题": "填空题",
	"简答题": "简答题",
	"API 配置": "API 配置",
	"接口类型": "接口类型",
	"OpenAI兼容": "OpenAI兼容",
	"接口地址": "接口地址",
	"模型名称": "模型名称",
	"Temperature": "Temperature",
	"控制输出随机性，0-2，越低越确定": "控制输出随机性，0-2，越低越确定",
	"复习间隔设置": "复习间隔设置",
	"参数越大复习间隔越长，记忆越牢固但可能遗忘；参数越小复习越频繁，短期效果好但耗时多。推荐使用默认值。": "参数越大复习间隔越长，记忆越牢固但可能遗忘；参数越小复习越频繁，短期效果好但耗时多。推荐使用默认值。",
	"错题复习间隔（天）": "错题复习间隔（天）",
	"题目复习间隔（天）": "题目复习间隔（天）",
	"笔记复习间隔（天）": "笔记复习间隔（天）",
	"学习设置": "学习设置",
	"薄弱点阈值": "薄弱点阈值",
	"次以上错题标记为薄弱": "次以上错题标记为薄弱",
	"启动时提醒复习": "启动时提醒复习",
	"界面语言": "界面语言",
	"切换后界面文案即时生效；命令面板中的命令名需重启插件后更新": "切换后界面文案即时生效；命令面板中的命令名需重启插件后更新",
```

`en.ts` 追加（与 zh 同 key 集，注意**每个 key 都要有**，否则编译报错）：

```ts
	"智学助手设置": "Smart Quiz Tutor Settings",
	"文件夹": "Folders",
	"根文件夹下包含所有模块子文件夹，修改后需重启插件生效": "All module subfolders live under the root folder. Restart the plugin for changes to take effect.",
	"所有模块子文件夹的父目录": "Parent directory of all module subfolders",
	"题目文件夹": "Question folder",
	"错题文件夹": "Wrong answers folder",
	"笔记文件夹": "Notes folder",
	"知识点文件夹": "Knowledge point folder",
	"统一的知识点索引目录（与题目/笔记/错题同层），索引文件内含「相关题目/相关笔记/相关错题」三段": "Unified knowledge index directory (same level as questions/notes/wrong answers); each index file has sections for related questions/notes/wrong answers",
	"转换md文件夹": "Converted MD folder",
	"对非md文件（txt/rtf/docx/PDF/图片）生成题目或识别试卷时，把转换后的文本保存为md文件到这里，留空则关闭": "When generating questions or extracting exams from non-MD files (txt/rtf/docx/PDF/image), converted text is saved here as MD. Leave empty to disable.",
	"AI识别文件夹": "AI extraction folder",
	"排除文件夹": "Excluded folders",
	"逗号分隔的文件夹名，扫描时跳过": "Comma-separated folder names to skip during scanning",
	"生成后自动保存到题库": "Auto-save generated questions to the question bank",
	"默认题目数量": "Default question counts",
	"单选题": "Single choice",
	"多选题": "Multiple choice",
	"判断题": "True/False",
	"填空题": "Fill in the blank",
	"简答题": "Short answer",
	"API 配置": "API configuration",
	"接口类型": "API type",
	"OpenAI兼容": "OpenAI compatible",
	"接口地址": "API base URL",
	"模型名称": "Model name",
	"Temperature": "Temperature",
	"控制输出随机性，0-2，越低越确定": "Controls output randomness, 0-2; lower is more deterministic",
	"复习间隔设置": "Review interval settings",
	"参数越大复习间隔越长，记忆越牢固但可能遗忘；参数越小复习越频繁，短期效果好但耗时多。推荐使用默认值。": "Larger parameters mean longer review intervals (more durable memory but more forgetting); smaller parameters mean more frequent review (better short-term effect but time-consuming). Defaults are recommended.",
	"错题复习间隔（天）": "Wrong answers review interval (days)",
	"题目复习间隔（天）": "Questions review interval (days)",
	"笔记复习间隔（天）": "Notes review interval (days)",
	"学习设置": "Study settings",
	"薄弱点阈值": "Weak point threshold",
	"次以上错题标记为薄弱": "or more wrong answers marks a knowledge point as weak",
	"启动时提醒复习": "Remind to review on startup",
	"界面语言": "Interface language",
	"切换后界面文案即时生效；命令面板中的命令名需重启插件后更新": "UI text updates immediately; command palette names update after restarting the plugin",
```

- [ ] **Step 2: 翻译 `settingTab.ts`**

在文件顶部 import 区加 `import { t, setLanguage } from "../i18n/index";`

逐条替换（**只改 setName/setDesc/setPlaceholder/按钮 label，绝不改 `cb.setValue(...)` 和 `s.xxx` 的值**）。示例：

```ts
// 之前
new Setting(containerEl).setName("智学助手设置").setHeading();
// 之后
new Setting(containerEl).setName(t("智学助手设置")).setHeading();
```

```ts
// 之前
new Setting(containerEl)
	.setName("根文件夹")
	.setDesc("所有模块子文件夹的父目录")
	.addText(cb => cb.setPlaceholder("智学助手").setValue(s.rootFolder)...
// 之后
new Setting(containerEl)
	.setName(t("根文件夹"))
	.setDesc(t("所有模块子文件夹的父目录"))
	.addText(cb => cb.setPlaceholder("智学助手").setValue(s.rootFolder)...
```

**注意**：`setPlaceholder("智学助手")`/`setPlaceholder("笔记")`/`setPlaceholder("知识点")`/`setPlaceholder("题目/识别试卷")` 这些是**真实文件夹名占位符，不翻译**。`counts` 数组里的 `label: "单选题"` 等要翻（`label: t("单选题")`），但 `key: "countSingle"` 不动。`cb.addOption("ollama", "Ollama")` 的 "Ollama" 不动；`addOption("openai", "OpenAI兼容")` 的 label 翻。`INTERVAL_PRESETS` 的 label/hint 在 Task 3 处理（constants.ts），此处 `cfg.label` 数组里的文案要翻。

- [ ] **Step 3: 新增语言下拉（放在设置页最顶部，"智学助手设置"标题之前）**

```ts
		const langSetting = new Setting(containerEl)
			.setName(t("界面语言"))
			.setDesc(t("切换后界面文案即时生效；命令面板中的命令名需重启插件后更新"))
			.addDropdown(cb => {
				cb.addOption("zh", "中文").addOption("en", "English")
					.setValue(s.language)
					.onChange(async v => {
						const lang = v as "zh" | "en";
						s.language = lang;
						setLanguage(lang);
						await this.plugin.saveSettings();
						this.display();
					});
			});
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run tests/i18n.test.ts`
Expected: PASS（en 覆盖 zh 断言覆盖新 key）

- [ ] **Step 5: 验证 + 提交**

Run: `npx tsc --noEmit` → 零错误；`npm run lint` → 无新增 error；`npm test` → 全通过

```bash
git add src/views/settingTab.ts src/i18n
git commit -m "feat(i18n): translate settings tab and add language dropdown (local only)"
```

---

### Task 3: constants.ts 的 INTERVAL_PRESETS label/hint 翻译

**Files:**
- Modify: `src/constants.ts:40-56`（INTERVAL_PRESETS 的 label/hint）
- Modify: `src/i18n/zh.ts` / `src/i18n/en.ts`
- Test: `tests/i18n.test.ts`（en 覆盖断言自动涵盖新 key）

**Interfaces:**
- Consumes: `t()`（Task 1）
- Produces: 预设按钮 label 与 hint 的翻译

- [ ] **Step 1: 字典加 key（zh 追加，en 对应）**

```ts
	"慢速": "慢速",
	"标准": "标准",
	"快速": "快速",
	"复盘间隔长、执行省心，适合已初步掌握、仅需定期回顾的错题": "复盘间隔长、执行省心，适合已初步掌握、仅需定期回顾的错题",
	"考前日常训练主力方案，遗忘曲线与复习节奏平衡": "考前日常训练主力方案，遗忘曲线与复习节奏平衡",
	"前期隔天密集复盘，适合频繁出错的高频薄弱点": "前期隔天密集复盘，适合频繁出错的高频薄弱点",
	"适合基础扎实、掌握牢固、几乎不会遗忘的简单题目": "适合基础扎实、掌握牢固、几乎不会遗忘的简单题目",
	"覆盖范围广、周期适中，配合考研各阶段节奏": "覆盖范围广、周期适中，配合考研各阶段节奏",
	"加密前期间隔、反复强化，适合刚学完的重难点": "加密前期间隔、反复强化，适合刚学完的重难点",
	"长线缓释记忆，适合考研基础阶段按部就班的日常背诵": "长线缓释记忆，适合考研基础阶段按部就班的日常背诵",
	"中等密度、长线巩固，强化期系统性复习主力配置": "中等密度、长线巩固，强化期系统性复习主力配置",
	"考前冲刺专用，短期高频轰炸、以速度换覆盖": "考前冲刺专用，短期高频轰炸、以速度换覆盖",
```

`en.ts` 对应：

```ts
	"慢速": "Slow",
	"标准": "Standard",
	"快速": "Fast",
	"复盘间隔长、执行省心，适合已初步掌握、仅需定期回顾的错题": "Long intervals, low effort; for wrong answers you mostly know and only need periodic review",
	"考前日常训练主力方案，遗忘曲线与复习节奏平衡": "Main option for daily pre-exam practice; balances the forgetting curve with review pace",
	"前期隔天密集复盘，适合频繁出错的高频薄弱点": "Dense review every other day early on; for frequent weak points",
	"适合基础扎实、掌握牢固、几乎不会遗忘的简单题目": "For simple questions you know well and rarely forget",
	"覆盖范围广、周期适中，配合考研各阶段节奏": "Broad coverage, moderate cycles; fits each stage of exam prep",
	"加密前期间隔、反复强化，适合刚学完的重难点": "Tighter early intervals, repeated reinforcement; for newly learned difficult points",
	"长线缓释记忆，适合考研基础阶段按部就班的日常背诵": "Long-term gradual recall; steady daily memorization for the foundation stage",
	"中等密度、长线巩固，强化期系统性复习主力配置": "Medium density, long-term consolidation; main config for the intensive stage",
	"考前冲刺专用，短期高频轰炸、以速度换覆盖": "Pre-exam sprint: short high-frequency bursts, trading depth for coverage",
```

- [ ] **Step 2: `constants.ts` 改造**

`INTERVAL_PRESETS` 的 label/hint 目前是静态字符串。**方案**：把 `INTERVAL_PRESETS` 的 label/hint 改为函数调用 `t(...)`。但 `constants.ts` 目前不依赖 i18n——为保持单一职责，改为**在 `settingTab.ts` 渲染时翻译**：

`settingTab.ts` 的 intervalConfigs 循环里：

```ts
// 之前
const btn = btnDiv.createEl("button", { text: p.label, ...
// 之后
const btn = btnDiv.createEl("button", { text: t(p.label), ...
```

```ts
// 之前
.setDesc(activePreset.hint)
// 之后
.setDesc(t(activePreset.hint))
```

`INTERVAL_PRESETS` 的 `label`/`hint` 字段**保持中文原文**（作为 key 源），翻译在渲染时发生。这避免 constants.ts 引入 i18n 依赖，且零回归（中文模式 t 返回原文）。

**注意**：`constants.ts` 的 `DEFAULT_SETTINGS` 文件夹名和 `SYSTEM_TAGS` **绝不翻译**（红线）。

- [ ] **Step 3: 验证 + 提交**

Run: `npx tsc --noEmit`；`npm run lint`；`npm test`

```bash
git add src/constants.ts src/views/settingTab.ts src/i18n
git commit -m "feat(i18n): translate interval preset labels and hints (local only)"
```

---

### Task 4: sidebarView.ts 翻译——导航/首页/热力图区块

**Files:**
- Modify: `src/views/sidebarView.ts`（getDisplayText、render、renderHeatmap、renderHomeDefault：L116/147-156/317-490 区间）
- Modify: `src/i18n/zh.ts` / `src/i18n/en.ts`

**Interfaces:**
- Consumes: `t()`、`tf()`（Task 1）
- Produces: 导航 Tab、热力图、首页快捷操作卡片的翻译

- [ ] **Step 1: import**

文件顶部加 `import { t, tf } from "../i18n/index";`

- [ ] **Step 2: 逐条替换（示例）**

```ts
// getDisplayText (L116)
getDisplayText() { return t("智学助手"); }
```

```ts
// render() 导航 (L151-156)
navBtns["home"] = { label: t("首页"), icon: "home" };
navBtns["questions"] = { label: t("题目"), icon: "file-text" };
navBtns["notes"] = { label: t("笔记"), icon: "file-edit" };
navBtns["wrong"] = { label: t("错题"), icon: "book-x" };
navBtns["review"] = { label: t("复习"), icon: "calendar-check" };
navBtns["settings"] = { label: t("设置"), icon: "settings" };
```

```ts
// renderHeatmap 标题 (L317)
createEl("div", { text: t("学习热力图"), ...
```

**热力图动态文案（L335/381）用 tf：**

```ts
// 之前
`共 ${...} 次学习活动，${...} 天有记录`
// 之后
tf("共 {n} 次学习活动，{d} 天有记录", { n: totalCount, d: activeDays })
```

**月份标签（L367 "1月"…"12月"）**：这是**数据**（`getMonth()+1 + "月"` 生成），翻译方案：`tf("{m}月", { m: monthNum })`，en 字典 `"{m}月": "{m}"`（输出纯数字，符合英文习惯）。zh 字典 `"{m}月": "{m}月"`。

```ts
// 之前
`${month + 1}月`
// 之后
tf("{m}月", { m: month + 1 })
```

**" (今天)"（L384）** 用 `t(" (今天)")`，en 为 `" (today)"`。

**首页快捷操作卡片（L434-490）** 全部 setText 包 `t()`，含标题+副标题：

```ts
// 示例
itemBtn.setText(t("📝 选择文件生成题目"));
itemDesc.setText(t("让AI根据文档内容创作新题目存入题库"));
```

**动态文案**："今日待复习 {n} 题"（L455）、"还有 {n} 题..."（L471）用 `tf`。

- [ ] **Step 3: 字典补 key**

把本区块出现的所有中文字符串（含 emoji 前缀的完整文案）加进 `zh.ts`，对应翻译加进 `en.ts`（emoji 保留，如 `"📝 选择文件生成题目": "📝 Generate questions from files"`）。

- [ ] **Step 4: 验证 + 提交**

Run: `npx tsc --noEmit`；`npm run lint`；`npm test`

```bash
git add src/views/sidebarView.ts src/i18n
git commit -m "feat(i18n): translate sidebar nav, heatmap and home dashboard (local only)"
```

---

### Task 5: sidebarView.ts 翻译——题目/笔记 Tab 区块

**Files:**
- Modify: `src/views/sidebarView.ts`（renderQuestionsTab L514-725、renderNotesTab L727-901、renderNotePicker L903-968）
- Modify: `src/i18n/zh.ts` / `src/i18n/en.ts`

**Interfaces:**
- Consumes: `t()`、`tf()`
- Produces: 题目列表、笔记列表、笔记选择器的翻译

- [ ] **Step 1: 逐条替换**

**共性文案**（两 Tab 都有）用同一个 key：

```ts
t("请在设置中配置题目文件夹") / t("请在设置中配置笔记文件夹")
t("默认") / t("按源文件") / t("按知识点") / t("按时间")
t("暂无题目文件") / t("暂无笔记文件")
t("搜索文件名...")
t("打开") / t("删除") / t("生成笔记") / t("导出")
t("未分类")
t("全选") / t("取消全选")
```

**动态文案用 tf**：

```ts
// 之前 "题目 " + n
tf("{label} {n}", { label: t("题目"), n: count })
// 之前 "知识点 " + n
tf("{label} {n}", { label: t("知识点"), n: count })
```

**批量导出按钮（L569/794）**：`t("题目批量导出")` / `t("笔记批量导出")`。

**重命名/删除确认（L636-658）**：

```ts
// 之前 "确定删除题目文件「" + name + "」？"
tf("确定删除题目文件「{name}」？", { name })
// 之前 "输入新文件名（不含扩展号）："
t("输入新文件名（不含扩展号）：")
// Notice
t("已重命名") / tf("重命名失败：{msg}", { msg }) / t("已删除") / tf("删除失败：{msg}", { msg })
```

**导出成功 Notice（L624-630）**：`t("Word已保存")`/`t("PDF已保存")`/`t("Md已保存")`。

**笔记选择器（renderNotePicker L904-962）**：

```ts
t("← 返回笔记列表")
t("选择要加入笔记库的文件")
tf("共 {a} 个文档，已选 {b} 个", { a, b })
t("创建笔记 (0个)")  // 或统一 tf("创建笔记 ({n}个)", { n: 0 })
t("请至少选择一个文件")
tf("已创建 {n} 个笔记", { n })
```

**注意**：`_笔记_`（L951-962）是**文件名模板，不翻译**（红线）。

- [ ] **Step 2: 字典补 key**

本区块所有文案加 zh/en 字典。

- [ ] **Step 3: 验证 + 提交**

Run: `npx tsc --noEmit`；`npm run lint`；`npm test`

```bash
git add src/views/sidebarView.ts src/i18n
git commit -m "feat(i18n): translate questions and notes tabs (local only)"
```

---

### Task 6: sidebarView.ts 翻译——错题 Tab 区块

**Files:**
- Modify: `src/views/sidebarView.ts`（renderWrongList L1000-1111、renderWrongNoteItem L1113-1161、renderWrongDetail L1163-1212、wrongDeleteNote/wrongRePracticeSingle/wrongRePracticeDue/wrongExportNote L1214-1287、renderAdminBatchBar L1295-1379、wrongUpdateScheduling L1382-1393）
- Modify: `src/i18n/zh.ts` / `src/i18n/en.ts`

**Interfaces:**
- Consumes: `t()`、`tf()`
- Produces: 错题列表、错题详情、批量操作栏的翻译

- [ ] **Step 1: 逐条替换（要点）**

```ts
// 列表头
tf("{label} {n}", { label: t("错题"), n: count })
tf("{label} {n}", { label: t("待复习"), n: count })
tf("开始今日复习 ({n}题)", { n })
t("错题批量导出")
tf("确定删除选中的 {n} 个错题记录？此操作不可撤销。", { n })
tf("已删除 {n} 个错题记录", { n })
t("暂无错题记录")
```

```ts
// 列表项（renderWrongNoteItem）
tf("找不到文件：{name}", { name })
t("已到期") / tf("{d}天后", { d })
t("生成笔记")
t("确定从错题本移除？")
```

```ts
// 详情（renderWrongDetail）
t("← 返回列表")
tf("加入时间：{d}", { d })
tf("备注：{n}", { n })
t("查看错题文件") / t("找不到错题文件")
t("开始答题") / t("无题目内容")
t("基于原文重新生成")
t("导出MD") / t("导出Word") / t("导出PDF") / t("删除")
t("已到复习时间") / tf("下次复习: {d}", { d }) / t("未设置")
tf("间隔: {i}天　答对{c}次　答错{w}次", { i, c, w })
t("判断对错：") / t("✓ 正确") / t("✗ 错误")
```

```ts
// 操作（wrong* 方法）
t("确定删除这条错题记录？此操作不可撤销。")
t("已删除") / t("源文件不存在")
t("今日待复习题目") / t("没有可用的源文件")
t("Md文件已保存") / t("Word文件已保存") / t("PDF文件已保存")
tf("导出失败：{msg}", { msg })
```

```ts
// 批量栏（renderAdminBatchBar）
t("批量") / t("全选") / t("取消全选") / t("删除") / t("导出")
tf("删除 ({n})", { n }) / tf("导出 ({n})", { n })
tf("确定删除选中的 {n} 个文件？此操作不可撤销。", { n })
tf("已删除 {n} 个文件", { n })
t("所选文件均无法读取") / tf("已导出 {n} 个文件", { n })
t("文件不存在")
```

```ts
// 复习调度反馈（wrongUpdateScheduling）
tf("正确！下次复习 {d}（间隔{i}天）", { d, i })
t("已记录错误，明天复习")
tf("更新复习计划失败：{msg}", { msg })
```

**注意**：`wrongExportNote` 里 `\n\n> 来源：` 和 `　|　日期：` 是**导出文件头格式**（数据），保持中文不动。

- [ ] **Step 2: 字典补 key**

- [ ] **Step 3: 验证 + 提交**

Run: `npx tsc --noEmit`；`npm run lint`；`npm test`

```bash
git add src/views/sidebarView.ts src/i18n
git commit -m "feat(i18n): translate wrong answers tab (local only)"
```

---

### Task 7: sidebarView.ts 翻译——复习 Tab 区块

**Files:**
- Modify: `src/views/sidebarView.ts`（renderReviewTab L1395-1482、renderReviewRow L1484-1530）
- Modify: `src/i18n/zh.ts` / `src/i18n/en.ts`

**Interfaces:**
- Consumes: `t()`、`tf()`
- Produces: 复习 Tab 筛选、列表、操作反馈翻译

- [ ] **Step 1: 逐条替换**

```ts
t("全部") / t("错题") / t("题目") / t("笔记")
t("默认") / t("按源文件") / t("按知识点") / t("按时间")
t("今日暂无待复习内容，继续学习积累吧！")
tf("今日待复习 {n} 项", { n })
tf("错题 {n}", { n }) / tf("题目 {n}", { n }) / tf("笔记 {n}", { n })
t("无标签")
t("已到期") / tf("{d}天后", { d })
t("✓ 完成") / t("✗ 仍错")
tf("已标记完成！下次复习 {d}（间隔{i}天）", { d, i })
t("已记录错误，明天复习")
tf("更新复习计划失败：{msg}", { msg })
```

**注意**：`renderReviewRow` 的 `sourceLabel`/`sourceColor` map 用的是 `IndexSource` 值（`错题/题目/笔记`）作 key —— 这是**数据 key，保持中文**，但**显示 label 翻译**：

```ts
// 之前（如果 label 直接用 source 值）
// 之后：显示时映射翻译
const sourceDisplay = source === "错题" ? t("错题") : source === "题目" ? t("题目") : t("笔记");
```

- [ ] **Step 2: 字典补 key**

- [ ] **Step 3: 验证 + 提交**

Run: `npx tsc --noEmit`；`npm run lint`；`npm test`

```bash
git add src/views/sidebarView.ts src/i18n
git commit -m "feat(i18n): translate review tab (local only)"
```

---

### Task 8: sidebarView.ts 翻译——设置 Tab + 文件选择器区块

**Files:**
- Modify: `src/views/sidebarView.ts`（renderSettingsTab L1532-1643、renderFilePicker L1645-1714、generateFromCurrentFile/generateFromSelected/selectInfoText/fileSizeInfo L1716-1756）
- Modify: `src/i18n/zh.ts` / `src/i18n/en.ts`

**Interfaces:**
- Consumes: `t()`、`tf()`
- Produces: 侧边栏设置页、文件选择器翻译

- [ ] **Step 1: 逐条替换**

`renderSettingsTab` 与 `settingTab.ts` 有大量重复文案（"文件夹"/"根文件夹"/"题目文件夹"等）——**复用 Task 2 已建 key**，不重复添加。

```ts
t("文件夹") / t("根文件夹") / t("题目文件夹") / t("错题文件夹") / t("笔记文件夹") / t("知识点文件夹")
t("转换md文件夹") / t("AI识别文件夹") / t("排除文件夹") / t("生成后自动保存到题库")
t("默认题目数量") / t("单选题") / t("多选题") / t("判断题") / t("填空题") / t("简答题")
t("API 配置") / t("接口类型") / t("OpenAI兼容") / t("接口地址") / t("模型名称") / t("Temperature")
t("复习间隔设置") / t("错题复习间隔（天）") / t("题目复习间隔（天）") / t("笔记复习间隔（天）")
t("自定义：") / t("如 1,2,4,7,15,30")
t("学习设置") / t("薄弱点阈值") / tf("{n}次以上错题标记为薄弱", { n }) / t("启动时提醒复习")
```

**预期目录结构（L1568）**：这是**说明性 UI 文案**，翻译但保留目录名（目录名是数据）：

```ts
// 之前
"预期目录结构：\n根文件夹/\n├─ 题目/（含 识别试卷/）\n├─ 错题/\n├─ 笔记/\n├─ 知识点/（统一索引，含相关题目/相关笔记/相关错题三段）\n└─ md文件/"
// 之后
t("预期目录结构：\n根文件夹/\n├─ 题目/（含 识别试卷/）\n├─ 错题/\n├─ 笔记/\n├─ 知识点/（统一索引，含相关题目/相关笔记/相关错题三段）\n└─ md文件/")
```

en 翻译保留中文目录名：`"Expected structure:\nroot/\n├─ 题目/ (incl. 识别试卷/)\n├─ 错题/\n├─ 笔记/\n├─ 知识点/ (unified index...)\n└─ md文件/"`。

**输入框 placeholder（"智学助手"/"笔记"/"知识点"/"题目/识别试卷"/"md文件"）不翻译**（真实文件夹名）。

**文件选择器（renderFilePicker）**：

```ts
t("← 返回") / t("生成题目")
t("选择vault中的文档，AI根据内容生成各类题目，生成后保存到题库")
t("当前文件") / t("从文件夹选择")
t("请先打开一个文档（md/txt/rtf/docx/pdf/图片）")
tf("当前文件：{name}", { name })
t("📝 基于当前文件生成题目")
t("搜索文件名...")
tf("📝 生成题目（{n}个）", { n })
t("请至少选择一个文件") / t("清空选择") / t("全选") / t("取消全选")
t("请打开一个支持的文档（md/txt/rtf/docx/PDF/图片）")
t("未能读取文件内容")
t("所选文件均无法读取内容") / tf("{n}个文档", { n })
tf("已选≈{n}", { n })
tf("共 {a} 个文档，已选 {b} 个", { a, b })
tf("大小：{size}KB　预估Token：≈{tokens}", { size, tokens })
```

- [ ] **Step 2: 字典补 key**（注意与 Task 2 key 合并，不重复）

- [ ] **Step 3: 验证 + 提交**

Run: `npx tsc --noEmit`；`npm run lint`；`npm test`

```bash
git add src/views/sidebarView.ts src/i18n
git commit -m "feat(i18n): translate sidebar settings and file picker (local only)"
```

---

### Task 9: sidebarView.ts 翻译——AI 识别/标签/笔记生成区块

**Files:**
- Modify: `src/views/sidebarView.ts`（renderExamBrowser L1837-1920、extractFromExamSelected L1962-2098、callAIWithPrompt L2111-2145、examSourceToText L2147-2163、aiSuggestTags L2181-2191、renderTaggerView L2202-2283、runAITagging L2285-2338、renderNoteGenView L2340-2487、renderNoteGenPreview L2490-2528、noteSourceToText L2547-2558、noteGen* L2560-2684）
- Modify: `src/i18n/zh.ts` / `src/i18n/en.ts`

**Interfaces:**
- Consumes: `t()`、`tf()`
- Produces: 试卷识别、标签、笔记生成的 UI 翻译（提示词部分留到 Task 11）

- [ ] **Step 1: 逐条替换（UI 部分）**

**识别浏览器（renderExamBrowser）**：

```ts
t("← 返回") / t("AI 识别试卷")
t("选择vault中的文档，AI自动识别并提取其中的题目，保存后进入答题模式")
t("AI 正在识别题目...") / t("⏹ 停止")
t("当前文件") / t("从文件夹选择")
t("请先打开一个试卷文件（md/txt/rtf/docx/pdf/图片）")
tf("当前文件：{name}", { name })
t("📄 识别当前文件") / t("搜索文件名...")
tf("🔍 AI 识别题目（{n}个）", { n })
t("请至少选择一个文件") / t("清空选择") / t("全选") / t("取消全选")
```

**识别流程（extractFromExamSelected）**——**注意**：`题目/识别试卷`（L1972）是**文件夹名数据不翻译**；`试卷`/`AI识别`（L2033/2038）是 **frontmatter 标签值，不翻译**（红线）；`_AI识别.md` 是文件名模板不翻译。UI 文案：

```ts
tf("准备识别 {n} 个文件...", { n })
tf("正在识别 ({n})", { n })
tf("正在识别 ({n})（内容较长，分{m}段识别）...", { n, m })
tf("正在识别 ({n}) - 第{m}段...", { n, m })
t("识别超时（3分钟）") / t("已中止")
t("所有文件均未能识别出题目")
tf("识别完成，共 {n} 题，已保存至 {path}", { n, path })
tf("识别完成，共 {n} 题，已保存 {m} 个文件", { n, m })
t("个识别试卷")
```

**callAIWithPrompt（L2121/2126）**：`t("已中止")` / `t("请求超时（3分钟）")`。

**examSourceToText（L2151-2152）**：**这两条是发给 AI 的提示词**（"（试卷图片已随请求提供，请识别图片中的全部内容并提取所有题目）"/"图片识别：请确认当前模型支持多模态（视觉）能力"）——**留到 Task 11 提示词翻译**，本任务不动。

**标签视图（renderTaggerView）**：

```ts
t("← 返回") / t("AI添加标签")
t("AI识别文档中的知识点，自动写入frontmatter，用于Obsidian知识图谱")
t("当前文件") / t("从文件夹选择")
t("请先打开一个Markdown文件")
tf("当前文件：{name}", { name })
t("处理中...") / t("🤖 开始识别标签")
t("⏹ 停止") / t("搜索文件名...")
tf("🤖 开始识别标签（{n}个）", { n })
t("清空选择") / t("全选") / t("取消全选")
```

**runAITagging**：

```ts
tf("准备处理 {n} 个文件...", { n })
tf("正在识别 ({n})", { n })
tf("完成！成功 {a} 个，失败 {b} 个", { a, b })
tf("AI标签已中止：{msg}", { msg })
tf("AI标签完成：成功 {a} ，失败 {b}", { a, b })
```

**笔记生成视图（renderNoteGenView）**：

```ts
t("← 返回")
t("🤖 正在批量生成笔记...")
t("点击停止可中断，已完成的笔记会被保留")
t("⏹ 停止") / t("🤖 AI生成笔记")
t("AI按原文结构浓缩生成知识点笔记（标题序号原样保留、正文精华缩写），自动识别标签并存入笔记库")
t("当前文件") / t("文件/文档") / t("题目") / t("错题") / t("现有笔记")
t("请先打开一个文档（md/txt/rtf/docx/pdf/图片）")
tf("当前文件：{name}", { name })
t("🤖 基于当前文件生成笔记")
t("未能读取文件内容")
tf("🤖 生成笔记（{n}篇）", { n })
t("清空选择")
t("暂无错题记录")
tf("共 {a} 条错题，已选 {b} 条", { a, b })
t("搜索文件名...") / t("全选") / t("取消全选")
```

**预览（renderNoteGenPreview）**：

```ts
t("🤖 正在生成笔记...")
tf("根据「{name}」生成中，请稍候", { name })
t("⏹ 停止") / t("生成预览")
tf("来源：{name}", { name })
t("内容（可编辑）：")
t("知识点标签（可编辑）：")
t("标签之间用逗号分隔")
t("保存后文件名：")
t("保存到笔记库") / t("重新生成") / t("取消返回")
```

**注意**：`AI笔记`/`_笔记_日期.md`（L2511）是文件名模板不翻译；`_笔记_`（L2669-2678）不翻译。

**noteGen 方法**：

```ts
t("内容为空，无法生成笔记")
t("笔记生成失败：AI返回内容为空")
t("已中止") / tf("笔记生成失败：{msg}", { msg })
t("找不到所选内容")
tf("内容为空，已跳过：{name}", { name })
tf("生成失败：{msg}", { msg })
tf("笔记生成中：{name}（成功 {a} ，失败 {b}）", { name, a, b })
tf("已中止：成功 {a} ，失败 {b}", { a, b })
tf("笔记生成完成：成功 {a} ，失败 {b}", { a, b })
t("内容为空，无法保存") / t("笔记已保存")
t("请先在设置中配置笔记文件夹")
tf("保存失败：{msg}", { msg })
```

**noteSourceToText（L2550-2551）**：**AI 提示词，留到 Task 11**。

- [ ] **Step 2: 字典补 key**

- [ ] **Step 3: 验证 + 提交**

Run: `npx tsc --noEmit`；`npm run lint`；`npm test`

```bash
git add src/views/sidebarView.ts src/i18n
git commit -m "feat(i18n): translate exam extraction, tagging and note generation UIs (local only)"
```

---

### Task 10: sidebarView.ts 翻译——知识点管理/生成/答题/历史区块

**Files:**
- Modify: `src/views/sidebarView.ts`（renderKnowledgeManager L2785-2951、renderGenerateView L2964-3038、genStartGenerate/genRunGenerate L3040-3100、genRenderResult L3102-3131、genSaveToVault L3134-3163、genExport* L3165-3214、generateFromWeakPoints L3216-3235、renderAnswerView L3250-3314、answerSubmit L3316-3487、answerSaveWrongToBook L3490-3539、openLinkedFile L3541-3552、renderHistoryView L3567-3604、openCurrentFileExtract L3615-3694、KnowledgeDeleteConfirmModal L3738-3782）
- Modify: `src/i18n/zh.ts` / `src/i18n/en.ts`

**Interfaces:**
- Consumes: `t()`、`tf()`
- Produces: 知识点管理、生成、答题、历史、模态框翻译（提示词部分留到 Task 11）

- [ ] **Step 1: 逐条替换（要点）**

**知识点管理（renderKnowledgeManager）**：

```ts
t("← 返回") / t("知识点管理")
t("可多选/全选，删除会同时删除知识点索引文件")
t("搜索知识点...") / t("刷新") / t("全选")
tf("已选 {n} 个", { n }) / t("删除选中")
tf("共 {n} 个知识点", { n })
tf("已删除 {n} 处知识点索引文件", { n })
tf("共 {a} 个知识点，筛选出 {b} 个", { a, b })
t("未找到匹配的知识点") / t("暂无知识点索引文件")
t("题目索引") / t("笔记索引") / t("错题索引")
t("0 处索引") / tf("索引文件：{path}", { path })
t("……（点击下方查看索引条目）")
t("🡕 查看索引条目") / t("加载中...")
t("该知识点暂无关联条目")
tf("关联条目（{n}）", { n })
tf("打开：{name}", { name })
```

**注意**：`indexFileSections` 的 `## 相关题目` 等（L2746-2748）是**索引文件结构，不翻译**；`题目索引/笔记索引/错题索引` 是**section 显示名**——它们对应 `## 相关题目` 解析，翻译只改显示不改 key（见 Task 7 的 sourceDisplay 模式）。

**生成视图（renderGenerateView/gen*）**：

```ts
t("← 返回") / t("题目设置") / tf("当前文档：{name}", { name })
tf("清洗后字符数：{n}", { n }) / tf("预估Token：{n}", { n })
t("⚠️ 内容较长，建议分段生成题目")
t("单选题") / t("多选题") / t("判断题") / t("填空题") / t("简答题")
tf("题型：{types} {n}题", { types, n })
t("知识点标签（逗号分隔）：")
t("例如：微积分, 导数")
t("生成后自动保存到题库")
t("开始生成") / t("请至少选择一种题型且数量大于0")
t("← 返回设置") / t("⏳ 正在生成试题...")
t("预计需要 10-60 秒") / t("⏹ 中止")
t("已中止") / t("已获取的内容已保留")
t("正在生成中，请等待完成")
t("接口返回内容为空，请检查模型名称和接口地址配置是否正确。")
t("✅ 生成完成")
tf("共解析出 {n} 题（客观题 {m} 题）", { n, m })
t("⚠️ 请检查AI输出格式")
t("⚠️ 已中止")
t("本次生成已停止，未保存任何内容")
t("请求超时（3分钟）")
t("❌ 生成失败")
tf("接口调用失败：{msg}", { msg })
t("\n\n请检查：\n1. 接口地址\n2. API服务是否运行\n3. 模型名称")
t("生成结果") / t("导出MD") / t("导出Word") / t("导出PDF") / t("无答案版")
t("保存到知识库") / t("开始答题") / t("请先生成试题")
```

**注意**：`genRunGenerate` 的 `你是一个出题助手，严格按照指定格式输出题目。`（L3072）是**AI 提示词，留到 Task 11**。

**导出（genExport*）**：

```ts
t("还没有生成试题内容")
t("Md已保存") / t("Word已保存") / t("PDF已保存")
tf("导出失败：{msg}", { msg })
t("无答案版已保存")
```

**注意**：`_试题_`/`_试题.md`/`_试题_无答案.md` 文件名模板不翻译；`配套试题`/`配套试题（无答案版）` 是**导出文档标题，翻译**（作为文档内容的 UI 产物，属可翻范围）；`\n\n> 来源：`/`　|　日期：` 保持中文不动（导出格式）。

**薄弱点生成（generateFromWeakPoints）**：`暂无薄弱知识点数据`/`没有可用的源文件` 翻译；`【出题要求 - 请重点关注以下薄弱知识点】...`（L3232）是**AI 提示词，留到 Task 11**；`薄弱点定向生成` 翻译。

**答题视图（renderAnswerView/answerSubmit）**：

```ts
t("← 返回")
t("未能解析出可答题的题目。")
t("单选") / t("多选") / t("判断") / t("填空") / t("简答")
tf("共 {n} 题：", { n })
tf("第 {n} 题", { n })
t("(仅参考)") / t("填写答案...") / t("输入你的答案...")
t("提交答卷") / t("← 重新答题")
tf("{n} 分", { n })
tf("客观题 {n} 题：正确 {c} / 错误 {w}", { n, c, w })
t("主观题 {n} 题：请对照参考答案自查")
t("勾选要加入错题本的题目：")
t("全选") / t("取消全选")
t("客观题详情") / t("✓ 正确") / t("✗ 错误")
t("参考答案") / t("考点解析") / t("主观题参考答案")
tf("你的答案：{a}", { a })
t("加入错题本")
t("知识点标签（可编辑）：")
t("AI识别中，点击“加入错题本”后自动识别")
tf("备注：{n}", { n })
t("例如：第3、7题做错了")
t("确认加入") / t("请先勾选要加入错题本的题目")
t("AI识别知识点中...") / t("返回首页")
```

**注意**：`answerSaveWrongToBook` 里写入文件的题型名（L3492 `单选题`等）和 `答案`/`解析`（L3510-3511）、`错题`（L3516，frontmatter 标签）、`_错题_` 文件名、`答题模式加入（{n}题错误）` 里的内容——**写入文件的题型名和标签是数据，不翻译**；但 UI 上 `tf("已自动将 {n} 道错题加入错题本", { n })` 和 `tf("加入错题本失败：{msg}", { msg })` 翻译。写入文件时使用**中文题型名常量**（保留原 `QUESTION_TYPE_CN` 逻辑，不接 t()）。

**历史（renderHistoryView）**：

```ts
t("← 返回") / t("生成历史记录") / t("暂无生成历史") / t("清空历史")
tf("来源：{s}", { s })
```

**识别当前文件（openCurrentFileExtract）**：

```ts
t("请打开一个支持的试卷文件（md/txt/rtf/docx/pdf/图片）")
tf("正在识别当前文件 {name}", { name })
t("未能读取文件内容")
tf("正在识别当前文件 {name} - 第{m}段...", { name, m })
t("未能识别出题目")
tf("识别完成，共 {n} 题，已保存至 {path}", { n, path })
t("已中止") / tf("识别失败：{msg}", { msg })
```

**注意**：`题目/识别试卷`（L3621）文件夹名、`试卷`/`AI识别` 标签、`_AI识别.md` 文件名模板不翻译。

**模态框（KnowledgeDeleteConfirmModal L3754-3767）**：

```ts
tf("删除选中的 {n} 个索引文件", { n })
tf("删除知识点： {name}", { name })
t("将删除以下知识点： ")
tf("将同时删除以下 {n} 个索引文件：", { n })
t("此操作不可恢复，是否继续？")
t("取消") / t("删除")
```

- [ ] **Step 2: 字典补 key**

- [ ] **Step 3: 验证 + 提交**

Run: `npx tsc --noEmit`；`npm run lint`；`npm test`

```bash
git add src/views/sidebarView.ts src/i18n
git commit -m "feat(i18n): translate knowledge manager, generation, answering and history (local only)"
```

---

### Task 11: 阶段 2——AI 提示词模板翻译

**Files:**
- Modify: `src/services/questionService.ts`（buildGeneratePrompt/buildExamExtractPrompt 的模板字符串、QUESTION_FORMAT_RULES）
- Modify: `src/services/noteService.ts`（buildNotePrompt）
- Modify: `src/services/knowledgeService.ts`（buildTaggingPrompt）
- Modify: `src/services/documentService.ts`（转换提示词，若有）
- Modify: `src/views/sidebarView.ts`（examSourceToText L2151-2152、noteSourceToText L2550-2551、genRunGenerate L3072、generateFromWeakPoints L3232 的提示词片段）
- Modify: `src/i18n/zh.ts` / `src/i18n/en.ts`
- Test: `tests/i18n.test.ts` 追加：提示词模板 key 覆盖断言（若模板太长可只断言关键片段）

**Interfaces:**
- Consumes: `t()`、`getLanguage()`
- Produces: 双语 AI 提示词模板（en 模式下英文模板 + "语言与材料一致"规则）

- [ ] **Step 1: 设计提示词翻译方案**

提示词模板**不能简单包 t()**（模板是长文本且含变量拼接）。方案：**按语言选择模板函数**，在 `src/i18n/` 下新建 `src/i18n/prompts.ts`：

```ts
import { getLanguage } from "./index";

export function promptQaIntro(): string {
	return getLanguage() === "en"
		? "You are a professional question writer. Generate questions strictly in the required format."
		: "你是一个出题助手，严格按照指定格式输出题目。";
}
```

每个提示词片段一个函数（或一个 `PROMPTS` 对象含 zh/en 两套模板），服务层调用时用 `promptXxx()` 获取。

**关键规则**：英文模板中**必须包含语言规则**：
> "Use the same language as the source material (Chinese material → Chinese questions)."

**注意**：`QUESTION_FORMAT_RULES` 中的格式要求（`## 题型名称`、`答案：`、`解析：`、`**1.**`）是**解析器依赖的结构**。英文模板中格式标签用英文（`## Question Type`、`Answer:`、`Explanation:`），且 `parse.ts` 需支持英文（Task 12 处理）。**中文模板完全保持原样**（零回归）。

- [ ] **Step 2: 翻译 `questionService.ts`**

`buildGeneratePrompt`/`buildExamExtractPrompt` 改为：

```ts
// 之前：模板字符串直接拼
// 之后：
const prompt = getLanguage() === "en" ? buildGeneratePromptEn(...) : buildGeneratePromptZh(...);
```

把现有中文模板抽为 `buildGeneratePromptZh`（原逻辑不变），新增 `buildGeneratePromptEn`（英文版 + 语言规则）。`QUESTION_FORMAT_RULES` 同理拆 zh/en 两套常量。

- [ ] **Step 3: 翻译 `noteService.ts`**

`buildNotePrompt` 拆 zh/en。英文版保留 "language matches material" 规则（对应中文版第 2 条"语言与材料一致"）。

- [ ] **Step 4: 翻译 `knowledgeService.ts` 的 `buildTaggingPrompt`**

拆 zh/en。英文版标签规则对应翻译，保留"禁止使用题目/笔记/错题等通用词"的约束（英文版写对应的英文通用词列表）。

- [ ] **Step 5: 翻译 sidebarView 内的提示词片段**

`examSourceToText`/`noteSourceToText`/`genRunGenerate`/`generateFromWeakPoints` 中的提示词字符串改用 `getLanguage()` 分支或 `t()`（若短）。

- [ ] **Step 6: 测试**

在 `tests/i18n.test.ts` 追加：

```ts
import { buildGeneratePrompt } from "../src/main";
import { setLanguage } from "../src/i18n/index";

describe("提示词模板双语", () => {
	it("zh 模式生成中文提示词（与旧版一致）", () => {
		setLanguage("zh");
		const p = buildGeneratePrompt("材料", { single: 1, multi: 0, judge: 0, blank: 0, essay: 0 }, []);
		expect(p).toContain("出题助手");
	});
	it("en 模式生成英文提示词且含语言规则", () => {
		setLanguage("en");
		const p = buildGeneratePrompt("material", { single: 1, multi: 0, judge: 0, blank: 0, essay: 0 }, []);
		expect(p).toContain("same language as the source material");
	});
});
```

（签名以实际 `buildGeneratePrompt` 为准——先在 `src/services/questionService.ts` 确认签名再写测试）

- [ ] **Step 7: 验证 + 提交**

Run: `npx vitest run tests/i18n.test.ts tests/utils.test.ts`；`npx tsc --noEmit`；`npm run lint`；`npm test`

```bash
git add src/services src/views/sidebarView.ts src/i18n tests/i18n.test.ts
git commit -m "feat(i18n): bilingual AI prompt templates with material-language rule (local only)"
```

---

### Task 12: 阶段 2 附带——parse.ts 英文解析兼容

**Files:**
- Modify: `src/utils/parse.ts`（EXAM_SECTION_NAMES、答案汇总匹配、题干前缀、标准答案）
- Test: `tests/parse-en.test.ts`（新建）

**Interfaces:**
- Consumes: 无（纯函数）
- Produces: `parseQuestions` 同时识别中英文格式（**只增不减**，中文路径零变化）

- [ ] **Step 1: 写失败测试** `tests/parse-en.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { parseQuestions } from "../src/main";

describe("parseQuestions 英文题解析", () => {
	it("解析英文单选题（Answer:/Explanation:）", () => {
		const text = [
			"## Single Choice",
			"**1.** What is 2+2?",
			"A. 3", "B. 4", "C. 5", "D. 6",
			"Answer: B",
			"Explanation: Basic arithmetic.",
		].join("\n");
		const qs = parseQuestions(text);
		expect(qs.length).toBe(1);
		expect(qs[0]!.type).toBe("single");
		expect(qs[0]!.answer).toBe("B");
	});
	it("解析英文判断题（True/False）", () => {
		const text = [
			"## True/False",
			"**1.** The sky is blue.",
			"A. True", "B. False",
			"Answer: A",
		].join("\n");
		const qs = parseQuestions(text);
		expect(qs[0]!.type).toBe("judge");
	});
	it("解析英文答案汇总块（Answer Summary）", () => {
		const text = [
			"**1.** Question one",
			"A. x", "B. y",
			"Answer Summary",
			"1. B",
		].join("\n");
		const qs = parseQuestions(text);
		expect(qs.length).toBe(1);
		expect(qs[0]!.answer).toBe("B");
	});
	it("中文题解析不受影响（回归）", () => {
		const text = [
			"## 单选题",
			"**1.** 2+2等于几？",
			"A. 3", "B. 4",
			"答案：B",
			"解析：基础算术。",
		].join("\n");
		const qs = parseQuestions(text);
		expect(qs.length).toBe(1);
		expect(qs[0]!.type).toBe("single");
		expect(qs[0]!.answer).toBe("B");
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/parse-en.test.ts`
Expected: 英文用例 FAIL，中文回归用例 PASS

- [ ] **Step 3: 实现英文兼容（只增不减）**

```ts
// EXAM_SECTION_NAMES 追加英文题型名
const EXAM_SECTION_NAMES = new Set([
	"单选题", "多选题", "判断题", "填空题", "简答题", "名词解释", "论述题",
	"计算题", "综合题", "问答题", "案例分析题", "案例分析", "解答题", "材料题", "改错题",
	"Single Choice", "Multiple Choice", "True/False", "True or False", "Fill in the Blank",
	"Short Answer", "Essay", "Term Explanation", "Discussion", "Calculation", "Case Analysis",
	"Comprehensive", "Question", "Error Correction",
]);
```

```ts
// "答案 汇总" 块匹配（L26/37）：追加英文
// 之前 /答案\s*汇总[：:\s]*\n/ → 之后 /(?:答案\s*汇总|Answer\s*Summary)[：:\s]*\n/i
// 行判断 /^\s*答案\s*汇总[：:\s]*$/ → /^\s*(?:答案\s*汇总|Answer\s*Summary)[：:\s]*$/i
```

```ts
// 题干前缀（L127）：追加英文
// 之前 /^(?:题干|题目|问题|试题)[：:]\s*/i
// 之后 /^(?:题干|题目|问题|试题|Question|Stem)[：:]\s*/i
```

```ts
// 标准答案/参考答案（L180）：已有 Answer 分支覆盖字母答案，补充文本答案
// 之前 /^(?:标准)?(?:答案|参考答案)[：:]\s*(.*)$/
// 之后 /^(?:标准)?(?:答案|参考答案|Answer|Reference Answer)[：:]\s*(.*)$/i
```

**注意**：`(?:标准)?(?:答案|正确答案|Answer)[：:\s]*([A-D]+)`（L160）已含 Answer，不动。所有改动**只追加英文分支，不删除/修改任何中文匹配**。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/parse-en.test.ts`
Expected: 4 个用例全 PASS

- [ ] **Step 5: 全量回归 + 提交**

Run: `npm test`；`npx tsc --noEmit`；`npm run lint`

```bash
git add src/utils/parse.ts tests/parse-en.test.ts
git commit -m "feat(i18n): add English parsing support to parseQuestions (local only)"
```

---

### Task 13: 阶段 2 附带——exporter.ts 英文导出解析兼容

**Files:**
- Modify: `src/utils/exporter.ts`（EXAM_ANSWER_LINE、EXAM_EXPLAIN_LINE 正则）
- Test: `tests/parse-en.test.ts` 追加导出解析用例

**Interfaces:**
- Consumes: 无
- Produces: `parseExamBlocks` 识别英文 `Answer:`/`Explanation:` 标签

- [ ] **Step 1: 追加测试**

```ts
describe("parseExamBlocks 英文标签", () => {
	it("识别英文 Answer:/Explanation:", () => {
		const text = "**1.** Question\nA. x\nB. y\n**Answer:**\nB\n**Explanation:**\nBecause.";
		const blocks = parseExamBlocks(text);
		expect(blocks.length).toBeGreaterThan(0);
		const labels = blocks.map(b => b.type);
		expect(labels).toContain("answer");
		expect(labels).toContain("explain");
	});
});
```

（`parseExamBlocks` 的实际 block type 值先查 `src/utils/exporter.ts` 再写断言）

- [ ] **Step 2: 实现（只增不减）**

```ts
// EXAM_ANSWER_LINE：追加英文
const EXAM_ANSWER_LINE = /^(?:\*\*)?(?:答案|标准答案|参考答案|Answer|Reference Answer)(?:\*\*)?[：:]/i;
// EXAM_EXPLAIN_LINE：追加英文
const EXAM_EXPLAIN_LINE = /^(?:\*\*)?(?:解析|Explanation)(?:\*\*)?[：:]/i;
```

`buildWordParagraphs` 里的 `解析` 标签匹配（`EXAM_EXPLAIN_LINE` 用的）同步追加英文。**中文匹配逻辑不动**。

- [ ] **Step 3: 跑测试 + 验证 + 提交**

Run: `npx vitest run tests/parse-en.test.ts`；`npm test`；`npx tsc --noEmit`；`npm run lint`

```bash
git add src/utils/exporter.ts tests/parse-en.test.ts
git commit -m "feat(i18n): add English label support to exam export parsing (local only)"
```

---

### Task 14: 最终验证门禁（零回归验收）

**Files:**
- Modify: 无（仅验证）

- [ ] **Step 1: 全量验证**

Run:
- `npm test` → 全部通过（131+ 原有 + 新增 i18n/parse-en）
- `npx tsc --noEmit` → 零错误
- `npm run lint` → 无 error
- `npm run build` → 构建成功，`main.js` 更新

- [ ] **Step 2: 验证 main.js 无动态 script（保持 Obsidian 审核合规）**

Run: `Select-String -Path main.js -Pattern 'createElement\("script"' | Measure-Object` → 0 处

- [ ] **Step 3: 构建产物同步到本地 Obsidian vault（可选，用户要求才做）**

若用户要求同步：复制 `main.js`/`styles.css`/`manifest.json` 到 `D:/ZISHIKU/AI/.obsidian/plugins/question-generator/` 并 `cmp` 校验。

- [ ] **Step 4: 手动验证清单（Obsidian 内）**

- 中文模式：各 Tab、设置页、文件选择器、识别、答题、复习界面与改动前**逐字一致**
- 设置页切 English：界面变英文；命令面板命令名提示重启
- 切回中文：界面恢复中文
- 中文材料出题：题目仍中文（语言跟随材料）
- 历史错题/笔记/题目文件：内容未被改动
- 导出 MD/Word/PDF：正常

- [ ] **Step 5: 提交最终状态**

```bash
git add -A
git commit -m "chore(i18n): finalize bilingual language switch, all verification passing (local only)"
```

**不推送 GitHub、不打 tag、不动 Release**。

---

## Self-Review 记录（写完计划后自查）

- **Spec 覆盖**：§3 架构（Task 1）、§4 阶段1 UI（Task 2-10）、§4 阶段2 提示词（Task 11）、§4 parse/exporter 英文兼容（Task 12-13）、§5 切换流程（Task 2 语言下拉 + 重启提示）、§6 测试（各任务测试 + Task 1 字典断言）、§8 零回归（Task 14 门禁 + 各任务红线）、§9 YAGNI（无历史数据翻译、无 i18next、无系统跟随）✅
- **占位符扫描**：Task 2/4-10 的翻译 key 已列出实际字符串清单；Task 11 提示词模板仅给出结构示例（完整模板过长，实现时从现有代码抽取），测试断言给了关键片段。Task 12-13 给出实际正则改动 ✅
- **类型一致性**：`t(key)`/`tf(key, params)` 签名全计划一致；`buildGeneratePrompt` 测试签名标注"以实际为准"——实现时先读源文件确认 ✅
