import { vi } from "vitest";

vi.mock("obsidian", () => {
	return {
		App: class {},
		Plugin: class {
			loadData() { return {}; }
			saveData() {}
			registerView() {}
			addRibbonIcon() { return document.createElement("div"); }
			registerEvent() {}
			addCommand() {}
			registerDomEvent() {}
			registerInterval() { return 0; }
		},
		TFile: class {
			basename = "";
			name = "";
			path = "";
			extension = "md";
			stat = { mtime: 0, ctime: 0, size: 0 };
			vault: any = null;
		},
		TFolder: class {
			name = "";
			path = "";
			children: any[] = [];
		},
		Notice: class {
			messageEl = document.createElement("div");
			constructor(msg: string) { this.messageEl.textContent = msg; }
		},
		Modal: class {
			contentEl = document.createElement("div");
			app: any;
			constructor(app: any) { this.app = app; }
			open() {}
			close() {}
			onOpen() {}
			onClose() {}
		},
		ItemView: class {
			containerEl = document.createElement("div");
			constructor() {}
		},
		WorkspaceLeaf: class {},
		PluginSettingTab: class {
			containerEl = document.createElement("div");
			constructor(_app: any, _plugin: any) {}
			display() {}
		},
		Setting: class {
			settingEl = document.createElement("div");
			constructor(_containerEl: any) {}
			setName(_name: string) { return this; }
			setDesc(_desc: string) { return this; }
			setHeading() { return this; }
			addText(cb: any) { cb({ setValue: () => ({ setPlaceholder: () => ({ onChange: () => {} }) }), setPlaceholder: () => ({ onChange: () => {} }), onChange: () => {} }); return this; }
			addToggle(cb: any) { cb({ setValue: () => ({ onChange: () => {} }), onChange: () => {} }); return this; }
			addDropdown(cb: any) { cb({ addOption: () => ({ addOption: () => ({ setValue: () => ({ onChange: () => {} }) }) }), setValue: () => ({ onChange: () => {} }), onChange: () => {} }); return this; }
			addButton(cb: any) { cb({ setButtonText: () => ({ onClick: () => {} }) }); return this; }
		},
		requestUrl: vi.fn(),
	};
});

vi.mock("electron", () => {
	class MockBrowserWindow {
		constructor(_opts: any) {}
		loadURL(_url: string) { return Promise.resolve(); }
		webContents = {
			printToPDF: vi.fn().mockResolvedValue(Buffer.from("")),
		};
		close() {}
	}
	return {
		remote: {
			BrowserWindow: MockBrowserWindow,
			dialog: {
				showSaveDialog: vi.fn(),
			},
		},
	};
});

// 最小 DOMParser 实现：node 测试环境无浏览器 DOM，这里仅覆盖 htmlToMarkdown 用到的子集
class MiniNode {
	nodeType = 1;
	tagName = "";
	childNodes: MiniNode[] = [];
	attrs: Record<string, string> = {};
	_text = "";
	parent: MiniNode | null = null;
	constructor(tagName = "") { this.tagName = tagName.toUpperCase(); }
	get textContent(): string {
		if (this.nodeType === 3) return this._text;
		return this.childNodes.map(c => c.textContent).join("");
	}
	get children(): MiniNode[] { return this.childNodes.filter(c => c.nodeType === 1); }
	get previousElementSibling(): MiniNode | null {
		if (!this.parent) return null;
		const sibs = this.parent.children;
		const i = sibs.indexOf(this);
		return i > 0 ? sibs[i - 1]! : null;
	}
	get nextElementSibling(): MiniNode | null {
		if (!this.parent) return null;
		const sibs = this.parent.children;
		const i = sibs.indexOf(this);
		return i >= 0 && i < sibs.length - 1 ? sibs[i + 1]! : null;
	}
	getAttribute(name: string): string | null { return name in this.attrs ? this.attrs[name]! : null; }
	querySelectorAll(sel: string): MiniNode[] {
		const out: MiniNode[] = [];
		const tag = sel.toLowerCase();
		const visit = (n: MiniNode) => {
			for (const c of n.children) {
				if (c.tagName.toLowerCase() === tag) out.push(c);
				visit(c);
			}
		};
		visit(this);
		return out;
	}
}

function miniTextNode(s: string): MiniNode {
	const n = new MiniNode();
	n.nodeType = 3;
	n._text = s;
	return n;
}

function miniParse(html: string): MiniNode {
	const body = new MiniNode("body");
	const stack: MiniNode[] = [body];
	const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = tagRe.exec(html))) {
		const frag = html.slice(last, m.index);
		if (frag) stack[stack.length - 1]!.childNodes.push(miniTextNode(frag));
		const token = m[0]!;
		if (token.startsWith("</")) {
			const name = m[1]!.toUpperCase();
			for (let i = stack.length - 1; i > 0; i--) {
				if (stack[i]!.tagName === name) { stack.length = i; break; }
			}
		} else {
			const el = new MiniNode(m[1]!);
			const attrSrc = m[2] || "";
			for (const a of attrSrc.matchAll(/([a-zA-Z_:][a-zA-Z0-9_.:-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)) {
				const val = a[2] ? a[2]!.replace(/^["']|["']$/g, "") : "";
				el.attrs[a[1]!] = val;
			}
			stack[stack.length - 1]!.childNodes.push(el);
			if (!token.endsWith("/>")) {
				el.parent = stack[stack.length - 1]!;
				stack.push(el);
			}
		}
		last = tagRe.lastIndex;
	}
	const tail = html.slice(last);
	if (tail) body.childNodes.push(miniTextNode(tail));
	return body;
}

globalThis.DOMParser = class {
	parseFromString(html: string, _mime: string) {
		return { body: miniParse(html) };
	}
} as unknown as typeof DOMParser;
