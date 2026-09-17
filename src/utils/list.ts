/** 列表搜索：query 是否命中任一字段（不区分大小写）。空查询视为命中。 */
export function matchQuery(query: string, fields: string[]): boolean {
	const q = (query || "").trim().toLowerCase();
	if (!q) return true;
	return fields.some(f => (f || "").toLowerCase().includes(q));
}