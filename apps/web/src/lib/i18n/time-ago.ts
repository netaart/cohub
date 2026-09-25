import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";

export function formatTimeAgo(at: number, now: number, locale: Locale) {
	const ms = now - at;
	if (!Number.isFinite(ms) || ms < 45_000)
		return m.time_just_now({}, { locale });
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return m.time_ago_min({ n: minutes }, { locale });
	const hours = Math.round(minutes / 60);
	return hours < 24
		? m.time_ago_hour({ n: hours }, { locale })
		: m.time_ago_day({ n: Math.round(hours / 24) }, { locale });
}
