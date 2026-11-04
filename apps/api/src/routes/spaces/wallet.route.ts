import { Hono } from "hono";
import { z } from "zod";
import { spaceWalletBillingOperations, COHUB_BILLING_TOKEN_TYPES } from "@cohub/billing";
import { spaceWalletCustomerId, walletCreditsUsable } from "@cohub/core/space-wallet";
import type { SpaceWalletActivityPage, SpaceWalletSummary } from "@cohub/protocol";
import { config } from "../../config.js";
import { authzDenied, requireValidId, useAuth } from "../../lib/middleware.js";
import { isBillingApiError } from "../../lib/billing-api-error.js";
import { hasPermission } from "../../permissions.js";
import { spaceWalletBilling } from "../../space-wallet-billing.js";

const router = new Hono<{ Variables: { walletSpaceId: string } }>();
const orderSchema = z.object({ id: z.uuid(), productKey: z.string().min(1).max(256) });
const pageSchema = z.coerce.number().int().min(1).max(10_000).default(1);

router.use("*", async (c, next) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "Space not found" }, 404);
  if (!(await hasPermission(user, "space.view", { spaceId }))) return authzDenied(c);
  c.set("walletSpaceId", spaceId);
  await next();
});

async function walletCatalog() {
  if (!spaceWalletBillingOperations.status.configured) return { supported: false, products: [], paymentAvailable: false };
  const catalog = await spaceWalletBillingOperations.getCatalog();
  const tokenType = COHUB_BILLING_TOKEN_TYPES.usdMicroCent;
  const products = catalog.addons.filter((product) =>
    product.display.creditBenefits.some((benefit) => benefit.tokenType === tokenType && benefit.grantKind === "purchased" && benefit.cycleAmount > 0) &&
    product.display.creditBenefits.every((benefit) => benefit.tokenType !== tokenType || (benefit.grantKind === "purchased" && benefit.scope === "business")),
  ).map((product) => ({ ...product, offer: null, promotion: null }));
  return { supported: catalog.billing.configured, products, paymentAvailable: catalog.payment.available };
}

router.get("/", async (c) => {
  const spaceId = c.get("walletSpaceId");
  if (!spaceWalletBillingOperations.status.configured) {
    return c.json({ spaceId, balanceUsd: 0, usable: false } satisfies SpaceWalletSummary);
  }
  const credit = await spaceWalletBillingOperations.getCreditStatus({ userId: spaceWalletCustomerId(spaceId), createCustomer: false });
  return c.json({ spaceId, balanceUsd: credit.netUsd, usable: walletCreditsUsable(credit) } satisfies SpaceWalletSummary);
});

router.get("/catalog", async (c) => c.json(await walletCatalog()));

router.get("/activities", async (c) => {
  const spaceId = c.get("walletSpaceId");
  const parsed = pageSchema.safeParse(c.req.query("page"));
  if (!parsed.success) return c.json({ message: "Invalid page" }, 400);
  if (!spaceWalletBillingOperations.status.configured) return c.json({ items: [], hasMore: false } satisfies SpaceWalletActivityPage);
  const activities = await spaceWalletBillingOperations.listBalanceActivities({ userId: spaceWalletCustomerId(spaceId), page: parsed.data, limit: 10, createCustomer: false, transactionLedger: true });
  return c.json({ items: activities.items.map((item) => ({
    id: item.id, kind: item.kind, title: item.title, generationPhase: item.generationPhase ?? null,
    amountUsd: item.amountUsd, createdAt: item.createdAt, sourceId: item.sourceId,
    actorUserId: null,
  })), hasMore: activities.pagination.hasMore } satisfies SpaceWalletActivityPage);
});

router.post("/orders", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.get("walletSpaceId");
  const parsed = orderSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ message: "Invalid wallet order" }, 400);
  if (!spaceWalletBillingOperations.status.configured) return c.json({ message: "Space wallet billing business is not configured", code: "wallet_business_unavailable" }, 409);
  const catalog = await walletCatalog();
  if (!catalog.paymentAvailable || !catalog.products.some((product) => product.key === parsed.data.productKey)) {
    return c.json({ message: "Wallet recharge product is unavailable" }, 409);
  }
  const userId = spaceWalletCustomerId(spaceId);
  const credit = await spaceWalletBillingOperations.getCreditStatus({ userId });
  if (!walletCreditsUsable(credit)) return c.json({ message: "Space wallet contains unsupported credits", code: "wallet_unsupported_credits" }, 409);
  const { id, productKey } = parsed.data;
  const returnUrl = config.webOrigin ? new URL(`/spaces/${spaceId}/wallet?wallet_order=${id}`, config.webOrigin).toString() : undefined;
  const checkout = await spaceWalletBillingOperations.purchaseAddon({ userId, productKey, returnUrl,
    walletCheckout: { id, actorUserId: user.uuid, spaceId },
  });
  return c.json({ checkout, orderId: id });
});

router.get("/orders/:orderId", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.get("walletSpaceId");
  const requestId = c.req.param("orderId");
  if (!requireValidId(requestId)) return c.json({ message: "Order not found" }, 404);
  if (!spaceWalletBillingOperations.status.configured) return c.json({ message: "Space wallet billing business is not configured" }, 409);
  try {
    const confirmation = await spaceWalletBillingOperations.confirmSpaceWalletOrder({ userId: spaceWalletCustomerId(spaceId), requestId, actorUserId: user.uuid, spaceId });
    if (confirmation.settled) spaceWalletBilling.invalidate(spaceId);
    return c.json(confirmation);
  } catch (error) {
    if (isBillingApiError(error) && error.status === 404) return c.json({ message: "Order not found" }, 404);
    throw error;
  }
});

export default router;
