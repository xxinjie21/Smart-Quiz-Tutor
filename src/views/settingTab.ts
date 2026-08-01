import { App, PluginSettingTab, Setting } from "obsidian";

import type QuestionGeneratorPlugin from "../main";

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
			.setName("转换md文件夹")
			.setDesc("对非md文件（txt/rtf/docx/PDF/图片）生成题目或识别试卷时，把转换后的文本保存为md文件到这里，留空则关闭")
			.addText(cb => cb.setValue(s.convertedMdFolder).onChange(v => { s.convertedMdFolder = v; void this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName("AI识别文件夹")
			.addText(cb => cb.setValue(s.extractedExamFolder).onChange(v => { s.extractedExamFolder = v; void this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName("排除文件夹")
			.setDesc("逗号分隔的文件夹名，扫描时跳过")
			.addText(cb => cb.setValue(s.excludeFolders).onChange(v => { s.excludeFolders = v; void this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName("生成后自动保存到题库")
			.addToggle(cb => cb.setValue(s.autoSave).onChange(v => { s.autoSave = v; void this.plugin.saveSettings(); }));

		// --- 知识点文件夹 ---
		new Setting(containerEl).setName("知识点文件夹").setHeading();
		containerEl.createDiv({ text: "用于Obsidian图谱展示知识点关联，插件启动时自动创建", attr: { style: "color:var(--text-muted);font-size:14px;margin-bottom:8px;" } });

		new Setting(containerEl)
			.setName("题目知识点")
			.addText(cb => cb.setPlaceholder("题目/知识点").setValue(s.questionKnowledgeFolder).onChange(v => { s.questionKnowledgeFolder = v; void this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName("笔记知识点")
			.addText(cb => cb.setPlaceholder("笔记/知识点").setValue(s.noteKnowledgeFolder).onChange(v => { s.noteKnowledgeFolder = v; void this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName("错题知识点")
			.addText(cb => cb.setPlaceholder("错题/知识点").setValue(s.wrongKnowledgeFolder).onChange(v => { s.wrongKnowledgeFolder = v; void this.plugin.saveSettings(); }));

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

		const intervalPresets: Record<string, { label: string; values: string; hint: string }[]> = {
			wrong: [
				{ label: "慢速", values: "2,5,10,20,40,60", hint: "复盘间隔长、执行省心，适合已初步掌握、仅需定期回顾的错题" },
				{ label: "标准", values: "1,2,4,7,15,30", hint: "考前日常训练主力方案，遗忘曲线与复习节奏平衡" },
				{ label: "快速", values: "1,1,3,5,10,20", hint: "前期隔天密集复盘，适合频繁出错的高频薄弱点" },
			],
			question: [
				{ label: "慢速", values: "10,20,40,80,120", hint: "适合基础扎实、掌握牢固、几乎不会遗忘的简单题目" },
				{ label: "标准", values: "7,15,30,60,90", hint: "覆盖范围广、周期适中，配合考研各阶段节奏" },
				{ label: "快速", values: "4,8,18,40,60", hint: "加密前期间隔、反复强化，适合刚学完的重难点" },
			],
			note: [
				{ label: "慢速", values: "3,8,20,45,80", hint: "长线缓释记忆，适合考研基础阶段按部就班的日常背诵" },
				{ label: "标准", values: "2,6,14,35,70", hint: "中等密度、长线巩固，强化期系统性复习主力配置" },
				{ label: "快速", values: "1,1,2,3,5", hint: "考前冲刺专用，短期高频轰炸、以速度换覆盖" },
			],
		};
		const intervalConfigs: { label: string; key: "wrongReviewIntervals" | "questionReviewIntervals" | "noteReviewIntervals"; presetKey: string }[] = [
			{ label: "错题复习间隔（天）", key: "wrongReviewIntervals", presetKey: "wrong" },
			{ label: "题目复习间隔（天）", key: "questionReviewIntervals", presetKey: "question" },
			{ label: "笔记复习间隔（天）", key: "noteReviewIntervals", presetKey: "note" },
		];
		for (const cfg of intervalConfigs) {
			const presets = intervalPresets[cfg.presetKey]!;
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
				const btn = btnDiv.createEl("button", { text: p.label, attr: { style: "padding:2px 8px;border-radius:3px;cursor:pointer;font-size:13px;border:1px solid var(--background-modifier-border);background:" + (isActive ? "var(--interactive-accent);color:var(--text-on-accent);" : "var(--background-primary);color:var(--text-muted);") } });
				btn.addEventListener("click", () => { s[cfg.key] = p.values; void this.plugin.saveSettings(); this.display(); });
			}
		}
		new Setting(containerEl)
			.setName("待复习默认排序")
			.addDropdown(cb => { cb.addOption("default", "默认").addOption("source", "按源文件").addOption("tag", "按知识点").addOption("time", "按时间").setValue(s.sortReviewBy).onChange(v => { s.sortReviewBy = v as "default" | "source" | "tag" | "time"; void this.plugin.saveSettings(); }); });

		// --- 学习设置 ---
		new Setting(containerEl).setName("学习设置").setHeading();
		new Setting(containerEl)
			.setName("薄弱点阈值")
			.setDesc("次以上错题标记为薄弱")
			.addText(cb => cb.setValue(String(s.weakPointThreshold)).onChange(v => { s.weakPointThreshold = parseInt(v) || 2; void this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName("启动时提醒复习")
			.addToggle(cb => cb.setValue(s.autoReviewReminder).onChange(v => { s.autoReviewReminder = v; void this.plugin.saveSettings(); }));
		new Setting(containerEl)
			.setName("错题排序")
			.addDropdown(cb => { cb.addOption("date", "按日期").addOption("tag", "按知识点").addOption("review", "按复习时间").setValue(s.sortWrongBy).onChange(v => { s.sortWrongBy = v as "date" | "tag" | "review"; void this.plugin.saveSettings(); }); });
	}
}
