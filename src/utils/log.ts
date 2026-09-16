/** 统一错误日志入口，避免把错误静默吞掉。 */
export function logError(context: string, err: unknown): void {
	console.error("[question-generator] " + context + ":", err);
}
