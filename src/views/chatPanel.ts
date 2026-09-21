import { Notice, TFile, MarkdownView, MarkdownRenderer, MarkdownRenderChild, setIcon, type Component } from "obsidian";

import type QuestionGeneratorPlugin from "../main";
import { CHAT_RETRIEVE_LIMIT, AI_REQUEST_TIMEOUT_MS, CHAT_CANDIDATE_LIMIT, TOKEN_WARN_THRESHOLD, REF_CAPTURE_MAX } from "../constants";
import type { ChatMessage, ChatSearchScope, ChatSession } from "../types";
import { chatMessage } from "../services/llmService";
import { getScopeFiles, retrieveContext, buildChatPrompt, rankCandidates, buildReferenceBlock, isCasualQuery, normalizePluginDirs, type RetrievedChunk } from "../services/chatService";
import { estimateTokens } from "../utils/text";
import { NotePickerModal } from "./notePickerModal";
import { openInput, openConfirm } from "./ui/modals";
import {
	autoTitle,
	genId,
	loadSessions,
	createSession,
	deleteSession,
	renameSession,
	saveSession,
	type ChatAdapter,
} from "../utils/chatStorage";
import { t, tf } from "../i18n/index";

interface ChatRef {
	key: string;
	name: string;
	path: string;
	text: string;
	isSelection: boolean;
}

const MAX_REFS = 5;

/** 单文件引用捕获上限：随总预算增大，硬上限防内存过大。 */
function refCaptureCap(budget: number): number {
	return Math.min(REF_CAPTURE_MAX, Math.max(20000, budget || 60000));
}

/**
 * AI 对话面板：扁平多会话管理。会话列表可通过 ☰ 收起/展开。
 */
export class ChatPanel {
	readonly rootEl: HTMLElement;
	private plugin: QuestionGeneratorPlugin;
	private component: Component;

	private sessions: ChatSession[] = [];
	private activeSession: ChatSession | null = null;

	private messagesEl: HTMLElement | null = null;
	private inputEl: HTMLTextAreaElement | null = null;
	private sendBtn: HTMLButtonElement | null = null;
	private stopBtn: HTMLButtonElement | null = null;
	private sessionSel: HTMLSelectElement | null = null;
	private scopeSel: HTMLSelectElement | null = null;
	private panelEl: HTMLElement | null = null;
	private sessionListEl: HTMLElement | null = null;
	private batchEl: HTMLElement | null = null;
	private batchDeleteBtn: HTMLButtonElement | null = null;
	private selectedSessions = new Set<string>();
	private refsEl: HTMLElement | null = null;
	private bannerEl: HTMLElement | null = null;

	/** 每条 AI 气泡对应的渲染子组件，重绘 / 销毁时统一 unload。 */
	private renderChildren: MarkdownRenderChild[] = [];

	private references: ChatRef[] = [];
	private aiCancelled = false;
	private cancelWaiters: (() => void)[] = [];
	private autoScroll = true;
	private hasFocused = false;
	private memoryMode = false;
	private initPromise: Promise<void> | null = null;
	private reloadPromise: Promise<void> | null = null;

	constructor(plugin: QuestionGeneratorPlugin, container: HTMLElement, component: Component) {
		this.plugin = plugin;
		this.component = component;
		this.rootEl = container.createDiv({ cls: "question-generator-chat" });
		this.render();
	}

	private get app() { return this.plugin.app; }

	private get adapter(): ChatAdapter {
		return this.plugin.chatAdapter();
	}

	destroy() {
		this.cancelAI();
		this.unloadRenderChildren();
		this.messagesEl = null;
		this.inputEl = null;
		this.sendBtn = null;
		this.stopBtn = null;
		this.sessionSel = null;
		this.scopeSel = null;
		this.panelEl = null;
		this.sessionListEl = null;
		this.refsEl = null;
		this.bannerEl = null;
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

	// ===================== 初始化 & 数据 =====================

	async startup(): Promise<void> {
		if (!this.initPromise) {
			this.initPromise = (async () => {
				try {
					await this.reload();
					await this.plugin.saveSettings();
					this.populate();
					this.renderMessages();
				} catch (err) {
					console.error("chat init failed", err);
					new Notice(tf("聊天初始化失败：{msg}", { msg: (err as Error).message }));
				}
			})();
		}
		return this.initPromise;
	}

	async reload(): Promise<void> {
		if (this.reloadPromise) return this.reloadPromise;
		this.reloadPromise = this.doReload().finally(() => { this.reloadPromise = null; });
		return this.reloadPromise;
	}

	private async doReload(): Promise<void> {
		try {
			this.sessions = await loadSessions(this.adapter);
			let sid = this.plugin.settings.chatActiveSessionId;
			if (!this.sessions.some(s => s.id === sid)) sid = this.sessions[0]?.id || "";
			this.activeSession = this.sessions.find(s => s.id === sid) || this.sessions[0] || null;
			this.plugin.settings.chatActiveSessionId = this.activeSession?.id || "";
			this.memoryMode = false;
		} catch (err) {
			console.error("chat reload failed", err);
			this.memoryMode = true;
			const now = Date.now();
			const mem: ChatSession = { id: "__mem", name: t("会话 1"), scope: this.plugin.settings.chatSearchScope || "plugin", createdAt: now, updatedAt: now, messages: [] };
			this.sessions = [mem];
			this.activeSession = mem;
			this.plugin.settings.chatActiveSessionId = "__mem";
			new Notice(tf("聊天存储不可用，本次仅保存在内存：{msg}", { msg: (err as Error).message }));
		}
	}

	/** 持久化当前会话；失败降级内存模式，成功则恢复。 */
	private async persist(): Promise<void> {
		if (!this.activeSession) return;
		try {
			await saveSession(this.adapter, this.activeSession);
			if (this.memoryMode) { this.memoryMode = false; this.updateBanner(); }
		} catch {
			if (!this.memoryMode) { this.memoryMode = true; this.updateBanner(); new Notice(t("聊天存储写入失败，已切换为仅内存模式")); }
		}
	}

	private updateBanner() {
		if (!this.bannerEl) return;
		if (this.memoryMode) {
			this.bannerEl.setText(t("存储不可用，改动仅本次有效"));
			this.bannerEl.show();
		} else {
			this.bannerEl.hide();
		}
	}

	async refresh() {
		await this.reload();
		await this.plugin.saveSettings();
		this.populate();
		this.renderMessages();
	}

	// ===================== 渲染 =====================

	render() {
		this.rootEl.empty();
		try {
			this.buildUi();
		} catch (err) {
			console.error("chat ui build failed", err);
			this.rootEl.empty();
			const box = this.rootEl.createDiv({ cls: "qg-chat-fatal" });
			box.createDiv({ text: t("聊天界面初始化失败") });
			box.createDiv({ text: (err as Error).message || String(err), cls: "qg-chat-fatal-msg" });
		}
	}

	private buildUi() {
		this.rootEl.empty();

		// ---- Header ----
		const header = this.rootEl.createDiv({ cls: "qg-chat-header" });
		header.createSpan({ text: t("💬 AI 助手"), cls: "qg-chat-title" });
		this.sessionSel = header.createEl("select", { cls: "qg-chat-select", attr: { title: t("切换会话") } });
		this.scopeSel = header.createEl("select", { cls: "qg-chat-scope", attr: { title: t("检索范围") } });
		this.scopeSel.createEl("option", { text: t("仅插件知识库"), value: "plugin" });
		this.scopeSel.createEl("option", { text: t("整个 vault"), value: "vault" });

		this.sessionSel.addEventListener("change", () => {
			const id = this.sessionSel?.value;
			if (!id) return;
			void this.selectSession(id);
		});
		this.scopeSel.addEventListener("change", () => {
			const scope: ChatSearchScope = this.scopeSel?.value === "vault" ? "vault" : "plugin";
			if (this.activeSession) { this.activeSession.scope = scope; void this.persist(); }
			this.plugin.settings.chatSearchScope = scope;
			void this.plugin.saveSettings();
			if (scope === "vault") new Notice(t("已切换为整个 vault 范围，笔记内容将发送给 AI"));
		});

		const retrieveBtn = header.createEl("button", { cls: "qg-chat-icon-btn" + (this.plugin.settings.chatAutoRetrieve ? " is-active" : " is-off"), attr: { title: t("自动检索"), "aria-label": t("自动检索") } });
		safeIcon(retrieveBtn, "search");
		retrieveBtn.addEventListener("click", () => {
			this.plugin.settings.chatAutoRetrieve = !this.plugin.settings.chatAutoRetrieve;
			retrieveBtn.toggleClass("is-active", this.plugin.settings.chatAutoRetrieve);
			retrieveBtn.toggleClass("is-off", !this.plugin.settings.chatAutoRetrieve);
			void this.plugin.saveSettings();
			new Notice(this.plugin.settings.chatAutoRetrieve ? t("自动检索已开启") : t("自动检索已关闭，仅引用时携带"));
		});

		const newBtn = header.createEl("button", { cls: "qg-chat-icon-btn", attr: { title: t("新建会话"), "aria-label": t("新建会话") } });
		safeIcon(newBtn, "plus");
		newBtn.addEventListener("click", () => void this.newSession());
		const panelBtn = header.createEl("button", { cls: "qg-chat-icon-btn", attr: { title: t("会话列表"), "aria-label": t("会话列表") } });
		safeIcon(panelBtn, "menu");
		panelBtn.addEventListener("click", () => {
			this.plugin.settings.chatSessionsPanelOpen = !this.plugin.settings.chatSessionsPanelOpen;
			void this.plugin.saveSettings();
			this.applyPanelState();
		});
		const clearBtn = header.createEl("button", { cls: "qg-chat-icon-btn", attr: { title: t("清空当前会话"), "aria-label": t("清空当前会话") } });
		safeIcon(clearBtn, "trash-2");
		clearBtn.addEventListener("click", () => void this.clearSession());

		// ---- Sessions panel (collapsible) ----
		this.panelEl = this.rootEl.createDiv({ cls: "qg-chat-drawer" });
		const sHead = this.panelEl.createDiv({ cls: "qg-chat-drawer-head" });
		sHead.createSpan({ text: t("会话") });
		const sAdd = sHead.createEl("button", { cls: "qg-chat-mini-btn", attr: { title: t("新建会话") } });
		safeIcon(sAdd, "plus");
		sAdd.addEventListener("click", () => void this.newSession());

		this.batchEl = this.panelEl.createDiv({ cls: "qg-chat-batch" });
		const allBtn = this.batchEl.createEl("button", { text: t("全选"), cls: "qg-chat-mini-btn" });
		allBtn.addEventListener("click", () => { this.selectedSessions = new Set(this.sessions.map(s => s.id)); this.renderSessionList(); });
		const noneBtn = this.batchEl.createEl("button", { text: t("取消"), cls: "qg-chat-mini-btn" });
		noneBtn.addEventListener("click", () => { this.selectedSessions.clear(); this.renderSessionList(); });
		this.batchDeleteBtn = this.batchEl.createEl("button", { text: t("删除") + " (0)", cls: "qg-chat-mini-btn qg-chat-batch-del" });
		this.batchDeleteBtn.addEventListener("click", () => void this.deleteSelectedSessions());

		this.sessionListEl = this.panelEl.createDiv({ cls: "qg-chat-drawer-list" });

		this.bannerEl = this.rootEl.createDiv({ cls: "qg-chat-banner" });
		this.bannerEl.hide();

		// ---- Messages ----
		this.messagesEl = this.rootEl.createDiv({ cls: "qg-chat-messages" });
		this.messagesEl.addEventListener("scroll", () => {
			const el = this.messagesEl;
			if (!el) return;
			this.autoScroll = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
		});

		// ---- Composer ----
		const composer = this.rootEl.createDiv({ cls: "qg-chat-composer" });
		this.refsEl = composer.createDiv({ cls: "qg-chat-refs" });
		const wrap = composer.createDiv({ cls: "qg-chat-input-wrap" });
		this.inputEl = wrap.createEl("textarea", { cls: "qg-chat-input", attr: { placeholder: t("向 AI 提问…"), rows: "1" } });
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (!e.shiftKey || e.ctrlKey || e.metaKey)) { e.preventDefault(); void this.send(); }
		});

		const bar = composer.createDiv({ cls: "qg-chat-composer-bar" });
		const refBtn = bar.createEl("button", { cls: "qg-chat-icon-btn", attr: { title: t("添加引用（当前笔记/选区）"), "aria-label": t("添加引用（当前笔记/选区）") } });
		safeIcon(refBtn, "text-quote");
		refBtn.addEventListener("click", () => void this.addReference());
		const refFileBtn = bar.createEl("button", { cls: "qg-chat-icon-btn", attr: { title: t("从文件选择器添加引用"), "aria-label": t("从文件选择器添加引用") } });
		safeIcon(refFileBtn, "file-plus");
		refFileBtn.addEventListener("click", () => this.pickFilesAsReferences());
		bar.createDiv({ cls: "qg-chat-spacer" });
		this.stopBtn = bar.createEl("button", { cls: "qg-chat-icon-btn qg-chat-stop", attr: { title: t("停止"), "aria-label": t("停止") } });
		safeIcon(this.stopBtn, "square");
		this.stopBtn.addEventListener("click", () => this.cancelAI());
		this.stopBtn.hide();
		this.sendBtn = bar.createEl("button", { cls: "qg-chat-icon-btn qg-chat-send", attr: { title: t("发送"), "aria-label": t("发送") } });
		safeIcon(this.sendBtn, "arrow-up");
		this.sendBtn.addEventListener("click", () => void this.send());

		this.applyPanelState();
		this.renderRefs();
	}

	private applyPanelState() {
		if (!this.panelEl) return;
		if (this.plugin.settings.chatSessionsPanelOpen) this.panelEl.addClass("is-open");
		else this.panelEl.removeClass("is-open");
	}

	populate() {
		if (!this.sessionSel || !this.scopeSel) return;
		this.sessionSel.empty();
		if (this.sessions.length === 0) {
			this.sessionSel.createEl("option", { value: "", text: t("（无会话）") });
			this.sessionSel.disabled = true;
		} else {
			for (const s of this.sessions) this.sessionSel.createEl("option", { value: s.id, text: s.name });
			this.sessionSel.disabled = false;
			this.sessionSel.value = this.activeSession?.id || this.sessions[0]!.id;
		}
		this.scopeSel.value = this.activeSession?.scope || "plugin";
		this.renderSessionList();
		this.updateBanner();
	}

	private renderSessionList() {
		const list = this.sessionListEl;
		if (!list) return;
		list.empty();
		// 清理已不存在的选中项
		const ids = new Set(this.sessions.map(s => s.id));
		for (const id of [...this.selectedSessions]) if (!ids.has(id)) this.selectedSessions.delete(id);
		if (this.batchEl) this.batchEl.toggleClass("is-hidden", this.sessions.length === 0);
		if (this.batchDeleteBtn) {
			const n = this.selectedSessions.size;
			this.batchDeleteBtn.setText(t("删除") + " (" + n + ")");
			this.batchDeleteBtn.disabled = n === 0;
		}
		if (this.sessions.length === 0) {
			list.createDiv({ text: t("暂无会话，点击上方 ＋ 新建"), cls: "qg-chat-list-empty" });
			return;
		}
		for (const s of this.sessions) {
			const row = list.createDiv({ cls: "qg-chat-list-row" + (s.id === this.activeSession?.id ? " is-active" : "") });
			const cb = row.createEl("input", { attr: { type: "checkbox", title: t("选择") } });
			cb.checked = this.selectedSessions.has(s.id);
			cb.addEventListener("change", (e) => {
				e.stopPropagation();
				if (cb.checked) this.selectedSessions.add(s.id);
				else this.selectedSessions.delete(s.id);
				if (this.batchDeleteBtn) {
					const n = this.selectedSessions.size;
					this.batchDeleteBtn.setText(t("删除") + " (" + n + ")");
					this.batchDeleteBtn.disabled = n === 0;
				}
			});
			const name = row.createSpan({ text: s.name, cls: "qg-chat-list-name" });
			name.addEventListener("click", () => void this.selectSession(s.id));
			const rename = row.createEl("button", { text: t("改名"), cls: "qg-chat-mini-btn", attr: { title: t("重命名会话") } });
			rename.addEventListener("click", () => void this.renameSessionById(s.id));
			const del = row.createEl("button", { text: t("删除"), cls: "qg-chat-mini-btn", attr: { title: t("删除会话") } });
			del.addEventListener("click", () => void this.deleteSessionById(s.id));
		}
	}

	async deleteSelectedSessions() {
		const ids = [...this.selectedSessions];
		if (ids.length === 0) return;
		const ok = await openConfirm(this.app, { text: tf("确定删除选中的 {n} 个会话？", { n: ids.length }) });
		if (!ok) return;
		for (const id of ids) {
			try { await deleteSession(this.adapter, id); } catch { this.memoryMode = true; }
		}
		this.sessions = this.sessions.filter(s => !this.selectedSessions.has(s.id));
		this.selectedSessions.clear();
		if (this.activeSession && !this.sessions.some(s => s.id === this.activeSession!.id)) {
			this.activeSession = this.sessions[0] || null;
		}
		this.plugin.settings.chatActiveSessionId = this.activeSession?.id || "";
		void this.plugin.saveSettings();
		this.updateBanner();
		this.populate();
		this.renderMessages();
		new Notice(tf("已删除 {n} 个会话", { n: ids.length }));
	}

	// ===================== 会话操作 =====================

	async selectSession(sid: string) {
		if (this.initPromise) await this.initPromise;
		const s = this.sessions.find(x => x.id === sid);
		if (!s) return;
		this.activeSession = s;
		this.plugin.settings.chatActiveSessionId = sid;
		void this.plugin.saveSettings();
		this.populate();
		this.renderMessages();
	}

	async newSession() {
		if (this.initPromise) await this.initPromise;
		const scope = this.plugin.settings.chatSearchScope || "plugin";
		const label = t("新会话");
		const used = new Set(this.sessions.map(x => x.name));
		let idx = 1;
		while (used.has(label + " " + idx)) idx++;
		const name = label + " " + idx;
		let s: ChatSession;
		try {
			s = await createSession(this.adapter, scope, name);
		} catch {
			const now = Date.now();
			s = { id: genId(), name, scope, createdAt: now, updatedAt: now, messages: [] };
			this.memoryMode = true;
		}
		if (!this.sessions.some(x => x.id === s.id)) this.sessions.push(s);
		this.activeSession = s;
		this.plugin.settings.chatActiveSessionId = s.id;
		void this.plugin.saveSettings();
		this.populate();
		this.renderMessages();
		if (this.inputEl) { this.inputEl.value = ""; this.inputEl.focus(); }
		new Notice(tf("已新建会话：{name}", { name: s.name }));
	}

	async renameSessionById(sid: string) {
		const s = this.sessions.find(x => x.id === sid);
		if (!s) return;
		const name = await openInput(this.app, { title: t("请输入新的会话名称"), initial: s.name });
		if (name === null || !name.trim() || name.trim() === s.name) return;
		const n = name.trim();
		try { await renameSession(this.adapter, sid, n); } catch { this.memoryMode = true; }
		s.name = n;
		s.updatedAt = Date.now();
		this.updateBanner();
		this.populate();
	}

	async deleteSessionById(sid: string) {
		const s = this.sessions.find(x => x.id === sid);
		if (!s) return;
		const ok = await openConfirm(this.app, { text: tf("确定删除会话「{name}」？", { name: s.name }) });
		if (!ok) return;
		try { await deleteSession(this.adapter, sid); } catch { this.memoryMode = true; }
		this.sessions = this.sessions.filter(x => x.id !== sid);
		if (this.activeSession?.id === sid) this.activeSession = this.sessions[0] || null;
		this.plugin.settings.chatActiveSessionId = this.activeSession?.id || "";
		void this.plugin.saveSettings();
		this.populate();
		this.renderMessages();
	}

	async clearSession() {
		const s = this.activeSession;
		if (!s) return;
		const ok = await openConfirm(this.app, { text: t("确定清空当前会话的消息？") });
		if (!ok) return;
		s.messages = [];
		s.updatedAt = Date.now();
		await this.persist();
		this.populate();
		this.renderMessages();
		if (this.sendBtn) this.sendBtn.disabled = false;
		this.inputEl?.focus();
		new Notice(t("已清空当前会话"));
	}

	// ===================== 消息渲染 =====================

	private renderRefs() {
		const refsEl = this.refsEl;
		if (!refsEl) return;
		refsEl.empty();
		this.references.forEach((ref, i) => {
			const chip = refsEl.createSpan({ cls: "qg-chat-ref" });
			safeIcon(chip.createSpan({ cls: "qg-chat-ref-icon" }), ref.isSelection ? "text-quote" : "file-text");
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
		this.unloadRenderChildren();
		this.messagesEl.empty();
		const history = this.activeSession?.messages || [];
		if (history.length === 0) {
			const empty = this.messagesEl.createDiv({ cls: "qg-chat-empty" });
			safeIcon(empty.createDiv({ cls: "qg-chat-empty-icon" }), "sparkles");
			empty.createDiv({ text: this.activeSession ? t("与我聊聊吧，我可以基于你的笔记回答问题。") : t("还没有会话，点击上方 ＋ 新建一个开始对话。") });
			return;
		}
		history.forEach((m, i) => this.appendBubble(m.role, m.content, [], i));
		this.scrollToBottom(true);
	}

	/**
	 * 每条消息用一个独立的 `MarkdownRenderChild`，并在重绘 / 销毁时显式 unload。
	 *
	 * 旧实现把同一个 Component 传给每次 `MarkdownRenderer.render()`：该 API 会把渲染出的
	 * 子组件挂到传入的 Component 上，复用同一个实例会让子组件一直累积到视图卸载为止。
	 */
	private unloadRenderChildren(): void {
		for (const child of this.renderChildren) {
			try { child.unload(); } catch { /* ignore */ }
		}
		this.renderChildren = [];
	}

	private appendBubble(role: "user" | "assistant", content: string, sources: RetrievedChunk[], historyIndex = -1) {
		if (!this.messagesEl) return;
		this.messagesEl.querySelector(".qg-chat-empty")?.remove();
		const row = this.messagesEl.createDiv({ cls: "qg-chat-bubble-row " + (role === "user" ? "is-user" : "is-ai") });
		const bubble = row.createDiv({ cls: "qg-chat-bubble " + (role === "user" ? "qg-chat-user" : "qg-chat-ai") });
		if (role === "assistant") {
			bubble.dataset.raw = content;
			// addChild 会在宿主组件已加载时同步 load()，unload() 时也会把它从宿主上摘掉。
			const child = this.component.addChild(new MarkdownRenderChild(bubble));
			this.renderChildren.push(child);
			void MarkdownRenderer.render(this.app, content, bubble, this.app.workspace.getActiveFile()?.path || "", child);
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
		safeIcon(copyBtn, "copy");
		copyBtn.addEventListener("click", () => void this.copyText(content));
		if (role === "assistant" && historyIndex >= 0) {
			const reBtn = actions.createEl("button", { cls: "qg-chat-mini-btn", attr: { title: t("重新生成"), "aria-label": t("重新生成") } });
			safeIcon(reBtn, "rotate-ccw");
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
		const history = this.activeSession?.messages || [];
		let j = index;
		while (j >= 0 && history[j]?.role !== "user") j--;
		if (j < 0) return;
		const userText = history[j]!.content;
		history.length = j;
		void this.persist();
		this.renderMessages();
		if (!this.inputEl) return;
		this.inputEl.value = userText;
		void this.send();
	}

	// ===================== 引用 =====================

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

	async addReference() {
		const ref = await this.collectReference();
		if (!ref) { new Notice(t("没有可引用的内容")); return; }
		const key = (ref.path || ref.name) + "|" + (ref.isSelection ? "sel" : "doc");
		const text = ref.text.trim().slice(0, refCaptureCap(this.plugin.settings.chatRefBudget));
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
				const text = (await this.app.vault.cachedRead(f)).trim().slice(0, refCaptureCap(this.plugin.settings.chatRefBudget));
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

	// ===================== 检索 & 发送 =====================

	/** vault 在磁盘上的根目录；非文件系统适配器（移动端）返回空串。 */
	private getVaultBasePath(): string {
		const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
		try {
			return typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
		} catch {
			return "";
		}
	}

	async collectCandidates(scope: ChatSearchScope, query: string): Promise<{ files: { path: string; basename: string }[]; contents: Record<string, string> }> {
		const pluginSettings = this.plugin.settings;
		const all = this.app.vault.getMarkdownFiles();
		// rootPath() 可能返回绝对路径，而 vault 文件路径是相对的：必须先归一化，否则 plugin 范围永远为空。
		const pluginDirs = normalizePluginDirs(
			[
				pluginSettings.questionFolder,
				pluginSettings.wrongBookFolder,
				pluginSettings.noteViewFolder,
				pluginSettings.knowledgeFolder,
			],
			this.getVaultBasePath(),
		);
		const base: { path: string; basename: string }[] = [];
		if (scope === "vault") {
			base.push(...all.map(f => ({ path: f.path, basename: f.basename })));
		} else {
			base.push(...all.filter(f => pluginDirs.some(p => f.path.startsWith(p.endsWith("/") ? p : p + "/"))).map(f => ({ path: f.path, basename: f.basename })));
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
		if (this.initPromise) await this.initPromise;
		let session = this.activeSession;
		if (!session) {
			await this.newSession();
			session = this.activeSession;
			if (!session || !this.inputEl) return;
		}
		const target = session;
		if (this.sendBtn) this.sendBtn.disabled = true;
		this.appendBubble("user", text, []);
		this.inputEl.value = "";
		this.autoScroll = true;
		this.scrollToBottom(true);
		this.stopBtn?.show();
		this.resetAI();

		if (target.messages.length === 0) {
			target.name = autoTitle(text, this.sessions.length, t("新会话"));
		}
		target.messages.push({ role: "user", content: text });
		target.updatedAt = Date.now();
		await this.persist();
		this.populate();

		try {
			const scope = target.scope || "plugin";
			let chunks: RetrievedChunk[] = [];
			if (this.plugin.settings.chatAutoRetrieve !== false && !isCasualQuery(text)) {
				const { files, contents } = await this.collectCandidates(scope, text);
				if (this.aiCancelled) return;
				chunks = retrieveContext(text, files, contents, CHAT_RETRIEVE_LIMIT);
			}
			const prompt = buildChatPrompt(text, chunks, scope);

			const messages: ChatMessage[] = target.messages.slice(-10).map(m => ({ role: m.role, content: m.content }));
			const refBlock = buildReferenceBlock(this.references, this.plugin.settings.chatRefBudget ?? 60000, { query: text });
			const hasContext = chunks.length > 0 || this.references.length > 0;
			const system = hasContext
				? "你是智学助手，一个帮助用户基于 Obsidian 笔记学习与复习的 AI 助手。回答要依据提供的参考资料，并在关键信息后标注来源。\n\n" + refBlock + prompt
				: "你是智学助手，一个帮助用户学习与复习的 AI 助手。请简洁、准确地回答用户问题。\n\n" + prompt;
			if (this.references.length) { this.references = []; this.renderRefs(); }

			const est = estimateTokens(system + text);
			if (est > TOKEN_WARN_THRESHOLD) this.appendWarn(tf("本次请求约 {n} tokens，可能超出模型上下文，建议减小引用预算或缩小检索范围", { n: est }));

			const assistantReply = await this.requestChat(messages, system);
			if (this.aiCancelled) return;
			target.messages.push({ role: "assistant", content: assistantReply });
			target.updatedAt = Date.now();
			await this.persist();
			this.appendBubble("assistant", assistantReply, chunks, target.messages.length - 1);
			this.plugin.settings.chatActiveSessionId = target.id;
			void this.plugin.saveSettings();
		} catch (err) {
			console.error("chat send failed", err);
			if (!this.aiCancelled) this.appendError((err as Error).message || String(err));
			await this.persist();
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

/** 安全设置图标：未知图标不抛错，避免中断整棵 UI 构建。 */
function safeIcon(el: HTMLElement, name: string): void {
	try { setIcon(el, name); } catch { /* 忽略未知图标 */ }
}