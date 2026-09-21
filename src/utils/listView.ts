/** 列表视图共用的分组/格式化纯函数（可单测，无 DOM 依赖）。 */

export const LIST_SORT_KEYS = ["default", "source", "tag", "time"] as const;
export type ListSortKey = (typeof LIST_SORT_KEYS)[number];

export interface KeyedGroup<T> { key: string; items: T[]; }

/** 按来源分组（去 [[ ]]/空白），组内按数量降序；无来源的进入 noSource。 */
export function groupBySource<T>(items: T[], sourceOf: (item: T) => string): { groups: KeyedGroup<T>[]; noSource: T[] } {
	const map = new Map<string, T[]>();
	const noSource: T[] = [];
	for (const item of items) {
		const src = (sourceOf(item) || "").replace(/\[\[|\]\]/g, "").trim();
		if (!src) { noSource.push(item); continue; }
		const list = map.get(src);
		if (list) list.push(item); else map.set(src, [item]);
	}
	const groups = [...map.entries()]
		.map(([key, list]) => ({ key, items: list }))
		.sort((a, b) => b.items.length - a.items.length);
	return { groups, noSource };
}

/** 按知识点标签分组（每个标签一组，同项可入多组）；无标签的进入 untagged。 */
export function groupByTag<T>(items: T[], tagOf: (item: T) => string[]): { groups: KeyedGroup<T>[]; untagged: T[] } {
	const map = new Map<string, T[]>();
	const untagged: T[] = [];
	for (const item of items) {
		const tags = tagOf(item);
		if (tags.length === 0) { untagged.push(item); continue; }
		for (const tag of tags) {
			const list = map.get(tag);
			if (list) list.push(item); else map.set(tag, [item]);
		}
	}
	const groups = [...map.entries()]
		.map(([key, list]) => ({ key, items: list }))
		.sort((a, b) => b.items.length - a.items.length);
	return { groups, untagged };
}

/** 文件大小显示（KB）。 */
export function formatFileSize(bytes: number): string {
	return Math.round(bytes / 1024).toLocaleString() + "KB";
}

/** 短日期（m/d）。 */
export function formatDateShort(ms: number): string {
	const d = new Date(ms);
	return (d.getMonth() + 1) + "/" + d.getDate();
}