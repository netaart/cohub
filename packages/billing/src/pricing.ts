import { resolveGenerationModelDiscount } from "./generation-usage.js";
import { COHUB_BILLING_TOKEN_TYPES, type BillingActiveBenefit } from "./interfaces.js";

export const BILLING_PRICING_SCHEMA = "cohub.billing.pricing.v1";

/** Pricing rules only reach metered generation usage; money movement and infrastructure stay at list price. */
const PRICEABLE_USAGE_ROOT = "generation";
const RULE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type PricingPayer = "personal" | "space_wallet";

export type PricingRuleConditions = {
  usageTypes: readonly string[] | null;
  models: readonly string[] | null;
  providers: readonly string[] | null;
  /** Entitlement benefit keys; any match qualifies. Benefit rules never price Space wallet charges. */
  benefits: readonly string[] | null;
  startsAt: number | null;
  endsAt: number | null;
};

export type PricingRuleEffect =
  | { type: "multiplier"; multiplier: number }
  /** Covers the request from the user's own `tokenType` balance, one unit per unit of `parameter`. */
  | { type: "quota"; tokenType: string; parameter: string };

export type PricingRule = {
  key: string;
  enabled: boolean;
  announce: boolean;
  when: PricingRuleConditions;
  effect: PricingRuleEffect;
};

export type PricingConfig = { rules: readonly PricingRule[] };

export const EMPTY_PRICING_CONFIG: PricingConfig = { rules: [] };

export type PricingDiscount = {
  multiplier: number;
  source: "rule" | "benefit" | null;
  key: string | null;
};

export type PricingQuota = { ruleKey: string; tokenType: string; parameter: string };

export type PricingQuote = {
  resolvedAt: string;
  personal: PricingDiscount;
  spaceWallet: PricingDiscount;
  quota: PricingQuota | null;
};

export type PricingSubject = {
  usageType: string;
  model: string;
  provider?: string | null;
  /** When the usage happened; rules are matched against this instant, not the charge time. */
  at?: Date;
  /** Include per-model benefit metadata discounts (`pro_model_discount_v1` and friends). */
  modelDiscounts?: boolean;
};

/** Public view of the caller's best personal price for one model, for pickers and badges. */
export type PricingOffer = {
  multiplier: number;
  ruleKey: string | null;
  endsAt: string | null;
  announce: boolean;
};

export type PricingModelOffer = {
  offer: PricingOffer | null;
  quota: { tokenType: string; parameter: string } | null;
};

export class PricingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingConfigError";
  }
}

const NO_DISCOUNT: PricingDiscount = { multiplier: 1, source: null, key: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], where: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new PricingConfigError(`${where}: unknown field "${key}"`);
  }
}

function stringList(value: unknown, where: string): readonly string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0) throw new PricingConfigError(`${where} must be a non-empty list`);
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new PricingConfigError(`${where} must contain non-empty strings`);
    return item.trim();
  });
}

function instant(value: unknown, where: string): number | null {
  if (value === undefined || value === null) return null;
  const text = value instanceof Date ? value.toISOString() : value;
  // Require an explicit offset so a rule never shifts with the server time zone.
  if (typeof text !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(text.trim())) {
    throw new PricingConfigError(`${where} must be an ISO date-time with a time zone offset`);
  }
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new PricingConfigError(`${where} must be an ISO date-time with a time zone offset`);
  return ms;
}

function isPriceableUsageType(pattern: string) {
  const base = pattern.endsWith(".*") ? pattern.slice(0, -2) : pattern;
  return base === PRICEABLE_USAGE_ROOT || base.startsWith(`${PRICEABLE_USAGE_ROOT}.`);
}

function parseConditions(value: unknown, where: string): PricingRuleConditions {
  if (value === undefined || value === null) {
    return { usageTypes: null, models: null, providers: null, benefits: null, startsAt: null, endsAt: null };
  }
  if (!isRecord(value)) throw new PricingConfigError(`${where} must be an object`);
  assertKnownKeys(value, ["usageTypes", "models", "providers", "benefits", "startsAt", "endsAt"], where);
  const usageTypes = stringList(value.usageTypes, `${where}.usageTypes`);
  for (const pattern of usageTypes ?? []) {
    if (!isPriceableUsageType(pattern)) {
      throw new PricingConfigError(`${where}.usageTypes: "${pattern}" is outside ${PRICEABLE_USAGE_ROOT}.*`);
    }
  }
  const startsAt = instant(value.startsAt, `${where}.startsAt`);
  const endsAt = instant(value.endsAt, `${where}.endsAt`);
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt) {
    throw new PricingConfigError(`${where}.endsAt must be after startsAt`);
  }
  return {
    usageTypes,
    models: stringList(value.models, `${where}.models`),
    providers: stringList(value.providers, `${where}.providers`),
    benefits: stringList(value.benefits, `${where}.benefits`),
    startsAt,
    endsAt,
  };
}

/** Usage settled after the fact (LLM turns, completions, decisions) has no admission step to draw quota at. */
const UNQUOTABLE_USAGE_TYPES = ["generation.llm", "generation.llm.raw", "generation.decision"];

function assertQuotaUsageTypes(usageTypes: readonly string[] | null, where: string) {
  if (!usageTypes) throw new PricingConfigError(`${where} is required for quota rules`);
  for (const pattern of usageTypes) {
    const blocked = UNQUOTABLE_USAGE_TYPES.find((usageType) => usageTypeMatches([pattern], usageType));
    if (blocked) throw new PricingConfigError(`${where}: quota does not apply to ${blocked}`);
  }
}

function parseEffect(value: unknown, where: string): PricingRuleEffect {
  if (!isRecord(value)) throw new PricingConfigError(`${where} must be an object`);
  assertKnownKeys(value, ["multiplier", "quota"], where);
  if ((value.multiplier === undefined) === (value.quota === undefined)) {
    throw new PricingConfigError(`${where} must set exactly one of multiplier or quota`);
  }
  if (value.multiplier !== undefined) {
    const multiplier = value.multiplier;
    if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier < 0 || multiplier > 1) {
      throw new PricingConfigError(`${where}.multiplier must be a number between 0 and 1`);
    }
    return { type: "multiplier", multiplier };
  }
  const quota = value.quota;
  if (!isRecord(quota)) throw new PricingConfigError(`${where}.quota must be an object`);
  assertKnownKeys(quota, ["tokenType", "parameter"], `${where}.quota`);
  const { tokenType, parameter } = quota;
  if (typeof tokenType !== "string" || !tokenType.trim()) throw new PricingConfigError(`${where}.quota.tokenType is required`);
  if (Object.values(COHUB_BILLING_TOKEN_TYPES).includes(tokenType.trim() as never)) {
    throw new PricingConfigError(`${where}.quota.tokenType must be a dedicated quota token, not ${tokenType.trim()}`);
  }
  if (typeof parameter !== "string" || !parameter.trim()) throw new PricingConfigError(`${where}.quota.parameter is required`);
  return { type: "quota", tokenType: tokenType.trim(), parameter: parameter.trim() };
}

/** Validates a parsed `pricing.yaml` document. Unknown fields are rejected so typos never silently widen a rule. */
export function parsePricingConfig(document: unknown): PricingConfig {
  if (document === null || document === undefined) return EMPTY_PRICING_CONFIG;
  if (!isRecord(document)) throw new PricingConfigError("Pricing config must be an object");
  assertKnownKeys(document, ["schema", "rules"], "Pricing config");
  if (document.schema !== undefined && document.schema !== BILLING_PRICING_SCHEMA) {
    throw new PricingConfigError(`Unsupported pricing config schema: ${String(document.schema)}`);
  }
  if (document.rules === undefined || document.rules === null) return EMPTY_PRICING_CONFIG;
  if (!Array.isArray(document.rules)) throw new PricingConfigError("Pricing config rules must be a list");
  const keys = new Set<string>();
  const rules = document.rules.map((raw, index): PricingRule => {
    const where = `rules[${index}]`;
    if (!isRecord(raw)) throw new PricingConfigError(`${where} must be an object`);
    assertKnownKeys(raw, ["key", "enabled", "announce", "when", "effect"], where);
    const key = typeof raw.key === "string" ? raw.key.trim() : "";
    if (!RULE_KEY_PATTERN.test(key)) throw new PricingConfigError(`${where}.key must match ${RULE_KEY_PATTERN}`);
    if (keys.has(key)) throw new PricingConfigError(`${where}.key "${key}" is duplicated`);
    keys.add(key);
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new PricingConfigError(`${where}.enabled must be a boolean`);
    if (raw.announce !== undefined && typeof raw.announce !== "boolean") throw new PricingConfigError(`${where}.announce must be a boolean`);
    const when = parseConditions(raw.when, `${key}.when`);
    const effect = parseEffect(raw.effect, `${key}.effect`);
    if (effect.type === "quota") assertQuotaUsageTypes(when.usageTypes, `${key}.when.usageTypes`);
    return { key, enabled: raw.enabled !== false, announce: raw.announce === true, when, effect };
  });
  return { rules };
}

function usageTypeMatches(patterns: readonly string[], usageType: string) {
  return patterns.some((pattern) => {
    if (!pattern.endsWith(".*")) return pattern === usageType;
    const base = pattern.slice(0, -2);
    return usageType === base || usageType.startsWith(`${base}.`);
  });
}

/** Everything except benefits, which depend on who is asking. */
function matchesUsage(rule: PricingRule, subject: PricingSubject, at: number) {
  const { when } = rule;
  if (!rule.enabled) return false;
  if (!isPriceableUsageType(subject.usageType)) return false;
  if (when.startsAt !== null && at < when.startsAt) return false;
  if (when.endsAt !== null && at >= when.endsAt) return false;
  if (when.usageTypes && !usageTypeMatches(when.usageTypes, subject.usageType)) return false;
  if (when.models && !when.models.includes(subject.model)) return false;
  if (when.providers && !(subject.provider && when.providers.includes(subject.provider))) return false;
  return true;
}

function candidatesFor(config: PricingConfig, subject: PricingSubject, at: Date) {
  return config.rules.filter((rule) => matchesUsage(rule, subject, at.getTime()));
}

function needsBenefits(subject: PricingSubject, candidates: readonly PricingRule[]) {
  return subject.modelDiscounts === true || candidates.some((rule) => rule.when.benefits);
}

/** Whether pricing this usage would read the user's benefits. */
export function pricingNeedsBenefits(config: PricingConfig, subject: PricingSubject): boolean {
  return needsBenefits(subject, candidatesFor(config, subject, subject.at ?? new Date()));
}

function lowest(current: PricingDiscount, candidate: PricingDiscount) {
  return candidate.multiplier < current.multiplier ? candidate : current;
}

/**
 * Prices one usage for both possible payers. The lowest multiplier wins (no stacking); a quota rule is
 * reported separately because it is settled against its own balance before any money changes hands.
 * Benefits load lazily: only when a candidate rule or a per-model benefit discount needs them.
 */
export async function quotePricing(input: {
  config: PricingConfig;
  subject: PricingSubject;
  loadBenefits: () => Promise<readonly BillingActiveBenefit[]>;
}): Promise<PricingQuote> {
  const at = input.subject.at ?? new Date();
  const candidates = candidatesFor(input.config, input.subject, at);
  const benefits = needsBenefits(input.subject, candidates) ? await input.loadBenefits() : [];
  const held = new Set(benefits.filter((benefit) => benefit.enabled).map((benefit) => benefit.benefitKey));

  let personal = NO_DISCOUNT;
  let spaceWallet = NO_DISCOUNT;
  let quota: PricingQuota | null = null;
  for (const rule of candidates) {
    if (rule.when.benefits && !rule.when.benefits.some((key) => held.has(key))) continue;
    if (rule.effect.type === "quota") {
      quota ??= { ruleKey: rule.key, tokenType: rule.effect.tokenType, parameter: rule.effect.parameter };
      continue;
    }
    const discount: PricingDiscount = { multiplier: rule.effect.multiplier, source: "rule", key: rule.key };
    // Every wallet rule also prices personal charges, so the wallet price is never below the personal one.
    personal = lowest(personal, discount);
    if (!rule.when.benefits) spaceWallet = lowest(spaceWallet, discount);
  }
  if (input.subject.modelDiscounts) {
    const modelDiscount = resolveGenerationModelDiscount({ model: input.subject.model, entitlements: benefits });
    if (modelDiscount.benefitKey) {
      personal = lowest(personal, { multiplier: modelDiscount.multiplier, source: "benefit", key: modelDiscount.benefitKey });
    }
  }
  return { resolvedAt: at.toISOString(), personal, spaceWallet, quota };
}

/** The caller's personal view of a quote, with the end of the winning rule for countdowns. */
export function describePricingOffer(config: PricingConfig, quote: PricingQuote): PricingModelOffer {
  const rule = quote.personal.source === "rule" ? config.rules.find((item) => item.key === quote.personal.key) : undefined;
  const offer = quote.personal.multiplier < 1
    ? {
        multiplier: quote.personal.multiplier,
        ruleKey: rule?.key ?? null,
        endsAt: rule?.when.endsAt != null ? new Date(rule.when.endsAt).toISOString() : null,
        announce: rule?.announce ?? false,
      }
    : null;
  return {
    offer,
    quota: quote.quota ? { tokenType: quote.quota.tokenType, parameter: quote.quota.parameter } : null,
  };
}

export function pricingDiscountFor(quote: Pick<PricingQuote, "personal" | "spaceWallet">, payer: PricingPayer): PricingDiscount {
  return payer === "space_wallet" ? quote.spaceWallet : quote.personal;
}

/** What a queued generation was admitted at; the worker charges from this instead of re-pricing. */
export type PricingSnapshot = {
  resolvedAt: string;
  personal: PricingDiscount;
  spaceWallet: PricingDiscount;
  /** Units drawn from the user's quota at admission; `covered` of `requested` are already paid for. */
  quota: { ruleKey: string; tokenType: string; requested: number; covered: number } | null;
};

/** The share of the list price a payer still owes after quota coverage and its discount. */
export function snapshotMultiplier(snapshot: PricingSnapshot, payer: PricingPayer): number {
  const { multiplier } = pricingDiscountFor(snapshot, payer);
  const quota = snapshot.quota;
  const uncovered = quota && quota.requested > 0 ? Math.max(0, quota.requested - quota.covered) / quota.requested : 1;
  return Number((multiplier * uncovered).toFixed(12));
}

/** Personal benefits that make a usage free win over routing it to a Space wallet. */
export function isPricingSnapshotFree(snapshot: PricingSnapshot): boolean {
  return snapshotMultiplier(snapshot, "personal") === 0;
}

function parseDiscount(value: unknown, where: string): PricingDiscount {
  if (!isRecord(value)) throw new Error(`${where} is required`);
  const { multiplier, source, key } = value;
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier < 0 || multiplier > 1) {
    throw new Error(`${where}.multiplier must be between 0 and 1`);
  }
  if (source !== null && source !== "rule" && source !== "benefit") throw new Error(`${where}.source is invalid`);
  if (key !== null && typeof key !== "string") throw new Error(`${where}.key is invalid`);
  return { multiplier, source, key };
}

function wholeUnits(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validates a snapshot read back from a queued task payload. */
export function parsePricingSnapshot(value: unknown, where = "pricing"): PricingSnapshot {
  if (!isRecord(value)) throw new Error(`${where} is required`);
  if (typeof value.resolvedAt !== "string" || !Number.isFinite(Date.parse(value.resolvedAt))) {
    throw new Error(`${where}.resolvedAt must be an ISO date-time`);
  }
  let quota: PricingSnapshot["quota"] = null;
  if (value.quota !== null && value.quota !== undefined) {
    if (!isRecord(value.quota)) throw new Error(`${where}.quota is invalid`);
    const { ruleKey, tokenType, requested, covered } = value.quota;
    if (typeof ruleKey !== "string" || typeof tokenType !== "string" || !wholeUnits(requested) || !wholeUnits(covered) || (covered as number) > (requested as number)) {
      throw new Error(`${where}.quota is invalid`);
    }
    quota = { ruleKey, tokenType, requested: requested as number, covered: covered as number };
  }
  return {
    resolvedAt: value.resolvedAt,
    personal: parseDiscount(value.personal, `${where}.personal`),
    spaceWallet: parseDiscount(value.spaceWallet, `${where}.spaceWallet`),
    quota,
  };
}

/** Pre-pricing payloads carried one multiplier that applied to every payer. */
export function legacyPricingSnapshot(multiplier: number, resolvedAt: string): PricingSnapshot {
  const discount: PricingDiscount = { multiplier, source: null, key: null };
  return { resolvedAt, personal: discount, spaceWallet: discount, quota: null };
}

/** Whole quota units a request asks for, read from the request parameter the quota rule names. */
export function quotaUnitsRequested(parameters: Record<string, unknown> | undefined, parameter: string): number {
  const value = parameters?.[parameter];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}
