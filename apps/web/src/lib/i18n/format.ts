import type { Locale } from "./locale";

/**
 * Locale-aware formatting primitives.
 *
 * All helpers are pure (free of Svelte runes) and take an explicit `locale`.
 * When omitted they default to the deterministic base locale (`en`), so
 * components that have not yet been wired to a reactive locale still render
 * stable, unlocalized output. Components that render localized output read the
 * reactive locale via `getLocale()` (locale.svelte) and pass it explicitly,
 * which also makes them re-render on language change.
 */

export type LocaleOrString = Locale | string;

export function toIntlTag(locale: LocaleOrString | undefined): string {
	const value = locale ?? "en";
	return value.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

// Caches are keyed by locale + option set. The app only renders a small set of
// formatter combinations per locale, so these maps stay bounded in practice.
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

function numberFormat(
	tag: string,
	options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
	const key = `${tag}|${JSON.stringify(options)}`;
	let format = numberFormats.get(key);
	if (!format) {
		format = new Intl.NumberFormat(tag, options);
		numberFormats.set(key, format);
	}
	return format;
}

/** Locale-aware integer formatting (`12,345`). */
export function formatNumber(value: number, locale?: LocaleOrString): string {
	return numberFormat(toIntlTag(locale), {}).format(value);
}

/** Locale-aware compact notation (`1.2K`, `3.4M`) for dense metric displays. */
export function formatCompactNumber(
	value: number,
	locale?: LocaleOrString,
): string {
	return numberFormat(toIntlTag(locale), {
		notation: "compact",
		maximumFractionDigits: 1,
	}).format(value);
}

function dateFormat(
	tag: string,
	options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
	const key = `${tag}|${JSON.stringify(options)}`;
	let format = dateFormats.get(key);
	if (!format) {
		format = new Intl.DateTimeFormat(tag, options);
		dateFormats.set(key, format);
	}
	return format;
}

function toDate(value: string | number | Date | null | undefined): Date | null {
	if (value == null) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** Locale-aware currency using the locale's symbol and placement rules. */
export function formatCurrency(
	value: number,
	currency: string,
	options: {
		locale?: LocaleOrString;
		minimumFractionDigits?: number;
		maximumFractionDigits?: number;
		signDisplay?: "auto" | "never" | "always" | "exceptZero";
	} = {},
): string {
	const tag = toIntlTag(options.locale);

	// Currency symbol + placement + sign all come from `Intl` so USD/CNY etc.
	// follow the right rules instead of hardcoding a `$` prefix. The fraction
	// digits are caller/tier-controlled so micro-costs keep precision. When only
	// one bound is supplied we derive the other without ever producing an
	// inverted (min > max) range, which `Intl` rejects with a RangeError.
	const fallback = magnitudeDigits(value);
	const hasMin = options.minimumFractionDigits !== undefined;
	const hasMax = options.maximumFractionDigits !== undefined;

	let minimumFractionDigits: number;
	let maximumFractionDigits: number;
	if (!hasMin && !hasMax) {
		minimumFractionDigits = fallback;
		maximumFractionDigits = fallback;
	} else if (!hasMin) {
		// Only `maximumFractionDigits`: show as few decimals as needed up to max.
		minimumFractionDigits = 0;
		maximumFractionDigits = options.maximumFractionDigits as number;
	} else if (!hasMax) {
		// Only `minimumFractionDigits`: make sure we can always hit at least it.
		minimumFractionDigits = options.minimumFractionDigits as number;
		maximumFractionDigits = Math.max(minimumFractionDigits, fallback);
	} else {
		minimumFractionDigits = options.minimumFractionDigits as number;
		maximumFractionDigits = options.maximumFractionDigits as number;
	}
	if (maximumFractionDigits < minimumFractionDigits) {
		maximumFractionDigits = minimumFractionDigits;
	}

	return numberFormat(tag, {
		style: "currency",
		currency,
		minimumFractionDigits,
		maximumFractionDigits,
		...(options.signDisplay ? { signDisplay: options.signDisplay } : {}),
	}).format(value);
}

function magnitudeDigits(value: number): number {
	const magnitude = Math.abs(value);
	return magnitude >= 1 || magnitude === 0 ? 2 : magnitude >= 0.01 ? 3 : 4;
}

function mergeDateOptions(
	defaults: Intl.DateTimeFormatOptions,
	options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormatOptions {
	// `Intl` forbids mixing style-based (`dateStyle`/`timeStyle`) with concrete
	// fields, so when a caller opts into styles we must not inject defaults.
	return options.dateStyle || options.timeStyle
		? { ...options }
		: { ...defaults, ...options };
}

/** Full date + time, e.g. "Aug 23, 2026, 1:45 PM" / "2026年8月23日 13:45". */
export function formatDateTime(
	value: string | number | Date | null | undefined,
	locale?: LocaleOrString,
	options: Intl.DateTimeFormatOptions = {},
): string {
	const date = toDate(value);
	if (!date) return "";
	const tag = toIntlTag(locale);
	return dateFormat(
		tag,
		mergeDateOptions(
			{
				year: "numeric",
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			},
			options,
		),
	).format(date);
}

/** Date only, e.g. "Aug 23, 2026" / "2026年8月23日". */
export function formatDate(
	value: string | number | Date | null | undefined,
	locale?: LocaleOrString,
	options: Intl.DateTimeFormatOptions = {},
): string {
	const date = toDate(value);
	if (!date) return "";
	const tag = toIntlTag(locale);
	return dateFormat(
		tag,
		mergeDateOptions(
			{ year: "numeric", month: "short", day: "numeric" },
			options,
		),
	).format(date);
}
