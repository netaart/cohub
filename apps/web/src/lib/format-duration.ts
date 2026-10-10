import { toIntlTag } from "$lib/i18n/format";
import type { Locale } from "$lib/i18n/locale";

const UNIT_MS = {
	en: "ms",
	zh: "毫秒",
};

/**
 * Locale-aware short duration, e.g. "1m 30s" (en) / "1分 30秒" (zh-CN).
 * The unit names follow the requested locale so chat/tool/process meta bars
 * read naturally in Chinese without relying on a non-reactive runtime.
 */
export function formatDurationMs(ms: number, locale?: Locale): string {
	const zh = toIntlTag(locale) === "zh-CN";
	if (ms < 1000)
		return `${Math.max(1, Math.round(ms))}${zh ? "毫秒" : UNIT_MS.en}`;
	if (ms < 10_000) {
		const seconds = Math.round(ms / 100) / 10;
		if (seconds < 10) return `${seconds.toFixed(1)}${zh ? "秒" : "s"}`;
	}
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}${zh ? "秒" : "s"}`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60)
		return seconds > 0
			? `${zh ? `${totalMinutes}分 ${seconds}秒` : `${totalMinutes}m ${seconds}s`}`
			: `${totalMinutes}${zh ? "分" : "m"}`;
	const hours = Math.floor(totalMinutes / 60);
	const remainingMinutes = totalMinutes % 60;
	return remainingMinutes > 0
		? `${zh ? `${hours}时 ${remainingMinutes}分` : `${hours}h ${remainingMinutes}m`}`
		: `${hours}${zh ? "时" : "h"}`;
}

export function formatElapsedMs(ms: number, locale?: Locale): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60)
		return `${seconds}${toIntlTag(locale) === "zh-CN" ? "秒" : "s"}`;
	return formatDurationMs(Math.floor(seconds / 60) * 60_000, locale);
}

export function formatDurationDetail(
	ms: number,
	label = "Duration",
	locale?: Locale,
): string {
	return `${label}: ${formatDurationMs(ms, locale)} (${Math.round(ms).toLocaleString(toIntlTag(locale))} ms)`;
}

export function isDisplayableDurationMs(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}
