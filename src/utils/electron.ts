import { remote, shell as electronShell } from "electron";

import { t } from "../i18n/index";

/** 系统回收站能力（结构化类型，避免依赖 electron 类型定义的具体导出形式）。 */
export interface ElectronShellLike {
	trashItem?: (fullPath: string) => Promise<void>;
}

/**
 * 取渲染进程的 electron remote。
 *
 * 这里**主动抛错**而不是返回 `undefined`：调用点有十几处，让它们各自判空既啰嗦又容易漏。
 * 抛出的是一条本地化错误，会顺着各调用点已有的 `catch` 显示成「导出失败：…」，
 * 而不是 `Cannot read properties of undefined (reading 'dialog')` 这种英文原始报错。
 */
export function getElectronRemote() {
	if (!remote) throw new Error(t("当前环境不支持系统文件对话框（electron remote 不可用）"));
	return remote;
}

/** 当前环境是否提供 remote 能力（供需要提前降级的调用点判断）。 */
export function hasElectronRemote(): boolean {
	return !!remote;
}

/**
 * 系统回收站能力。`shell` 在渲染进程通常由 `@electron/remote` 提供；
 * 若当前 Electron 版本不提供（或模块未导出），返回 null，由调用方走本地兜底。
 *
 * 注意 `remote` 本身也可能缺失，必须用可选链取 `remote.shell`——直接写 `[electronShell, remote.shell]`
 * 会在数组字面量求值时先抛 TypeError，让这个兜底函数永远返回不了 null，
 * 调用方（`trashFileAbs`）也就永远走不到 `.qg-trash` 兜底分支。
 */
export function getElectronShell(): ElectronShellLike | null {
	try {
		const candidates: (ElectronShellLike | undefined)[] = [electronShell, remote?.shell];
		for (const c of candidates) {
			if (c && typeof c.trashItem === "function") {
				return c;
			}
		}
	} catch { /* 取 remote.shell 本身可能抛错（remote 被冻结 / 代理），按不可用处理 */ }
	return null;
}
