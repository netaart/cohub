import type { ModelOffer } from "@cohub/protocol";
import type { GenerationModelPricing } from "@cohub/protocol/generation";
import { formatCurrency, formatDate } from "#lib/i18n/format.ts";
import type { Locale } from "#lib/i18n/locale.ts";
import { m } from "#lib/paraglide/messages.js";

const HOUR_MS = 60 * 60 * 1000;

export function formatPriceValue(
	value: unknown,
	locale: Locale,
): string | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value === 0)
		return null;
	const magnitude = Math.abs(value);
	const digits =
		magnitude < 0.01
			? 4
			: magnitude >= 1 && value === Math.floor(value)
				? 0
				: 2;
	return formatCurrency(value, "USD", {
		locale,
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	});
}

/** `$0.25 / sec`, `$3.3–5.6 / 1M tokens`, scaled by an offer multiplier when given. */
export function formatGenerationPrice(
	pricing: GenerationModelPricing | null | undefined,
	locale: Locale,
	multiplier = 1,
): string {
	if (!pricing || typeof pricing !== "object") return "";
	const unit = {
		image: m.model_price_unit_image({}, { locale }),
		second: m.model_price_unit_second({}, { locale }),
		request: m.model_price_unit_request({}, { locale }),
		"1m_tokens": m.model_price_unit_1m_tokens({}, { locale }),
	}[pricing.unit];
	const format = (value: number | undefined) =>
		value === undefined ? null : formatPriceValue(value * multiplier, locale);
	const amount = format(pricing.amount);
	if (amount) return `${amount} / ${unit}`;
	const min = format(pricing.min);
	const max = format(pricing.max);
	if (min && max) return `${min}\u2013${max} / ${unit}`;
	if (min ?? max)
		return `${m.model_price_from({}, { locale })} ${min ?? max} / ${unit}`;
	return "";
}

/** An offer the client should still show; expired offers drop out without refetching. */
export function liveOffer(
	offer: ModelOffer | null | undefined,
	now = Date.now(),
): ModelOffer | null {
	if (!offer || offer.multiplier >= 1) return null;
	if (offer.endsAt && Date.parse(offer.endsAt) <= now) return null;
	return offer;
}

/** `-50%`, or "Free" for a zero multiplier. */
export function multiplierLabel(multiplier: number, locale: Locale): string {
	return multiplier === 0
		? m.pricing_offer_free({}, { locale })
		: `-${Math.round((1 - multiplier) * 100)}%`;
}

/** "5h left" inside the final day, otherwise "until Nov 23". */
export function offerDeadline(
	offer: ModelOffer,
	locale: Locale,
	now = Date.now(),
): string {
	if (!offer.endsAt) return "";
	const remaining = Date.parse(offer.endsAt) - now;
	if (remaining <= 0) return "";
	if (remaining < HOUR_MS)
		return m.pricing_offer_minutes_left(
			{ minutes: Math.max(1, Math.ceil(remaining / 60_000)) },
			{ locale },
		);
	if (remaining < 24 * HOUR_MS)
		return m.pricing_offer_hours_left(
			{ hours: Math.ceil(remaining / HOUR_MS) },
			{ locale },
		);
	return m.pricing_offer_until(
		{ date: formatDate(offer.endsAt, locale, { year: undefined }) },
		{ locale },
	);
}

/** Quota units are whole request-parameter units; only well-known parameters get a unit label. */
export function formatQuotaAmount(
	amount: number,
	parameter: string | null | undefined,
	locale: Locale,
): string {
	const unit =
		parameter === "duration" ? m.model_price_unit_second({}, { locale }) : "";
	return unit ? `${amount} ${unit}` : String(amount);
}
