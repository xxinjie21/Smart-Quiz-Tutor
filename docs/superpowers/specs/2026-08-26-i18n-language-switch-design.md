# 设计文档：一键中英文切换（i18n）

> 日期：2026-08-26
> 项目：question-generator（智学助手 / Smart Quiz Tutor，Obsidian 插件）
> 状态：已批准，待实现
> 约束：**仅在本地工作，不推送 GitHub**（不 commit push、不打 tag、不动 Release）

## 1. 背景与目标

插件目前**没有任何 i18n 基础设施**，全部文案硬编码中文。

### 1.1 字符串分类（审查修正版，替代初稿统计）

初稿按"中文字符串数量"粗略统计为 ~1139 条，**经逐文件核实后必须重新分类**——其中相当一部分是**数据/解析逻辑，绝对不能翻译**：

| 类别 | 位置 | 性质 | 是否可翻译 |
|---|---|---|---|
| **UI 文案** | `sidebarView.ts`（~710 条中的 UI 部分）、`settingTab.ts`（32）、`main.ts`（命令名/Notice/菜单）、`constants.ts` 的 `INTERVAL_PRESETS.label/hint` | 界面显示 | ✅ 翻译 |
| **AI 提示词** | `questionService.ts`（出题/识别提示词）、`noteService.ts`（笔记提示词）、`knowledgeService.ts` 的 `buildTaggingPrompt`、`documentService.ts` | 发给 LLM 的指令 | ✅ 翻译（阶段 2） |
| **停用词表** | `tags.ts` 的 `STOP_WORDS`/`CN_STOP`（221 条） | **知识点标签提取的算法数据** | ❌ **绝不翻译**（翻译即破坏中文标签提取） |
| **解析正则关键词** | `layout.ts`（`答案汇总`/`标准答案`/`参考答案`/`解析`/`补充说明`/中文数字表）、`exporter.ts`（`EXAM_ANSWER_LINE` 等）、`parse.ts` 的 `EXAM_SECTION_NAMES` | **解析 AI 输出/导出文档的匹配词** | ❌ **绝不翻译**（翻译即解析失效） |
| **写入文件的数据结构** | `knowledgeService.ts` 的 `## 相关题目/相关笔记/相关错题`、`IndexSource` 类型值（`题目/笔记/错题`）、`constants.ts` 的 `SYSTEM_TAGS`、`DEFAULT_SETTINGS` 文件夹名（`智学助手/题目/错题/笔记/知识点`） | **vault 内实际文件夹名、frontmatter 标签值、索引文件结构** | ❌ **绝不翻译**（翻译即数据错乱、找不到文件、索引解析失败） |

**关键红线（零回归的根基）**：
- `DEFAULT_SETTINGS` 的文件夹名（`questionFolder: "题目"` 等）是**用户在 vault 里真实创建的文件夹名**，翻译会导致插件查找路径失败
- `SYSTEM_TAGS = ["错题","题目","笔记"]` 写入 frontmatter，翻译会破坏数据结构
- `IndexSource = "题目"|"笔记"|"错题"` 既是类型又是数据，翻译会破坏知识索引解析
- `knowledgeService.ts` 的 `## 相关题目` 等是**索引文件的实际内容结构**，`parseIndexSections` 依赖它，翻译后旧索引文件解析失败

**结论**：真正可翻译的字符串约为 **UI ~700 条 + 提示词 ~60 条**，远少于初稿的 1139 条。工作量重心在 `sidebarView.ts`。

目标：在设置页提供 **一键中英文切换**，切换后界面文案即时变为英文。

## 2. 已确认的需求决策（用户拍板）

| 决策点 | 结论 |
|---|---|
| 切换范围 | **界面 + AI 出题都切**（提示词模板也翻译成英文） |
| 出题语言 | **跟随材料语言**：提示词模板翻译成英文，但保留"语言与材料一致"规则（`noteService.ts:40`），中文材料仍出中文题 |
| 触发方式 | **设置页手动切换**（下拉：中文 / English） |
| 历史数据 | **不动**：已有错题、复习记录、题目文件保持中文原样，不批量翻译 |
| 工作约束 | 只在本地工作，不推送 GitHub |

## 3. 架构设计

### 3.1 文件结构

```
src/
├── i18n/
│   ├── index.ts      # t() 翻译函数、setLanguage()、当前语言管理
│   ├── zh.ts         # 中文字典（key = 中文原文）
│   └── en.ts         # 英文字典（key 与 zh 完全一致）
├── types.ts          # PluginSettings 新增 language: "zh" | "en"
├── constants.ts      # DEFAULT_SETTINGS 新增 language: "zh"
```

### 3.2 核心设计：中文原文当 key

不用扁平英文 key（如 `"settings.folder"`），而是**直接用中文原文当 key**：

```ts
// zh.ts
export const zh = {
  "智学助手设置": "智学助手设置",
  "根文件夹": "根文件夹",
  // ...
} as const;

// en.ts
export const en: Record<keyof typeof zh, string> = {
  "智学助手设置": "Smart Quiz Tutor Settings",
  "根文件夹": "Root folder",
  // ...
};
```

**理由**：
- 改造时无需为每个字符串起英文 key 名，直接把代码里的中文字符串包进 `t("原文")` 即可，机械性高
- 字典缺失的 key 自动回退显示中文原文，界面永不空白
- `en` 用 `Record<keyof typeof zh, string>` 类型约束，漏翻一个 key 编译报错

### 3.3 翻译函数

```ts
let current: "zh" | "en" = "zh";

export function setLanguage(lang: "zh" | "en") { current = lang; }
export function getLanguage(): "zh" | "en" { return current; }

export function t(key: string): string {
  if (current === "en") return en[key as keyof typeof en] ?? key;
  return zh[key as keyof typeof zh] ?? key;
}
```

回退机制：漏翻的 key 直接返回原文（中文），保证零空白。

### 3.4 动态文案与拼接

动态文案（含变量）用模板字符串包装：

```ts
// 之前
new Notice("已迁移 " + migrated + " 条旧错题到 " + folder);
// 之后
new Notice(t("已迁移 {n} 条旧错题到 {folder}").replace("{n}", String(migrated)).replace("{folder}", folder));
```

约定：动态文案用 `{name}` 占位符 + `.replace()` 填充，不用 sprintf 库（保持零依赖）。

## 4. 分两阶段实现

### 阶段 1：UI 文案（界面可见的全部）

- `sidebarView.ts` 中 UI 部分（按钮、标签、Tab 名、提示、空状态）
- `settingTab.ts` 全部（32 条，仅标签/描述/占位符；**输入框 value 不翻**）
- `main.ts`（命令名、Notice、右键菜单项、Ribbon tooltip、快捷键提示）
- `constants.ts` 中仅 `INTERVAL_PRESETS` 的 `label`/`hint`（界面文案）
- **不翻**：`DEFAULT_SETTINGS` 文件夹名、`SYSTEM_TAGS`（数据，§1.1 红线）

### 阶段 2：AI 提示词模板

- `questionService.ts`（出题/识别提示词）、`noteService.ts`（笔记提示词）、`knowledgeService.ts` 的 `buildTaggingPrompt`、`documentService.ts` 中的提示词
- **关键**：英文模板中保留"语言与材料一致"规则（对应 `noteService.ts:40`），中文材料出中文题
- **注意**：阶段 2 只翻译**发给 LLM 的提示词指令**。`layout.ts`/`exporter.ts`/`parse.ts` 的解析关键词和 `tags.ts` 停用词表**保持中文不动**（见 §1.1 红线）

### 阶段 2 的提示词细节

英文提示词模板中必须显式包含语言规则，例如：
> "Use the same language as the source material (Chinese material → Chinese questions)."

这样即使界面是英文，AI 也会根据材料语言出题，符合用户决策。

### 阶段 2 附带：`parse.ts` 英文解析兼容（必要）

由于英文材料会出英文题（英文格式标签），而**历史中文题 + 新英文题并存**，`parse.ts` 必须能同时解析两种语言。目前**部分**支持英文（已含 `Answer` / `Explanation` / `True` / `False`），缺口如下，必须补齐：

| 位置 | 现状 | 需要补 |
|---|---|---|
| `EXAM_SECTION_NAMES`（L16-19） | 仅中文题型名 | 加英文：Single/Multiple Choice、True/False、Fill-in-the-blank、Short answer、Essay、Case analysis 等 |
| "答案 汇总" 块（L26/37） | 仅中文 | 加 `Answer Summary` |
| 题干前缀（L127） | 仅"题干/题目/问题/试题" | 加 `Question:` / `Stem:` |
| "标准答案/参考答案"（L180） | 中文 | 加 `Answer:`（已部分覆盖） |

**注意**：解析器**不依赖界面语言**，永远双语工作（`zh` 或 `en` 界面下都能解析中英文题）。**只增不减**：只新增英文分支，不改任何现有中文匹配逻辑。

### 阶段 2 附带（补充审查发现）：`exporter.ts` 导出解析

`exporter.ts` 的 `EXAM_ANSWER_LINE`/`EXAM_EXPLAIN_LINE`（匹配 `答案/标准答案/参考答案/解析`）用于 docx/pdf 导出时识别答案与解析块。**英文题的导出**需要同样识别英文标签（`Answer:`/`Explanation:`）。此为正则扩展，**只增不减**，不影响中文导出。

## 5. 切换流程

1. 设置页新增 **"界面语言 / Language"** 下拉（中文 / English）
2. 切换 → `setLanguage()` → 保存 settings → 重新渲染当前视图（`display()` / `render()`）
3. `addCommand` 的命令名和 Ribbon tooltip 在 Obsidian 中**无法热更新**（命令面板有缓存）→ 切换后弹 Notice 提示"重启插件后命令面板生效"，界面其余部分即时生效

## 6. 测试策略

| 测试 | 内容 |
|---|---|
| 字典完整性 | `en` 必须覆盖 `zh` 所有 key（类型层面已强制，另加运行时断言测试） |
| `t()` 回退 | 缺失 key 返回原文；`zh` 模式返回原文 |
| 动态文案 | 占位符替换正确 |
| 回归 | 语言为中文时界面与现状完全一致（key 即原文，零回归） |

## 7. 风险与规避

| 风险 | 规避 |
|---|---|
| `sidebarView.ts` 3783 行改动面大 | 替换模式统一（`"文案"` → `t("文案")`），机械性高；按区块分批替换 |
| 提示词翻译改变 AI 行为 | 保留"与材料一致"规则；切换英文时仅模板语言变化，出题语言规则不变 |
| 命令面板缓存 | 明确提示重启插件 |
| 动态拼接漏翻 | 占位符约定 + 字典完整性测试 |
| **一词多义**（审查发现） | 同一中文原文在不同上下文可能需不同翻译（如"题目"在文件夹名 vs 操作动词）。**规避**：字典 key 允许上下文后缀（`"题目~folder"` / `"题目~action"`），`zh` 中后缀 key 值与原文相同，`en` 中按语境翻译；无歧义的直接用原文作 key |
| **设置值误翻**（审查发现） | 设置页 `setName`/`setDesc`/`placeholder` 可翻译，但**输入框的 value（如 `s.questionFolder` 的 "题目"）是 vault 真实文件夹名，绝对不能翻译**。实现时只对标签文案调 `t()`，绝不翻译 settings 值 |
| **数据常量误翻**（审查发现） | `SYSTEM_TAGS`、`DEFAULT_SETTINGS` 文件夹名、`IndexSource`、`buildIndexBody` 的 `## 相关题目` 等是数据/文件结构，**保持中文不动**，不进入字典（§1.1 红线） |

## 8. 零回归硬性要求（用户强调，不可妥协）

本次改动**绝不能影响插件的现有使用**。具体保障措施：

1. **中文模式逐字一致**：语言为 `zh` 时，`t()` 返回的就是中文原文（key 即原文），界面显示与改动前**逐字相同**，无任何可见差异
2. **全量验证门禁**：只有以下全部通过，才允许更新构建产物 `main.js`：
   - `npm run build` 成功
   - `npm test`（vitest 131 项）全通过
   - `npx tsc --noEmit` 零错误
   - `npm run lint` 无新增 error
   - E2E 79/79 通过（若可运行）
3. **业务流程不变**：出题、识别试卷、答题、复习、错题本、导出等所有功能在中文模式下行为与现在完全一致；英文模式只改变文案，不改变逻辑
4. **解析器只增不减**：`parse.ts` 只**新增**英文识别分支，**不改动**任何现有中文匹配逻辑，保证历史中文题解析路径零变化
5. **不碰数据**：不修改任何设置默认值（除新增 `language` 字段外）、不迁移/改写任何已存笔记、错题、题目文件
6. **手动验证**：本地 Obsidian vault 加载新 `main.js` 后，中文模式逐项核对主要功能可用；确认无误后再切英文验证
7. **回滚保障**：若验证中发现任何回归，立即回退到改动前的 `main.js`（构建产物在验证通过前不覆盖）

## 9. 不做的事（YAGNI）

- 不做历史数据批量翻译
- 不引入 i18next 等第三方库（保持零依赖，Obsidian 审核友好）
- 不做跟随系统语言自动切换（用户选了手动）
- 不推送 GitHub、不打 tag、不动 Release

## 10. 验证方式

- `npm run build` 本地构建成功
- `npm test`（vitest）全通过
- `npx tsc --noEmit` 零错误
- `npm run lint` 无新增 error
- 手动验证：Obsidian 本地 vault 加载新 main.js，切英文 → 界面变英文；切回中文 → 与现状一致
