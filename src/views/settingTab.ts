import { App, PluginSettingTab, Setting } from "obsidian";

import type QuestionGeneratorPlugin from "../main";
import { INTERVAL_PRESETS } from "../constants";

export class QuestionGeneratorSettingTab extends PluginSettingTab {
	plugin: QuestionGeneratorPlugin;

	constructor(app: App, plugin: QuestionGeneratorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		new Setting(containerEl).setName("智学助手设置").setHeading();

		// --- 文件夹 ---
		new Setting(containerEl).setName("文件夹").setHeading();
		containerEl.createDiv({ text: "根文件夹下包含所有模块子文件夹，修改后需重启插件生效", attr: { style: "color:var(--text-muted);font-size:14px;margin-bottom:8px;" } });

		new Setting(containerEl)
			.setName("根文件夹")
			.setDesc("所有模块子文件夹的父目录")
			.addText(cb => cb.setPlaceholder("智学助手").setValue(s.rootFolder).onChange(v => { s.rootFolder = v; void this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName("题目文件夹")
			.addText(cb => cb.setValue(s.questionFolder).onChange(v => { s.questionFolder = v; void this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName("错题文件夹")
			.addText(cb => cb.setValue(s.wrongBookFolder).onChange(v => { s.wrongBookFolder = v; void this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName("笔记文件夹")
			.addText(cb => cb.setPlaceholder("笔记").setValue(s.noteViewFolder).onChange(v => { s.noteViewFolder = v; void this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName("知识点文件夹")
			.setDesc("统一的知识点索引目录（与题目/笔记/错题同层），索引文件内含「相关题目/相关笔记/相关错题」三段")
			.addText(cb => cb.setPlaceholder("知识点").setValue(s.knowledgeFolder).onChange(v => { s.knowledgeFolder = v; void this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName("转换md文件夹")
			.setDesc("对非md文件（txt/rtf/docx/PDF/图片）生成题目或识别试卷时，把转换后的文本保存为md文件到这里，留空则关闭")
			.addText(cb => cb.setValue(s.convertedMdFolder).onChange(v => { s.convertedMdFolder = v; void this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName("AI识别文件夹")
			.addText(cb => cb.setPlaceholder("题目/识别试卷").setValue(s.extractedExamFolder).onChange(v => { s.extractedExamFolder = v; void this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName("排除文件夹")
			.setDesc("逗号分隔的文件夹名，扫描时跳过")
			.addText(cb => cb.setValue(s.excludeFolders).onChange(v => { s.excludeFolders = v; void this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName("生成后自动保存到题库")
			.addToggle(cb => cb.setValue(s.autoSave).onChange(v => { s.autoSave = v; void this.plugin.saveSettings(); }));
		containerEl.createDiv({ text: "预期目录结构：\n根文件夹/\n├─ 题目/（含 识别试卷/）\n├─ 错题/\n├─ 笔记/\n├─ 知识点/（统一索引，含相关题目/相关笔记/相关错题三段）\n└─ md文件/", attr: { style: "color:var(--text-muted);font-size:14px;line-height:1.6;margin-top:8px;padding:8px 10px;border-radius:6px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);white-space:pre-wrap;" } });

		// --- 默认题目数量 ---
		new Setting(containerEl).setName("默认题目数量").setHeading();
		const counts: { label: string; key: "countSingle" | "countMulti" | "countJudge" | "countBlank" | "countEssay" }[] = [
			{ label: "单选题", key: "countSingle" },
			{ label: "多选题", key: "countMulti" },
			{ label: "判断题", key: "countJudge" },
			{ label: "填空题", key: "countBlank" },
			{ label: "简答题", key: "countEssay" },
		];
		for (const c of counts) {
			new Setting(containerEl)
				.setName(c.label)
				.addText(cb => cb.setValue(String(s[c.key])).onChange(v => { s[c.key] = parseInt(v) || 0; void this.plugin.saveSettings(); }));
		}

		// --- API 配置 ---
		new Setting(containerEl).setName("API 配置").setHeading();
		new Setting(containerEl)
			.setName("接口类型")
			.addDropdown(cb => { cb.addOption("ollama", "Ollama").addOption("openai", "OpenAI兼容").setValue(s.apiType).onChange(v => { s.apiType = v as "ollama" | "openai"; void this.plugin.saveSettings(); }); });
		new Setting(containerEl)
			.setName("接口地址")
			.addText(cb => cb.setValue(s.baseUrl).onChange(v => { s.baseUrl = v; void this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName("模型名称")
			.addText(cb => cb.setValue(s.modelName).onChange(v => { s.modelName = v; void this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName("API key")
			.addText(cb => cb.setValue(s.apiKey || "").onChange(v => { s.apiKey = v; void this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName("Temperature")
			.setDesc("控制输出随机性，0-2，越低越确定")
			.addText(cb => cb.setValue(String(s.temperature)).onChange(v => { s.temperature = parseFloat(v) || 0.1; void this.plugin.saveSettings(); }));

		// --- 复习间隔设置 ---
		new Setting(containerEl).setName("复习间隔设置").setHeading();
		containerEl.createDiv({ text: "参数越大复习间隔越长，记忆越牢固但可能遗忘；参数越小复习越频繁，短期效果好但耗时多。推荐使用默认值。", attr: { style: "color:var(--text-muted);font-size:14px;margin-bottom:10px;line-height:1.5;padding:8px;border-radius:6px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);" } });

		const intervalConfigs: { label: string; key: "wrongReviewIntervals" | "questionReviewIntervals" | "noteReviewIntervals"; presetKey: string }[] = [
			{ label: "错题复习间隔（天）", key: "wrongReviewIntervals", presetKey: "wrong" },
			{ label: "题目复习间隔（天）", key: "questionReviewIntervals", presetKey: "question" },
			{ label: "笔记复习间隔（天）", key: "noteReviewIntervals", presetKey: "note" },
		];
		for (const cfg of intervalConfigs) {
			const presets = INTERVAL_PRESETS[cfg.presetKey]!;
			const currentVal = s[cfg.key];
			const currentPreset = presets.find(p => p.values === currentVal);
			const activePreset = currentPreset || presets[1]!;
			const setting = new Setting(containerEl)
				.setName(cfg.label)
				.setDesc(activePreset.hint)
				.addText(cb => cb.setValue(currentVal).setPlaceholder("1,2,4,7,15,30").onChange(v => { s[cfg.key] = v; void this.plugin.saveSettings(); }));
			const btnDiv = setting.settingEl.createDiv({ attr: { style: "display:flex;gap:4px;margin-top:6px;" } });
			for (const p of presets) {
				const isActive = p.values === currentVal;
				const btn = btnDiv.createEl("button", { text: p.label, cls: isActive ? "qg-interval-active" : undefined, attr: { style: "padding:2px 8px;border-radius:3px;cursor:pointer;font-size:13px;border:1px solid var(--background-modifier-border);" + (isActive ? "" : "background:var(--background-primary);color:var(--text-muted);") } });
				btn.addEventListener("click", () => { s[cfg.key] = p.values; void this.plugin.saveSettings(); this.display(); });
			}
		}
		// --- 学习设置 ---
		new Setting(containerEl).setName("学习设置").setHeading();
		new Setting(containerEl)
			.setName("薄弱点阈值")
			.setDesc("次以上错题标记为薄弱")
			.addText(cb => cb.setValue(String(s.weakPointThreshold)).onChange(v => { s.weakPointThreshold = parseInt(v) || 2; void this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName("启动时提醒复习")
			.addToggle(cb => cb.setValue(s.autoReviewReminder).onChange(v => { s.autoReviewReminder = v; void this.plugin.saveSettings(); }));
	}
}
