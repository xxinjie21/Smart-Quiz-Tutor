import { App, Modal } from "obsidian";
import { t } from "../../i18n/index";

interface InputModalOptions {
	title: string;
	placeholder?: string;
	initial?: string;
}

interface ConfirmModalOptions {
	text: string;
	okLabel?: string;
}

/** 输入弹窗（替换不支持的 window.prompt）。 */
class InputModal extends Modal {
	private opts: InputModalOptions;
	private resolve: ((value: string | null) => void) | null = null;
	/** 保证 Promise 只被结算一次，避免 Esc 关闭后永久 pending。 */
	private settled = false;

	constructor(app: App, opts: InputModalOptions) {
		super(app);
		this.opts = opts;
	}

	/** 结算并关闭：任何关闭路径（按钮 / Esc / 点击遮罩）都必须走到这里。 */
	private settle(value: string | null) {
		if (this.settled) return;
		this.settled = true;
		this.resolve?.(value);
		this.close();
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: this.opts.title });
		const input = contentEl.createEl("input", {
			attr: { type: "text", placeholder: this.opts.placeholder || "", value: this.opts.initial || "", style: "width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--background-modifier-border);" },
		});
		const err = contentEl.createDiv({ attr: { style: "color:var(--text-error);font-size:13px;margin-top:4px;" } });
		input.focus();
		input.select();

		const footer = contentEl.createDiv({ attr: { style: "display:flex;justify-content:flex-end;gap:8px;margin-top:12px;" } });
		const ok = footer.createEl("button", { text: t("确定"), cls: "mod-cta" });
		const submit = () => {
			const val = input.value.trim();
			if (!val) { err.setText(t("内容不能为空")); return; }
			this.settle(val);
		};
		ok.addEventListener("click", submit);
		footer.createEl("button", { text: t("取消") }).addEventListener("click", () => this.settle(null));
		input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } if (e.key === "Escape") { this.settle(null); } });
	}

	onClose() {
		this.contentEl.empty();
		// Esc / 点击遮罩 / 程序化关闭都会走到这里：未结算时按“取消”处理。
		if (!this.settled) { this.settled = true; this.resolve?.(null); }
		this.resolve = null;
	}

	setResolver(r: (value: string | null) => void) { this.resolve = r; }
}

/** 确认弹窗（替换 window.confirm）。 */
class ConfirmModal extends Modal {
	private opts: ConfirmModalOptions;
	private result: boolean = false;
	private resolve: ((value: boolean) => void) | null = null;
	/** 保证 Promise 只被结算一次，避免 Esc 关闭后永久 pending。 */
	private settled = false;

	constructor(app: App, opts: ConfirmModalOptions) {
		super(app);
		this.opts = opts;
	}

	/** 结算并关闭：任何关闭路径都必须走到这里。 */
	private settle(value: boolean) {
		if (this.settled) return;
		this.settled = true;
		this.result = value;
		this.resolve?.(value);
		this.close();
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createDiv({ attr: { style: "font-size:16px;line-height:1.6;white-space:pre-wrap;" }, text: this.opts.text });
		const footer = contentEl.createDiv({ attr: { style: "display:flex;justify-content:flex-end;gap:8px;margin-top:12px;" } });
		const ok = footer.createEl("button", { text: this.opts.okLabel || t("确定"), cls: "mod-cta" });
		const okNo = footer.createEl("button", { text: t("取消") });
		ok.addEventListener("click", () => this.settle(true));
		okNo.addEventListener("click", () => this.settle(false));
	}

	onClose() {
		this.contentEl.empty();
		// Esc / 点击遮罩 / 程序化关闭都会走到这里：未结算时按“取消”处理。
		if (!this.settled) { this.settled = true; this.result = false; this.resolve?.(false); }
		this.resolve = null;
	}

	setResolver(r: (value: boolean) => void) { this.resolve = r; }
	getResult() { return this.result; }
}

/** 打开输入弹窗，返回输入值（取消或内容为空为 null）。 */
export function openInput(app: App, opts: InputModalOptions): Promise<string | null> {
	return new Promise(resolve => {
		const modal = new InputModal(app, opts);
		modal.setResolver(resolve);
		modal.open();
	});
}

/** 打开确认弹窗，返回是否确认。 */
export function openConfirm(app: App, opts: ConfirmModalOptions): Promise<boolean> {
	return new Promise(resolve => {
		const modal = new ConfirmModal(app, opts);
		modal.setResolver(resolve);
		modal.open();
	});
}