import { formatCurrency } from "$lib/i18n/format";
import type { Locale } from "$lib/i18n/locale";

/**
 * Price formatting for purchase surfaces: whole dollars stay whole ("$50"),
 * anything else shows cents ("$24.50"). Keeps hero figures short without
 * hiding real fractions from a discount.
 */
export function formatPrice(value: number, locale: Locale): string {
	const whole = Number.isInteger(value);
	return formatCurrency(value, "USD", {
		locale,
		minimumFractionDigits: whole ? 0 : 2,
		maximumFractionDigits: 2,
	});
}

/** Exact money as it appears on an invoice line. */
export function formatMoney(value: number, locale: Locale): string {
	return formatCurrency(value, "USD", {
		locale,
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
}

export function formatBalance(value: number, locale: Locale): string {
	return formatCurrency(value, "USD", { locale });
}
