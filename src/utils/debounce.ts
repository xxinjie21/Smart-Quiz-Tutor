export function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
	let timer: number | null = null;
	return ((...args: Parameters<T>) => {
		if (timer !== null) window.clearTimeout(timer);
		timer = window.setTimeout(() => fn(...args), ms);
	}) as T;
}
