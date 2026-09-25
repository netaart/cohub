export type BillingConversionLevel = "soft" | "hard";

export type BillingConversionReason =
  | "negative_balance"
  | "negative_balance_limit_exceeded"
  | "balance_not_positive"
  | "minimum_balance_not_met"
  | "feature_not_entitled";

export type BillingConversionAudience = "free" | "paid" | "unknown";

export type BillingPreferredOfferKind = "plan" | "upgrade" | "addon" | "mixed";

/** Shared HTTP error code for every plan entitlement gate (402). */
export const FEATURE_NOT_ENTITLED_ERROR_CODE = "feature_not_entitled" as const;

export type BillingConversionIntent = {
  level: BillingConversionLevel;
  reason: BillingConversionReason;
  audience: BillingConversionAudience;
  preferredOfferKind: BillingPreferredOfferKind;
  title: string;
  message: string;
  primaryAction: {
    label: string;
    action: "open_billing_conversion";
    /** Optional direct URL for clients without an in-app conversion action. */
    href?: string;
  };
  source: string;
};

export function createBillingConversionIntent(input: {
  level: BillingConversionLevel;
  reason: BillingConversionReason;
  source: string;
  audience?: BillingConversionAudience;
  preferredOfferKind?: BillingPreferredOfferKind;
  title?: string;
  message?: string;
}): BillingConversionIntent {
  const isHard = input.level === "hard";
  return {
    level: input.level,
    reason: input.reason,
    audience: input.audience ?? "unknown",
    preferredOfferKind: input.preferredOfferKind ?? "mixed",
    title: input.title ?? (isHard ? "Add credits to continue" : "Balance below zero"),
    message: input.message ?? (isHard
      ? "Your balance has passed the temporary usage limit. Add credits to resume AI requests."
      : "Your work can continue for now. Add credits to avoid interruption."),
    primaryAction: {
      label: isHard ? "Add credits" : "View options",
      action: "open_billing_conversion",
    },
    source: input.source,
  };
}

/**
 * Builds a hard conversion intent for entitlement-gated features (e.g. a
 * capability reserved for a paid plan). The resulting intent drives the
 * shared billing conversion UI so callers only need to provide copy.
 */
export function createFeatureGateConversionIntent(input: {
  source: string;
  title?: string;
  message?: string;
}): BillingConversionIntent {
  return {
    level: "hard",
    reason: "feature_not_entitled",
    audience: "unknown",
    preferredOfferKind: "upgrade",
    title: input.title ?? "Upgrade to continue",
    message: input.message ?? "This feature requires a higher plan.",
    primaryAction: {
      label: "View plans",
      action: "open_billing_conversion",
    },
    source: input.source,
  };
}
