import { Hono, type Context } from "hono";
import { ApiError, isBillingApiError } from "../lib/billing-api-error.js";
import { billingOperations, COHUB_BILLING_FEATURES, COHUB_BILLING_TOKEN_TYPES, type CohubBillingFeatureKey } from "@cohub/billing";
import { config } from "../config.js";
import { jsonError } from "../lib/json-error.js";
import { getOptionalAuth, useAuth } from "../lib/middleware.js";

const router = new Hono();
const BILLING_PAGE_SIZE = 10;

function resolveTokenType(value: string | undefined) {
  const requestedTokenType = value?.trim();
  if (requestedTokenType && requestedTokenType !== COHUB_BILLING_TOKEN_TYPES.usdMicroCent) {
    return { error: "unsupported billing token type" as const };
  }
  return { tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent };
}

function parsePositiveInt(value: string | undefined, fallback: number, max: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function billingSettingsUrl(origin: string) {
  return new URL("/settings/billing", origin).toString();
}

function parseReturnUrl(value: unknown) {
  const fallback = config.webOrigin ? billingSettingsUrl(new URL(config.webOrigin).origin) : undefined;
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  try {
    const url = new URL(trimmed);
    if (!config.webOrigin) return fallback;
    const allowedOrigin = new URL(config.webOrigin).origin;
    if (url.origin !== allowedOrigin || url.pathname !== "/settings/billing") return fallback;
    return billingSettingsUrl(allowedOrigin);
  } catch {
    return fallback;
  }
}

async function readCheckoutBody(c: Context) {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError({
      status: 400,
      message: "Invalid JSON body",
      code: "invalid_json_body",
      responseBody: null,
    });
  }
}

function parsePurchaseId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError({ status: 400, message: "Invalid purchase ID", code: "invalid_purchase_id", responseBody: null });
  }
  return value;
}

function parseRedemptionCode(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parsePromotionCode(value: unknown) {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value.trim() : "";
}

const MAX_OFFER_KEY_LENGTH = 256;
const OFFER_REVISION_PATTERN = /^[a-f0-9]{64}$/i;

function parseOfferRef(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const key = typeof (value as { key?: unknown }).key === "string"
    ? (value as { key: string }).key.trim()
    : "";
  const revision = typeof (value as { revision?: unknown }).revision === "string"
    ? (value as { revision: string }).revision.trim()
    : "";
  return key &&
    key.length <= MAX_OFFER_KEY_LENGTH &&
    OFFER_REVISION_PATTERN.test(revision)
    ? { key, revision }
    : null;
}

function parseCheckoutDiscount(body: Record<string, unknown>) {
  const promotionCode = parsePromotionCode(body.promotionCode);
  const offer = parseOfferRef(body.offer);
  if (promotionCode === "") {
    throw new ApiError({
      status: 400,
      message: "Promotion code is invalid",
      code: "promotion_code_invalid",
      responseBody: null,
    });
  }
  if (offer === null) {
    throw new ApiError({
      status: 400,
      message: "Offer reference is invalid",
      code: "offer_ref_invalid",
      responseBody: null,
    });
  }
  if (promotionCode && offer) {
    throw new ApiError({
      status: 400,
      message: "Promotion code and automatic offer are mutually exclusive",
      code: "discount_selection_ambiguous",
      responseBody: null,
    });
  }
  return { promotionCode, offer };
}

function billingApiErrorResponse(c: Context, error: { status: number; message: string; code?: string }) {
  return jsonError(c, {
    status: error.status,
    message: error.message,
    code: error.code,
  });
}

const BILLING_FEATURE_KEYS = new Set<string>(Object.values(COHUB_BILLING_FEATURES));

function resolveBillingFeatureKey(value: string): CohubBillingFeatureKey | null {
  return BILLING_FEATURE_KEYS.has(value) ? value as CohubBillingFeatureKey : null;
}

router.get("/credits", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const resolved = resolveTokenType(c.req.query("tokenType"));
  if ("error" in resolved) return c.json({ message: resolved.error }, 400);
  const credit = await billingOperations.getCreditStatus({
    userId: user.uuid,
    tokenType: resolved.tokenType,
  });
  return c.json(credit);
});

router.get("/balance-activities", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const resolved = resolveTokenType(c.req.query("tokenType"));
  if ("error" in resolved) return c.json({ message: resolved.error }, 400);
  const activities = await billingOperations.listBalanceActivities({
    userId: user.uuid,
    tokenType: resolved.tokenType,
    page: parsePositiveInt(c.req.query("page"), 1, 10_000),
    limit: parsePositiveInt(c.req.query("limit"), BILLING_PAGE_SIZE, BILLING_PAGE_SIZE),
  });
  return c.json({ activities });
});

router.post("/checkout-confirmation", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  try {
    const body = await readCheckoutBody(c);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ message: "Request body must be an object" }, 400);
    }
    const productKey =
      typeof (body as { productKey?: unknown }).productKey === "string"
        ? (body as { productKey: string }).productKey.trim()
        : "";
    const checkoutId =
      typeof (body as { checkoutId?: unknown }).checkoutId === "string"
        ? (body as { checkoutId: string }).checkoutId.trim()
        : "";
    if (!productKey || !checkoutId) {
      return c.json({ message: "Product key and checkout ID are required" }, 400);
    }
    const confirmation = await billingOperations.resolveCheckoutConfirmation({
      userId: user.uuid,
      productKey,
      checkoutId,
    });
    return c.json({ confirmation });
  } catch (error) {
    if (isBillingApiError(error)) return billingApiErrorResponse(c, error);
    throw error;
  }
});

router.get("/catalog", async (c) => {
  const user = getOptionalAuth(c);
  try {
    const catalog = await billingOperations.getCatalog(
      user?.uuid ? { userId: user.uuid } : undefined,
    );
    return c.json({ catalog });
  } catch (error) {
    if (isBillingApiError(error)) return billingApiErrorResponse(c, error);
    throw error;
  }
});

router.get("/features/:featureKey", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const featureKey = resolveBillingFeatureKey(c.req.param("featureKey"));
  if (!featureKey) return c.json({ message: "unsupported billing feature" }, 400);
  try {
    const entitlement = await billingOperations.getFeatureEntitlement({
      userId: user.uuid,
      featureKey,
    });
    const deadlines = entitlement?.grants
      .map((grant) => grant.expires_at)
      .filter((value): value is string => value !== null && Date.parse(value) > Date.now()) ?? [];
    c.header("Cache-Control", "no-store");
    return c.json({
      enabled: Boolean(entitlement?.enabled),
      validUntil: deadlines.sort()[0] ?? null,
    });
  } catch (error) {
    if (isBillingApiError(error)) return billingApiErrorResponse(c, error);
    throw error;
  }
});

router.get("/subscriptions", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  try {
    const subscriptions = await billingOperations.listSubscriptions({
      userId: user.uuid,
      page: parsePositiveInt(c.req.query("page"), 1, 10_000),
      limit: parsePositiveInt(c.req.query("limit"), BILLING_PAGE_SIZE, BILLING_PAGE_SIZE),
    });
    return c.json({ subscriptions });
  } catch (error) {
    if (isBillingApiError(error)) return billingApiErrorResponse(c, error);
    throw error;
  }
});

router.post("/promotion-code-preview", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  try {
    const body = await readCheckoutBody(c) as Record<string, unknown>;
    const productKey = typeof body.productKey === "string" ? body.productKey.trim() : "";
    const promotionCode = parsePromotionCode(body.promotionCode);
    if (!productKey) return c.json({ message: "Product key is required" }, 400);
    if (!promotionCode) return c.json({ message: "Promotion code is required" }, 400);
    const preview = await billingOperations.previewPromotionCode({
      userId: user.uuid,
      productKey,
      promotionCode,
    });
    return c.json({ preview });
  } catch (error) {
    if (isBillingApiError(error)) return billingApiErrorResponse(c, error);
    throw error;
  }
});

router.post("/orders", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  try {
    const body = await readCheckoutBody(c);
    const productKey =
      typeof (body as { productKey?: unknown }).productKey === "string"
        ? (body as { productKey: string }).productKey.trim()
        : "";
    if (!productKey) return c.json({ message: "Product key is required" }, 400);
    const discount = parseCheckoutDiscount(body as Record<string, unknown>);
    const checkout = await billingOperations.purchaseAddon({
      userId: user.uuid,
      productKey,
      purchaseId: parsePurchaseId((body as { purchaseId?: unknown }).purchaseId),
      returnUrl: parseReturnUrl((body as { returnUrl?: unknown }).returnUrl),
      ...discount,
    });
    return c.json({ checkout });
  } catch (error) {
    if (isBillingApiError(error)) return billingApiErrorResponse(c, error);
    throw error;
  }
});

router.post("/subscriptions", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  try {
    const body = await readCheckoutBody(c);
    const productKey =
      typeof (body as { productKey?: unknown }).productKey === "string"
        ? (body as { productKey: string }).productKey.trim()
        : "";
    if (!productKey) return c.json({ message: "Product key is required" }, 400);
    const discount = parseCheckoutDiscount(body as Record<string, unknown>);
    const checkout = await billingOperations.createSubscription({
      userId: user.uuid,
      productKey,
      purchaseId: parsePurchaseId((body as { purchaseId?: unknown }).purchaseId),
      returnUrl: parseReturnUrl((body as { returnUrl?: unknown }).returnUrl),
      ...discount,
    });
    return c.json({ checkout });
  } catch (error) {
    if (isBillingApiError(error)) return billingApiErrorResponse(c, error);
    throw error;
  }
});

router.get("/subscriptions/:subscriptionId", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  try {
    const subscription = await billingOperations.getSubscription({ userId: user.uuid, subscriptionId: c.req.param("subscriptionId") });
    c.header("Cache-Control", "no-store");
    return c.json({ subscription });
  } catch (error) {
    if (isBillingApiError(error)) return billingApiErrorResponse(c, error);
    throw error;
  }
});

router.post("/subscriptions/:subscriptionId/payment-action", async (c) => {
  c.header("Cache-Control", "no-store");
  const user = useAuth(c);
  if (user instanceof Response) return user;
  try {
    return c.json(await billingOperations.getSubscriptionPaymentAction({ userId: user.uuid, subscriptionId: c.req.param("subscriptionId") }));
  } catch (error) {
    if (isBillingApiError(error)) return billingApiErrorResponse(c, error);
    throw error;
  }
});

router.delete("/subscriptions/:subscriptionId/checkout", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  try {
    const subscription = await billingOperations.cancelSubscriptionCheckout({
      userId: user.uuid,
      subscriptionId: c.req.param("subscriptionId"),
    });
    return c.json({ subscription });
  } catch (error) {
    if (isBillingApiError(error)) return billingApiErrorResponse(c, error);
    throw error;
  }
});

router.patch("/subscriptions/:subscriptionId", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  try {
    const body = await readCheckoutBody(c);
    if ((body as { cancelAtPeriodEnd?: unknown }).cancelAtPeriodEnd !== true) {
      return c.json({ message: "cancelAtPeriodEnd must be true" }, 400);
    }
    const subscription = await billingOperations.cancelSubscriptionAutoRenew({
      userId: user.uuid,
      subscriptionId: c.req.param("subscriptionId"),
    });
    return c.json({ subscription });
  } catch (error) {
    if (isBillingApiError(error)) return billingApiErrorResponse(c, error);
    throw error;
  }
});

router.post("/redemptions", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  try {
    const body = await readCheckoutBody(c);
    const code = parseRedemptionCode((body as { code?: unknown }).code);
    if (!code) return c.json({ message: "Redemption code is required" }, 400);
    const redemption = await billingOperations.redeemCode({
      userId: user.uuid,
      code,
    });
    return c.json({ redemption });
  } catch (error) {
    if (isBillingApiError(error)) return billingApiErrorResponse(c, error);
    throw error;
  }
});

export default router;
