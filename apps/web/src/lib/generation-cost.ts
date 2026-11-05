import type { Usage } from "@cohub/protocol/core";
import { formatUsageCost, getUsageCostTotal } from "$lib/format-usage";
import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";

export type GenerationCostPresentation = {
	label: string;
	detail: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function formattedCost(value: unknown, locale?: Locale) {
	return typeof value === "number" && Number.isFinite(value)
		? formatUsageCost(value, locale)
		: "";
}

function readableReason(value: unknown) {
	return typeof value === "string" ? value.replaceAll("_", " ") : "";
}

export function getGenerationCostPresentation(
	input: {
		usage?: Usage | null;
		generation?: unknown;
	},
	locale?: Locale,
): GenerationCostPresentation | null {
	const generation = asRecord(input.generation);
	const billing = asRecord(generation?.billing);
	const status = billing?.status;
	const reason = billing?.reason;
	const charged = formattedCost(billing?.amountUsd, locale);
	const reserved = formattedCost(billing?.reservedAmountUsd, locale);
	const refunded = formattedCost(billing?.refundedAmountUsd, locale);
	const additional = formattedCost(billing?.additionalAmountUsd, locale);
	const providerCost = formattedCost(generation?.officialCostUsd, locale);
	const providerDetail = providerCost
		? m.cost_provider({ cost: providerCost }, { locale })
		: "";
	const reservationDetail = [
		reserved ? m.cost_reserved({ cost: reserved }, { locale }) : "",
		refunded ? m.cost_refunded({ cost: refunded }, { locale }) : "",
		additional ? m.cost_additional({ cost: additional }, { locale }) : "",
	]
		.filter(Boolean)
		.join("  ·  ");

	if ((status === "recorded" || status === "overage") && charged) {
		return {
			label: charged,
			detail: [
				m.cost_charged({ cost: charged }, { locale }),
				reservationDetail,
				providerDetail,
			]
				.filter(Boolean)
				.join("  ·  "),
		};
	}
	if (status === "skipped" && reason === "record_failed" && charged) {
		return {
			label: m.cost_pending({ cost: charged }, { locale }),
			detail: [
				m.cost_pending_charge({ cost: charged }, { locale }),
				reservationDetail,
				providerDetail,
				m.cost_billing_retry_scheduled({}, { locale }),
			]
				.filter(Boolean)
				.join("  ·  "),
		};
	}
	if (status === "skipped" && reserved) {
		const reasonText = readableReason(reason);
		return {
			label: m.cost_not_charged({ cost: reserved }, { locale }),
			detail: [
				m.cost_not_charged_label({}, { locale }),
				reservationDetail,
				reasonText ? m.cost_reason({ reason: reasonText }, { locale }) : "",
			]
				.filter(Boolean)
				.join("  ·  "),
		};
	}
	if (status === "skipped" && providerCost) {
		const reasonText = readableReason(reason);
		return {
			label: m.cost_not_charged({ cost: providerCost }, { locale }),
			detail: [
				m.cost_not_charged_label({}, { locale }),
				reservationDetail,
				providerDetail,
				reasonText ? m.cost_reason({ reason: reasonText }, { locale }) : "",
			]
				.filter(Boolean)
				.join("  ·  "),
		};
	}
	if (providerCost) {
		return { label: providerCost, detail: providerDetail };
	}

	const legacyCost = getUsageCostTotal(input.usage);
	if (legacyCost == null) return null;
	const label = formatUsageCost(legacyCost, locale);
	return label
		? { label, detail: m.chat_cost_label({ value: label }, { locale }) }
		: null;
}
