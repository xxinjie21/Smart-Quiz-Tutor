import { Notice, TFile, MarkdownView, MarkdownRenderer, setIcon, type Component } from "obsidian";

import type QuestionGeneratorPlugin from "../main";
import { CHAT_HISTORY_LIMIT, CHAT_RETRIEVE_LIMIT, AI_REQUEST_TIMEOUT_MS } from "../constants";
import type { ChatMessage, ChatSearchScope } from "../types";
import { chatMessage } from "../services/llmService";
import { getScopeFiles, retrieveContext, buildChatPrompt, type RetrievedChunk } from "../services/chatService";
import { t, tf } from "../i18n/index";

interface ChatRef {
	key: string;
	name: string;
	path: string;
	text: string;
	isSelection: boolean;
}

const MAX_REFS = 5;
const REF_CHARS = 12000;

/** 可复用的 AI 对话面板，渲染进任意容器（独立视图或智学助手侧边栏）。 */
export class ChatPanel {
	readonly rootEl: HTMLElement;
	private plugin: QuestionGeneratorPlugin;
	private component: Component;
	private messagesEl: HTMLElement | null = null;
	private inputEl: HTMLTextAreaElement | null = null;
	private sendBtn: HTMLButtonElement | null = null;
	private stopBtn: HTMLButtonElement | null = null;
	private scopeEl: HTMLSelectElement | null = null;
	private refsEl: HTMLElement | null = null;
	private references: ChatRef[] = [];
	private aiCancelled = false;
	private cancelWaiters: (() => void)[] = [];

	constructor(plugin: QuestionGeneratorPlugin, container: HTMLElement, component: Component) {
		this.plugin = plugin;
		this.component = component;
		this.rootEl = container.createDiv({ cls: "question-generator-chat" });
		this.render();
	}

	private get app() { return this.plugin.app; }

	destroy() {
		this.cancelAI();
		this.messagesEl = null;
		this.inputEl = null;
		this.sendBtn = null;
		this.stopBtn = null;
		this.scopeEl = null;
		this.refsEl = null;
	}

	cancelAI() {
		this.aiCancelled = true;
		const waiters = this.cancelWaiters;
		this.cancelWaiters = [];
		for (const w of waiters) w();
	}

	resetAI() {
		this.aiCancelled = false;
		this.cancelWaiters = [];
	}

	render() {
		this.rootEl.empty();

		// ---- Header: title + scope + clear ----
		const header = this.rootEl.createDiv({ cls: "qg-chat-header" });
		header.createSpan({ text: t("💬 AI 助手"), cls: "qg-chat-title" });
		this.scopeEl = header.createEl("select", { cls: "qg-chat-scope", attr: { title: t("检索范围") } });
		this.scopeEl.createEl("option", { text: t("仅插件知识库"), value: "plugin" });
		this.scopeEl.createEl("option", { text: t("整个 vault"), value: "vault" });
		this.scopeEl.value = this.plugin.settings.chatSearchScope || "plugin";
		this.scopeEl.addEventListener("change", () => {
			const scope: ChatSearchScope = this.scopeEl?.value === "vault" ? "vault" : "plugin";
			this.plugin.settings.chatSearchScope = scope;
			void this.plugin.saveSettings();
			if (scope === "vault") new Notice(t("已切换为整个 vault 范围，笔记内容将发送给 AI"));
		});
		const clearBtn = header.createEl("button", { cls: "qg-chat-icon-btn", attr: { title: t("清空") } });
		setIcon(clearBtn, "trash-2");
		clearBtn.addEventListener("click", () => {
			this.plugin.settings.chatHistory = [];
			void this.plugin.saveSettings();
			this.render();
		});

		// ---- Messages ----
		this.messagesEl = this.rootEl.createDiv({ cls: "qg-chat-messages" });

		// ---- Composer (pinned at bottom) ----
		const composer = this.rootEl.createDiv({ cls: "qg-chat-composer" });
		this.refsEl = composer.createDiv({ cls: "qg-chat-refs" });
		const wrap = composer.createDiv({ cls: "qg-chat-input-wrap" });
		this.inputEl = wrap.createEl("textarea", { cls: "qg-chat-input", attr: { placeholder: t("向 AI 提问…"), rows: "1" } });
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void this.send(); }
		});

		const bar = composer.createDiv({ cls: "qg-chat-composer-bar" });
		const refBtn = bar.createEl("button", { cls: "qg-chat-icon-btn", attr: { title: t("添加引用（当前笔记/选区）") } });
		setIcon(refBtn, "text-quote");
		refBtn.addEventListener("click", () => void this.addReference());
		bar.createDiv({ cls: "qg-chat-spacer" });
		this.stopBtn = bar.createEl("button", { cls: "qg-chat-icon-btn qg-chat-stop", attr: { title: t("停止") } });
		setIcon(this.stopBtn, "square");
		this.stopBtn.addEventListener("click", () => this.cancelAI());
		this.stopBtn.hide();
		this.sendBtn = bar.createEl("button", { cls: "qg-chat-icon-btn qg-chat-send", attr: { title: t("发送") } });
		setIcon(this.sendBtn, "arrow-up");
		this.sendBtn.addEventListener("click", () => void this.send());

		this.renderRefs();
		this.renderMessages();
	}

	private renderRefs() {
		const refsEl = this.refsEl;
		if (!refsEl) return;
		refsEl.empty();
		this.references.forEach((ref, i) => {
			const chip = refsEl.createSpan({ cls: "qg-chat-ref" });
			setIcon(chip.createSpan({ cls: "qg-chat-ref-icon" }), ref.isSelection ? "text-quote" : "file-text");
			chip.createSpan({ text: ref.name + (ref.isSelection ? t("（选中）") : "") });
			const x = chip.createSpan({ cls: "qg-chat-ref-x", text: "✕" });
			x.addEventListener("click", (e) => { e.stopPropagation(); this.references.splice(i, 1); this.renderRefs(); });
		});
		if (this.references.length > 0) {
			const clear = refsEl.createSpan({ cls: "qg-chat-ref-clear", text: t("清空引用") });
			clear.addEventListener("click", () => { this.references = []; this.renderRefs(); });
		}
	}

	renderMessages() {
		if (!this.messagesEl) return;
		this.messagesEl.empty();
		const history = this.plugin.settings.chatHistory || [];
		if (history.length === 0) {
			const empty = this.messagesEl.createDiv({ cls: "qg-chat-empty" });
			setIcon(empty.createDiv({ cls: "qg-chat-empty-icon" }), "sparkles");
			empty.createDiv({ text: t("与我聊聊吧，我可以基于你的笔记回答问题。") });
			return;
		}
		for (const m of history) {
			this.appendBubble(m.role, m.content, []);
		}
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	appendBubble(role: "user" | "assistant", content: string, sources: RetrievedChunk[]) {
		if (!this.messagesEl) return;
		// 首次发送时移除居中的空状态占位，否则消息会被挤到底部
		this.messagesEl.querySelector(".qg-chat-empty")?.remove();
		const row = this.messagesEl.createDiv({ cls: "qg-chat-bubble-row " + (role === "user" ? "is-user" : "is-ai") });
		const bubble = row.createDiv({ cls: "qg-chat-bubble " + (role === "user" ? "qg-chat-user" : "qg-chat-ai") });
		if (role === "assistant") {
			void MarkdownRenderer.render(this.app, content, bubble, this.app.workspace.getActiveFile()?.path || "", this.component);
		} else {
			bubble.setText(content);
		}
		if (role === "assistant" && sources.length > 0) {
			const srcRow = row.createDiv({ cls: "qg-chat-sources" });
			for (const s of sources) {
				srcRow.createSpan({ text: s.basename, cls: "qg-chat-source" }).addEventListener("click", () => this.jumpToFile(s.path));
			}
		}
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	private getActiveMarkdownView(): MarkdownView | null {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active) return active;
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			if (leaf.view instanceof MarkdownView) return leaf.view;
		}
		return null;
	}

	private async collectReference(): Promise<{ name: string; path: string; text: string; isSelection: boolean } | null> {
		const view = this.getActiveMarkdownView();
		if (view) {
			const name = view.file?.basename || t("当前笔记");
			const path = view.file?.path || "";
			const sel = view.editor?.getSelection?.() ?? "";
			if (sel && sel.trim()) return { name, path, text: sel, isSelection: true };
			const text = view.data || "";
			if (text.trim()) return { name, path, text, isSelection: false };
		}
		const file = this.app.workspace.getActiveFile();
		if (file) {
			try {
				const text = await this.app.vault.cachedRead(file);
				if (text.trim()) return { name: file.basename, path: file.path, text, isSelection: false };
			} catch { /* ignore */ }
		}
		return null;
	}

	/** 把当前笔记/选区加入默认回答上下文（不写入输入框），支持多个文件。 */
	async addReference() {
		const ref = await this.collectReference();
		if (!ref) { new Notice(t("没有可引用的内容")); return; }
		const key = (ref.path || ref.name) + "|" + (ref.isSelection ? "sel" : "doc");
		const text = ref.text.trim().slice(0, REF_CHARS);
		const existing = this.references.find(r => r.key === key);
		if (existing) {
			existing.name = ref.name;
			existing.text = text;
		} else {
			if (this.references.length >= MAX_REFS) { new Notice(tf("最多引用 {n} 个文件", { n: MAX_REFS })); return; }
			this.references.push({ key, name: ref.name, path: ref.path, text, isSelection: ref.isSelection });
		}
		this.renderRefs();
		new Notice(tf("已引用 {name}", { name: ref.name }) + (ref.isSelection ? t("（选中）") : ""));
	}

	jumpToFile(path: string) {
		try {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) { void this.app.workspace.getLeaf(false).openFile(file); return; }
		} catch { /* try basename */ }
		const target = this.app.vault.getMarkdownFiles().find(f => f.path.endsWith(path) || f.basename === path);
		if (target) void this.app.workspace.getLeaf(false).openFile(target);
		else new Notice(t("找不到文件") + ": " + path);
	}

	async collectCandidates(scope: ChatSearchScope): Promise<{ files: { path: string; basename: string }[]; contents: Record<string, string> }> {
		const pluginSettings = this.plugin.settings;
		const all = this.app.vault.getMarkdownFiles();
		const pluginDirs: string[] = [];
		for (const d of [pluginSettings.questionFolder, pluginSettings.wrongBookFolder, pluginSettings.noteViewFolder, pluginSettings.knowledgeFolder]) {
			const p = this.plugin.rootPath(d);
			if (p) pluginDirs.push(p);
		}
		const base: { path: string; basename: string }[] = [];
		if (scope === "vault") {
			base.push(...all.map(f => ({ path: f.path, basename: f.basename })));
		} else {
			const dirs = pluginDirs;
			base.push(...all.filter(f => dirs.some(p => f.path.startsWith(p.endsWith("/") ? p : p + "/"))).map(f => ({ path: f.path, basename: f.basename })));
		}
		const files = getScopeFiles(base, scope, pluginDirs);
		const capped = files.slice(0, 300);
		const contents: Record<string, string> = {};
		for (const f of capped) {
			try {
				const tf = this.app.vault.getAbstractFileByPath(f.path);
				if (tf instanceof TFile) contents[f.path] = await this.app.vault.cachedRead(tf);
			} catch { /* skip */ }
		}
		return { files: capped, contents };
	}

	/** 按总预算拼接全部引用文本，超出部分按引用顺序截断。 */
	private buildRefBlock(): string {
		if (this.references.length === 0) return "";
		const budget = this.plugin.settings.chatRefBudget ?? 60000;
		let used = 0;
		const parts: string[] = [];
		for (const ref of this.references) {
			const header = `【${ref.name}${ref.isSelection ? "（选中片段）" : ""}】\n`;
			const remaining = budget - used - header.length;
			if (remaining <= 0) break;
			const body = ref.text.slice(0, remaining);
			parts.push(header + body);
			used += header.length + body.length;
		}
		if (parts.length === 0) return "";
		return "【引用文件】\n" + parts.join("\n\n") + "\n\n回答请优先依据以上引用文件的内容与思想。\n\n";
	}

	async send() {
		if (!this.inputEl) return;
		const text = this.inputEl.value.trim();
		if (!text) return;
		if (this.sendBtn) this.sendBtn.disabled = true;
		this.appendBubble("user", text, []);
		this.inputEl.value = "";
		this.stopBtn?.show();
		this.resetAI();

		const history = this.plugin.settings.chatHistory || [];
		history.push({ role: "user", content: text });
		if (history.length > CHAT_HISTORY_LIMIT * 2) history.splice(0, history.length - CHAT_HISTORY_LIMIT * 2);

		try {
			const scope = this.plugin.settings.chatSearchScope || "plugin";
			const { files, contents } = await this.collectCandidates(scope);
			if (this.aiCancelled) return;
			const chunks = retrieveContext(text, files, contents, CHAT_RETRIEVE_LIMIT);
			const prompt = buildChatPrompt(text, chunks, scope);

			const messages: ChatMessage[] = history.slice(-10).map(m => ({ role: m.role, content: m.content }));
			const refBlock = this.buildRefBlock();
			const hasContext = chunks.length > 0 || this.references.length > 0;
			const system = hasContext
				? "你是智学助手，一个帮助用户基于 Obsidian 笔记学习与复习的 AI 助手。回答要依据提供的参考资料，并在关键信息后标注来源。\n\n" + refBlock + prompt
				: "你是智学助手，一个帮助用户学习与复习的 AI 助手。请简洁、准确地回答用户问题。\n\n" + prompt;
			// 发送后自动清空引用
			if (this.references.length) { this.references = []; this.renderRefs(); }

			const assistantReply = await this.requestChat(messages, system);
			if (this.aiCancelled) return;
			history.push({ role: "assistant", content: assistantReply });
			this.plugin.settings.chatHistory = history;
			void this.plugin.saveSettings();
			this.appendBubble("assistant", assistantReply, chunks);
		} catch (err) {
			if (!this.aiCancelled) {
				new Notice(t("AI 调用失败") + ": " + ((err as Error).message || String(err)));
			}
		} finally {
			this.stopBtn?.hide();
			if (this.sendBtn) this.sendBtn.disabled = false;
		}
	}

	requestChat(messages: ChatMessage[], system: string): Promise<string> {
		const cfg = this.plugin.settings;
		const abortErr = (msg: string): Error => { const e = new Error(msg); e.name = "AbortError"; return e; };
		const chatPromise = chatMessage(cfg, messages, { system });
		chatPromise.catch(() => { /* 取消/超时后丢弃迟到的错误 */ });
		let cancelReject: (() => void) | null = null;
		const cancelPromise = new Promise<never>((_, reject) => {
			cancelReject = () => reject(abortErr("已中止"));
			this.cancelWaiters.push(cancelReject);
		});
		let timer: number | null = null;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = window.setTimeout(() => reject(abortErr("请求超时")), AI_REQUEST_TIMEOUT_MS);
		});
		return (async () => {
			try {
				return await Promise.race([chatPromise, cancelPromise, timeoutPromise]);
			} finally {
				if (cancelReject) { const idx = this.cancelWaiters.indexOf(cancelReject); if (idx >= 0) this.cancelWaiters.splice(idx, 1); }
				if (timer !== null) window.clearTimeout(timer);
			}
		})();
	}
}
