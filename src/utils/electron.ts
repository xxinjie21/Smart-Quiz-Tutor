import { remote, shell as electronShell } from "electron";

export function getElectronRemote() { return remote; }

/** 系统回收站能力（结构化类型，避免依赖 electron 类型定义的具体导出形式）。 */
export interface ElectronShellLike {
	trashItem?: (fullPath: string) => Promise<void>;
}

/**
 * 系统回收站能力。`shell` 在渲染进程通常由 `@electron/remote` 提供；
 * 若当前 Electron 版本不提供（或模块未导出），返回 null，由调用方走本地兜底。
 */
export function getElectronShell(): ElectronShellLike | null {
	const candidates: (ElectronShellLike | undefined)[] = [electronShell, remote.shell];
	for (const c of candidates) {
		if (c && typeof c.trashItem === "function") {
			return c;
		}
	}
	return null;
}
