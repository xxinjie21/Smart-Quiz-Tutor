/** 本地时区日期工具。避免 toISOString() 取 UTC 日期导致非 UTC 用户日期偏移。 */

/** 返回本地时区的 YYYY-MM-DD。 */
export function localDateStr(d: Date = new Date()): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return y + "-" + m + "-" + day;
}

/** 在 YYYY-MM-DD 上加减天数，返回本地日期字符串。 */
export function addDaysStr(dateStr: string, n: number): string {
	const [y, m, d] = dateStr.split("-").map(Number);
	const dt = new Date(y || 0, (m || 1) - 1, d || 1);
	dt.setDate(dt.getDate() + n);
	return localDateStr(dt);
}