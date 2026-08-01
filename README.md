<div align="center">

# Smart Question Tutor

**AI-powered, spaced-repetition study plugin for Obsidian**

[![Obsidian](https://img.shields.io/badge/Obsidian-1.12.0+-483699?style=flat-square&logo=obsidian)](https://obsidian.md)
[![Release](https://img.shields.io/github/v/release/xxinjie21/Smart-Quiz-Tutor?style=flat-square&include_prereleases&label=release)](https://github.com/xxinjie21/Smart-Quiz-Tutor/releases)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg?style=flat-square&logo=typescript)](https://www.typescriptlang.org)
[![AI](https://img.shields.io/badge/AI-Ollama%20%7C%20OpenAI-brightgreen.svg?style=flat-square)](https://ollama.com)

**English** | [中文](#中文文档)

</div>

---

<details open>
<summary><b>English</b></summary>

## Features

### AI Question Generation
- Auto-generate quizzes from any Markdown notes using AI (5 question types: single choice, multiple choice, true/false, fill-in-the-blank, short answer)
- Supports **Ollama** (local), **OpenAI-compatible APIs** (DeepSeek, Claude, etc.)
- AI auto-extracts knowledge tags and writes `[[wikilinks]]` for Obsidian graph view
- Multi-file batch selection, sort by topic or date

### Full Exam Recognition
- Extract all questions from a complete exam paper or question bank via AI, preserving original formatting
- Large file chunking (15,000 chars per chunk, 2,000 overlap) to avoid truncation
- Retains existing answers; AI fills in missing ones

### Answering Mode
- Select any question file or a just-generated result to start answering instantly
- Real-time grading with correct answers and explanations
- Objective questions auto-scored; subjective questions manually markable as correct/wrong

### Wrong Answer Book (SM-2 Spaced Repetition)
- Correct → interval increases; Wrong → resets to 1 day
- Three presets: **Slow / Standard / Fast**, covering every stage of exam preparation
- Wrong answers include `[[knowledge tags]]`, synced to knowledge folders, visible in graph view
- Automatic review reminders on plugin startup

### Study Notes
- Create study notes from any Markdown file with AI-generated summaries and knowledge points
- Notes are also part of the spaced repetition review system
- Search, filter, and export supported

### Review Dashboard
- Unified view of all due review items (wrong answers + questions + notes), sorted by priority
- One-click "Done" button per item to advance to the next review cycle
- Sort by source file, knowledge tag, or date

### Learning Heatmap
- GitHub-style annual contribution graph showing learning activity
- Color intensity scales by activity count (1-2 / 3-5 / 6-9 / 10+)

### Knowledge Graph
- Separate knowledge folders per module (questions / notes / wrong answers)
- Auto-generated MOC (Map of Content) index notes
- `[[wikilinks]]` at the end of every question and wrong answer for seamless Obsidian graph integration

### Export
- Export to **Markdown**, **Word (.docx)**, or **PDF**
- Answer-free version available for self-testing

---

## Repository

**GitHub:** https://github.com/xxinjie21/Smart-Quiz-Tutor

---

## Installation

### From Obsidian Community Plugins
1. Open **Settings** → **Community plugins** → **Browse**
2. Search for **Smart Question Tutor**
3. Click **Install**, then **Enable**

### Manual Installation
```bash
git clone https://github.com/xxinjie21/Smart-Quiz-Tutor.git
cd Smart-Quiz-Tutor
npm install
npm run build
```

Copy these files into your vault:
```
your-vault/.obsidian/plugins/smart-quiz-tutor/
├── main.js
├── manifest.json
└── styles.css
```

Then enable the plugin in **Settings** → **Community plugins**.

---

## Quick Start

1. **Configure AI** — Go to **Settings** → **Smart Question Tutor**, set your AI provider (Ollama or OpenAI-compatible) and model
2. **Generate questions** — Open the sidebar via the ribbon icon, select a Markdown source file in the **Questions** tab, choose question types and count, click **Generate**
3. **Start answering** — Click **Start Answering** after generation completes
4. **Review mistakes** — Wrong answers are automatically saved to the Wrong Answer Book with spaced repetition scheduling
5. **Track progress** — Check the **Review** tab for due items, or view the heatmap on the Home tab

---

## Commands

| Command | Description |
|---------|-------------|
| Open Smart Question Tutor | Open the main sidebar |
| Generate from current file | Quick quiz generation from the active document |
| Open Wrong Answer Book | View wrong answer list |
| Rebuild knowledge index | Regenerate MOC notes |

### Hotkeys

| Hotkey | Action |
|--------|--------|
| `Ctrl+Q` | Generate quiz from current file |
| `Ctrl+W` | Open wrong answer book |

Customizable in **Settings** → **Hotkeys**.

---

## Settings

### Core

| Setting | Description | Default |
|---------|-------------|---------|
| API Type | Ollama or OpenAI | `Ollama` |
| API URL | AI service endpoint | `http://127.0.0.1:11434` |
| Model | AI model name | `qwen2:7b` |
| Temperature | Randomness (0-2) | `0.1` |
| Root folder | Parent directory for all modules | `Smart Question Tutor` |
| Questions folder | Where generated questions are saved | `Smart Question Tutor/Questions` |
| Wrong answers folder | Wrong answer storage path | `Smart Question Tutor/Wrong` |
| Notes folder | Study notes storage path | `Smart Question Tutor/Notes` |
| Exclude folders | Folders excluded from question generation | `.obsidian, .trash, Templates` |

### Review Interval Presets

| Module | Slow | Standard | Fast |
|--------|------|----------|------|
| Wrong answers | `2,5,10,20,40,60` | `1,2,4,7,15,30` | `1,1,3,5,10,20` |
| Questions | `10,20,40,80,120` | `7,15,30,60,90` | `4,8,18,40,60` |
| Notes | `3,8,20,45,80` | `2,6,14,35,70` | `1,1,2,3,5` |

---

## Interface

The sidebar has 6 tabs:

| Tab | Description |
|-----|-------------|
| Home | Stats overview (4 cards) + learning heatmap + due reviews + quick actions |
| Questions | Question generation settings, file management, file picker |
| Notes | Create study notes from files, note file management |
| Wrong | Wrong answer list, details, review, export, regeneration |
| Review | Unified dashboard of all due items with filter / sort / one-click completion |
| Settings | All configuration options |

---

## Tech Stack

| Technology | Purpose |
|------------|---------|
| [Obsidian API](https://docs.obsidian.md) | Plugin platform |
| [TypeScript](https://www.typescriptlang.org) | Development |
| [esbuild](https://esbuild.github.io) | Bundler |
| [docx](https://docx.js.org) | Word document generation |
| SM-2 | Spaced repetition algorithm |

---

## Support

If this plugin helps your studies, consider giving it a star on GitHub!

**GitHub:** https://github.com/xxinjie21/Smart-Quiz-Tutor

For issues and feature requests, please [open an issue](https://github.com/xxinjie21/Smart-Quiz-Tutor/issues).

---

## License

[ISC License](LICENSE)

</details>

---

<details>
<summary><b>中文文档</b></summary>

## 功能

### 🧠 AI 试题生成
- 基于 Markdown 笔记原文，AI 自动出题（5 种题型：单选 / 多选 / 判断 / 填空 / 简答）
- 支持 **Ollama**（本地）、**OpenAI 兼容接口**（DeepSeek、Claude 等）
- AI 自动提取知识点标签并写入 `[[双向链接]]`，融入 Obsidian 图谱
- 支持多文件批量选择、按知识点分组或按时间排序

### 📄 整卷识别
- 从完整试卷 / 题集中 AI 提取全部题目，保留原有格式
- 支持大文件分块处理（每块 15000 字符，重叠 2000 字符），避免截断
- 原试卷有答案则保留，缺答案由 AI 自动补全

### ✍️ 答题模式
- 直接选择题目文件或刚刚生成的结果，一键开始答题
- 即时批改，展示正确答案与解析
- 客观题自动计分，主观题可手动标记正误并记入错题本

### 📘 错题本（SM-2 间隔重复）
- 答对 → 间隔递增，答错 → 重置为 1 天
- 三种预设方案：**慢速 / 标准 / 快速**，覆盖考研各阶段节奏
- 错题记录含 `[[知识点标签]]`，自动同步到知识点文件夹，图谱可见
- 插件启动时自动提醒到期复习

### 📓 学习笔记
- 从任意 Markdown 文件创建学习笔记，AI 自动生成摘要与知识点
- 笔记同样纳入间隔重复复习体系
- 支持搜索、筛选、导出

### 📊 复习看板
- 统一展示所有到期复习项（错题 + 题目 + 笔记），按优先级排序
- 每行可一键标记「已完成」，自动推进到下一复习周期
- 按源文件 / 知识点 / 时间多种排序

### 📈 学习热力图
- GitHub 风格年度贡献图，直观展示学习活跃度
- 基于文件修改时间统计，颜色按活动频次分级（1-2 / 3-5 / 6-9 / 10+）

### 🔗 知识点图谱
- 每个模块独立的知识点文件夹（题目知识点 / 笔记知识点 / 错题知识点）
- 自动生成知识点 MOC 索引笔记
- 所有题目和错题末尾写入 `[[知识点]]` 双向链接，完美融入 Obsidian 图谱

### 📤 专业导出
- 支持导出 **Markdown**、**Word (.docx)**、**PDF**
- 可导出无答案版用于自测

---

## 仓库地址

**GitHub:** https://github.com/xxinjie21/Smart-Quiz-Tutor

---

## 安装

### 从 Obsidian 社区插件安装
1. 打开 **设置** → **社区插件** → **浏览**
2. 搜索 **Smart Question Tutor**
3. 点击 **安装**，然后 **启用**

### 手动安装
```bash
git clone https://github.com/xxinjie21/Smart-Quiz-Tutor.git
cd Smart-Quiz-Tutor
npm install
npm run build
```

复制到你的 vault：
```
your-vault/.obsidian/plugins/smart-quiz-tutor/
├── main.js
├── manifest.json
└── styles.css
```

然后在 **设置** → **社区插件** 中启用。

---

## 快速开始

1. **配置 AI** — 打开 **设置** → **Smart Question Tutor**，设置 AI 服务（Ollama 或 OpenAI 兼容）和模型
2. **生成题目** — 点击左侧栏图标打开侧边栏，在「题目」Tab 中选择 Markdown 源文件，选择题型和数量，点击「生成」
3. **开始答题** — 生成完成后点击「开始答题」
4. **复习错题** — 错题自动保存到错题本，按间隔重复计划复习
5. **跟踪进度** — 在「复习」Tab 查看待复习项，或在首页查看热力图

---

## 命令

| 命令 | 说明 |
|------|------|
| 打开智学助手 | 打开主界面侧边栏 |
| 从当前文档出题 | 快速基于当前活动文件出题 |
| 打开错题本 | 查看错题列表 |
| 重建知识点索引 | 重新生成 MOC 笔记 |

### 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Q` | 从当前文档快速出题 |
| `Ctrl+W` | 打开错题本 |

可在 **设置 → 快捷键** 中自定义。

---

## 配置

### 核心设置

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| 接口类型 | Ollama 或 OpenAI | `Ollama` |
| 接口地址 | API 服务地址 | `http://127.0.0.1:11434` |
| 模型名称 | AI 模型 | `qwen2:7b` |
| Temperature | 随机性 (0-2) | `0.1` |
| 根文件夹 | 所有模块文件夹的父目录 | `Smart Question Tutor` |
| 题目文件夹 | 生成题目的保存路径 | `Smart Question Tutor/Questions` |
| 错题文件夹 | 错题保存路径 | `Smart Question Tutor/Wrong` |
| 笔记文件夹 | 学习笔记保存路径 | `Smart Question Tutor/Notes` |
| 排除文件夹 | 不参与出题的文件夹 | `.obsidian, .trash, Templates` |

### 复习间隔预设

| 模块 | 慢速 | 标准 | 快速 |
|------|------|------|------|
| 错题 | `2,5,10,20,40,60` | `1,2,4,7,15,30` | `1,1,3,5,10,20` |
| 题目 | `10,20,40,80,120` | `7,15,30,60,90` | `4,8,18,40,60` |
| 笔记 | `3,8,20,45,80` | `2,6,14,35,70` | `1,1,2,3,5` |

---

## 界面

6 个功能 Tab：

| Tab | 功能 |
|-----|------|
| 🏠 首页 | 统计概览（4 卡片）+ 学习热力图 + 待复习 + 快捷操作 + 实用工具 |
| 📝 题目 | 出题设置、题目文件管理、文件选择器 |
| 📓 笔记 | 从文件创建学习笔记、笔记文件管理 |
| ❌ 错题 | 错题列表、详情、复习、导出、重生成 |
| 📊 复习 | 统一看板展示所有到期项，支持筛选 / 排序 / 一键完成 |
| ⚙ 设置 | 所有配置项 |

---

## 技术栈

| 技术 | 用途 |
|------|------|
| [Obsidian API](https://docs.obsidian.md) | 插件平台 |
| [TypeScript](https://www.typescriptlang.org) | 开发语言 |
| [esbuild](https://esbuild.github.io) | 构建工具 |
| [docx](https://docx.js.org) | Word 文档生成 |
| SM-2 | 间隔重复算法 |

---

## 支持

如果这个插件对你的学习有帮助，欢迎在 GitHub 上给一个 ⭐！

**GitHub:** https://github.com/xxinjie21/Smart-Quiz-Tutor

如有问题或建议，请 [提交 Issue](https://github.com/xxinjie21/Smart-Quiz-Tutor/issues)。

---

## 许可

[ISC License](LICENSE)

</details>
