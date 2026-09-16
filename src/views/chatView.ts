import { ItemView, WorkspaceLeaf } from "obsidian";

import type QuestionGeneratorPlugin from "../main";
import { CHAT_VIEW_TYPE } from "../constants";
import { ChatPanel } from "./chatPanel";
import { t } from "../i18n/index";
import type { ChatSearchScope } from "../types";

export class ChatView extends ItemView {
	private plugin: QuestionGeneratorPlugin;
	private panel: ChatPanel | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: QuestionGeneratorPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() { return CHAT_VIEW_TYPE; }
	getDisplayText() { return t("AI 助手"); }
	getIcon() { return "message-square"; }

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		if (!container) return;
		container.empty();
		this.panel = new ChatPanel(this.plugin, container, this);
	}

	onClose() {
		this.panel?.destroy();
		this.panel = null;
		return Promise.resolve();
	}
}

export type { ChatSearchScope };
