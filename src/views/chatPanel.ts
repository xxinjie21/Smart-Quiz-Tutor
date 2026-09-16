import { Notice, TFile, MarkdownView, MarkdownRenderer, setIcon, type Component } from "obsidian";

import type QuestionGeneratorPlugin from "../main";
import { CHAT_HISTORY_LIMIT, CHAT_RETRIEVE_LIMIT, AI_REQUEST_TIMEOUT_MS, CHAT_CANDIDATE_LIMIT, TOKEN_WARN_THRESHOLD } from "../constants";
import type { ChatMessage, ChatSearchScope } from "../types";
import { chatMessage } from "../services/llmService";
import { getScopeFiles, retrieveContext, buildChatPrompt, rankCandidates, buildReferenceBlock, type RetrievedChunk } from "../services/chatService";
import { estimateTokens } from "../utils/text";
import { NotePickerModal } from "./notePickerModal";
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
	private autoScroll = true;
	private hasFocused = false;

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
		const clearBtn = header.createEl("button", { cls: "qg-chat-icon-btn", attr: { title: t("清空"), "aria-label": t("清空") } });
		setIcon(clearBtn, "trash-2");
		clearBtn.addEventListener("click", () => {
			this.plugin.settings.chatHistory = [];
			void this.plugin.saveSettings();
			this.render();
		});

		// ---- Messages ----
		this.messagesEl = this.rootEl.createDiv({ cls: "qg-chat-messages" });
		this.messagesEl.addEventListener("scroll", () => {
			const el = this.messagesEl;
			if (!el) return;
			this.autoScroll = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
		});

		// ---- Composer (pinned at bottom) ----
		const composer = this.rootEl.createDiv({ cls: "qg-chat-composer" });
		this.refsEl = composer.createDiv({ cls: "qg-chat-refs" });
		const wrap = composer.createDiv({ cls: "qg-chat-input-wrap" });
		this.inputEl = wrap.createEl("textarea", { cls: "qg-chat-input", attr: { placeholder: t("向 AI 提问…"), rows: "1" } });
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (!e.shiftKey || e.ctrlKey || e.metaKey)) { e.preventDefault(); void this.send(); }
		});

		const bar = composer.createDiv({ cls: "qg-chat-composer-bar" });
		const refBtn = bar.createEl("button", { cls: "qg-chat-icon-btn", attr: { title: t("添加引用（当前笔记/选区）"), "aria-label": t("添加引用（当前笔记/选区）") } });
		setIcon(refBtn, "text-quote");
		refBtn.addEventListener("click", () => void this.addReference());
		const refFileBtn = bar.createEl("button", { cls: "qg-chat-icon-btn", attr: { title: t("从文件选择器添加引用"), "aria-label": t("从文件选择器添加引用") } });
		setIcon(refFileBtn, "file-plus");
		refFileBtn.addEventListener("click", () => this.pickFilesAsReferences());
		bar.createDiv({ cls: "qg-chat-spacer" });
		this.stopBtn = bar.createEl("button", { cls: "qg-chat-icon-btn qg-chat-stop", attr: { title: t("停止"), "aria-label": t("停止") } });
		setIcon(this.stopBtn, "square");
		this.stopBtn.addEventListener("click", () => this.cancelAI());
		this.stopBtn.hide();
		this.sendBtn = bar.createEl("button", { cls: "qg-chat-icon-btn qg-chat-send", attr: { title: t("发送"), "aria-label": t("发送") } });
		setIcon(this.sendBtn, "arrow-up");
		this.sendBtn.addEventListener("click", () => void this.send());

		this.renderRefs();
		this.renderMessages();

		if (!this.hasFocused) {
			this.hasFocused = true;
			window.setTimeout(() => this.inputEl?.focus(), 0);
		}
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

	private scrollToBottom(force = false) {
		if (!this.messagesEl) return;
		if (force || this.autoScroll) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
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
		history.forEach((m, i) => this.appendBubble(m.role, m.content, [], i));
		this.scrollToBottom(true);
	}

	appendBubble(role: "user" | "assistant", content: string, sources: RetrievedChunk[], historyIndex = -1) {
		if (!this.messagesEl) return;
		// 首次发送时移除居中的空状态占位，否则消息会被挤到底部
		this.messagesEl.querySelector(".qg-chat-empty")?.remove();
		const row = this.messagesEl.createDiv({ cls: "qg-chat-bubble-row " + (role === "user" ? "is-user" : "is-ai") });
		const bubble = row.createDiv({ cls: "qg-chat-bubble " + (role === "user" ? "qg-chat-user" : "qg-chat-ai") });
		if (role === "assistant") {
			bubble.dataset.raw = content;
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
		const actions = row.createDiv({ cls: "qg-chat-actions" });
		const copyBtn = actions.createEl("button", { cls: "qg-chat-mini-btn", attr: { title: t("复制"), "aria-label": t("复制") } });
		setIcon(copyBtn, "copy");
		copyBtn.addEventListener("click", () => void this.copyText(content));
		if (role === "assistant" && historyIndex >= 0) {
			const reBtn = actions.createEl("button", { cls: "qg-chat-mini-btn", attr: { title: t("重新生成"), "aria-label": t("重新生成") } });
			setIcon(reBtn, "rotate-ccw");
			reBtn.addEventListener("click", () => this.regenerate(historyIndex));
		}
		this.scrollToBottom();
	}

	private appendError(message: string) {
		if (!this.messagesEl) return;
		this.messagesEl.querySelector(".qg-chat-empty")?.remove();
		const row = this.messagesEl.createDiv({ cls: "qg-chat-bubble-row is-ai" });
		row.createDiv({ cls: "qg-chat-error", text: t("请求失败") + "：" + message });
		this.scrollToBottom();
	}

	private appendWarn(message: string) {
		if (!this.messagesEl) return;
		const row = this.messagesEl.createDiv({ cls: "qg-chat-bubble-row is-ai" });
		row.createDiv({ cls: "qg-chat-warn", text: message });
		this.scrollToBottom();
	}

	async copyText(content: string) {
		try {
			await navigator.clipboard.writeText(content);
			new Notice(t("已复制"));
		} catch { /* clipboard unavailable */ }
	}

	regenerate(index: number) {
		const history = this.plugin.settings.chatHistory || [];
		let j = index;
		while (j >= 0 && history[j]?.role !== "user") j--;
		if (j < 0) return;
		const userText = history[j]!.content;
		this.plugin.settings.chatHistory = history.slice(0, j);
		void this.plugin.saveSettings();
		this.renderMessages();
		if (!this.inputEl) return;
		this.inputEl.value = userText;
		void this.send();
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

	private pickFilesAsReferences() {
		new NotePickerModal(this.app, (files) => void this.addFilesAsReferences(files)).open();
	}

	private async addFilesAsReferences(files: TFile[]) {
		let added = 0;
		for (const f of files) {
			if (this.references.length >= MAX_REFS) { new Notice(tf("最多引用 {n} 个文件", { n: MAX_REFS })); break; }
			const key = f.path + "|doc";
			if (this.references.some(r => r.key === key)) continue;
			try {
				const text = (await this.app.vault.cachedRead(f)).trim().slice(0, REF_CHARS);
				if (!text) continue;
				this.references.push({ key, name: f.basename, path: f.path, text, isSelection: false });
				added++;
			} catch { /* skip */ }
		}
		this.renderRefs();
		if (added > 0) new Notice(tf("已引用 {n} 篇笔记", { n: added }));
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

	async collectCandidates(scope: ChatSearchScope, query: string): Promise<{ files: { path: string; basename: string }[]; contents: Record<string, string> }> {
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
		const capped = rankCandidates(query, files, CHAT_CANDIDATE_LIMIT);
		const contents: Record<string, string> = {};
		for (const f of capped) {
			try {
				const tf = this.app.vault.getAbstractFileByPath(f.path);
				if (tf instanceof TFile) contents[f.path] = await this.app.vault.cachedRead(tf);
			} catch { /* skip */ }
		}
		return { files: capped, contents };
	}

	async send() {
		if (!this.inputEl) return;
		const text = this.inputEl.value.trim();
		if (!text) return;
		if (this.sendBtn) this.sendBtn.disabled = true;
		this.appendBubble("user", text, []);
		this.inputEl.value = "";
		this.autoScroll = true;
		this.scrollToBottom(true);
		this.stopBtn?.show();
		this.resetAI();

		const history = this.plugin.settings.chatHistory || [];
		history.push({ role: "user", content: text });
		if (history.length > CHAT_HISTORY_LIMIT * 2) history.splice(0, history.length - CHAT_HISTORY_LIMIT * 2);

		try {
			const scope = this.plugin.settings.chatSearchScope || "plugin";
			const { files, contents } = await this.collectCandidates(scope, text);
			if (this.aiCancelled) return;
			const chunks = retrieveContext(text, files, contents, CHAT_RETRIEVE_LIMIT);
			const prompt = buildChatPrompt(text, chunks, scope);

			const messages: ChatMessage[] = history.slice(-10).map(m => ({ role: m.role, content: m.content }));
			const refBlock = buildReferenceBlock(this.references, this.plugin.settings.chatRefBudget ?? 60000);
			const hasContext = chunks.length > 0 || this.references.length > 0;
			const system = hasContext
				? "你是智学助手，一个帮助用户基于 Obsidian 笔记学习与复习的 AI 助手。回答要依据提供的参考资料，并在关键信息后标注来源。\n\n" + refBlock + prompt
				: "你是智学助手，一个帮助用户学习与复习的 AI 助手。请简洁、准确地回答用户问题。\n\n" + prompt;
			// 发送后自动清空引用
			if (this.references.length) { this.references = []; this.renderRefs(); }

			const est = estimateTokens(system + text);
			if (est > TOKEN_WARN_THRESHOLD) this.appendWarn(tf("本次请求约 {n} tokens，可能超出模型上下文，建议减小引用预算或缩小检索范围", { n: est }));

			const assistantReply = await this.requestChat(messages, system);
			if (this.aiCancelled) return;
			history.push({ role: "assistant", content: assistantReply });
			this.plugin.settings.chatHistory = history;
			void this.plugin.saveSettings();
			this.appendBubble("assistant", assistantReply, chunks, history.length - 1);
		} catch (err) {
			if (!this.aiCancelled) this.appendError((err as Error).message || String(err));
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
