import { Hono, type Context } from "hono";
import * as z from "zod";
import { spaceWalletBillingOperations, COHUB_BILLING_TOKEN_TYPES, type BillingCatalogProduct } from "@cohub/billing";
import { spaceWalletCustomerId, SpaceWalletTransferError, walletCreditsUsable } from "@cohub/core/space-wallet";
import { spaces } from "@cohub/db";
import { createLogger } from "@cohub/infra/logging";
import {
  SPACE_WALLET_TRANSFER_MAX_USD,
  SPACE_WALLET_TRANSFER_MIN_USD,
  type SpaceWalletActivity,
  type SpaceWalletActivityPage,
  type SpaceWalletFunding,
  type SpaceWalletSummary,
} from "@cohub/protocol";
import { eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/index.js";
import { authzDenied, getOptionalAuth, getSpacePublicProfile, requireValidId, useAuth, type RequestPrincipal } from "../../lib/middleware.js";
import { isBillingApiError } from "../../lib/billing-api-error.js";
import { hasPermission } from "../../permissions.js";
import { dispatchSpaceWalletUpdated, spaceWalletTransfers } from "../../space-wallet-billing.js";
import { getProfilesByUuids } from "../../user-profiles.js";

const logger = createLogger({ serviceName: "cohub-api" });

type WalletSpace = { id: string; name: string; avatarUrl: string | null; description: string | null; publicFunding: boolean };
type WalletEnv = { Variables: { walletSpace: WalletSpace } };
type WalletContext = Context<WalletEnv>;
const router = new Hono<WalletEnv>();
const orderSchema = z.object({
  id: z.uuid(),
  productKey: z.string().min(1).max(256),
  returnPath: z.string().max(1024).regex(/^\/(?![/\\])/).optional(),
});
const transferSchema = z.object({
  id: z.uuid(),
  amountUsd: z.number().int().min(SPACE_WALLET_TRANSFER_MIN_USD).max(SPACE_WALLET_TRANSFER_MAX_USD),
});
const pageSchema = z.coerce.number().int().min(1).max(10_000).default(1);
const ACTOR_PATTERN = /^actor_user_id=([^;]+); /;
const decodeActor = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

router.use("*", async (c, next) => {
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "Space not found" }, 404);
  const [row] = await db.select({ id: spaces.id, name: spaces.name, description: spaces.description, meta: spaces.meta }).from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!row) return c.json({ message: "Space not found" }, 404);
  const profile = getSpacePublicProfile(row);
  c.set("walletSpace", { id: row.id, name: row.name?.trim() || "Space", avatarUrl: profile.avatarUrl, description: row.description?.trim() || null, publicFunding: profile.fundingEnabled });
  await next();
});

const canView = (c: WalletContext) => hasPermission(getOptionalAuth(c), "space.view", { spaceId: c.get("walletSpace").id });

async function fundAccess(c: WalletContext) {
  const space = c.get("walletSpace");
  return space.publicFunding || await canView(c);
}

async function requireViewer(c: WalletContext) {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  if (!(await canView(c))) return authzDenied(c);
  return user;
}

async function requireFunder(c: WalletContext) {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  if (!(await fundAccess(c))) return authzDenied(c);
  return user;
}

function rechargeProducts(products: BillingCatalogProduct[]) {
  const tokenType = COHUB_BILLING_TOKEN_TYPES.usdMicroCent;
  return products.filter((product) =>
    product.display.creditBenefits.some((benefit) => benefit.tokenType === tokenType && benefit.grantKind === "purchased" && benefit.cycleAmount > 0) &&
    product.display.creditBenefits.every((benefit) => benefit.tokenType !== tokenType || (benefit.grantKind === "purchased" && benefit.scope === "business")),
  ).map((product) => ({ ...product, offer: null, promotion: null }));
}

async function walletCatalog() {
  if (!spaceWalletBillingOperations.status.configured) return { supported: false, products: [], paymentAvailable: false };
  const catalog = await spaceWalletBillingOperations.getCatalog();
  return { supported: catalog.billing.configured, products: rechargeProducts(catalog.addons), paymentAvailable: catalog.payment.available };
}

const creditedUsd = (product: BillingCatalogProduct) => product.display.creditBenefits
  .filter((benefit) => benefit.tokenType === COHUB_BILLING_TOKEN_TYPES.usdMicroCent)
  .reduce((total, benefit) => total + benefit.cycleAmountUsd, 0);

function transferError(c: Context, error: SpaceWalletTransferError) {
  const status = error.code === "transfer_busy" || error.code === "transfer_conflict" ? 409 : error.code === "transfer_amount_invalid" ? 400 : 422;
  return c.json({ message: error.message, code: error.code }, status);
}

const isDirectUser = (c: Context) => (c.get("principal") as RequestPrincipal | null | undefined)?.type === "user";

router.get("/", async (c) => {
  const user = await requireViewer(c);
  if (user instanceof Response) return user;
  const spaceId = c.get("walletSpace").id;
  if (!spaceWalletBillingOperations.status.configured) {
    return c.json({ spaceId, balanceUsd: 0, usable: false } satisfies SpaceWalletSummary);
  }
  const credit = await spaceWalletBillingOperations.getCreditStatus({ userId: spaceWalletCustomerId(spaceId), createCustomer: false });
  return c.json({ spaceId, balanceUsd: credit.netUsd, usable: walletCreditsUsable(credit) } satisfies SpaceWalletSummary);
});

router.get("/catalog", async (c) => {
  const user = await requireViewer(c);
  if (user instanceof Response) return user;
  return c.json(await walletCatalog());
});

router.get("/funding", async (c) => {
  if (!(await fundAccess(c))) return authzDenied(c);
  const space = c.get("walletSpace");
  const user = getOptionalAuth(c);
  const transfersOn = !!user && isDirectUser(c) && spaceWalletTransfers.configured();
  const [catalog, allowanceUsd] = await Promise.all([
    walletCatalog(),
    transfersOn ? spaceWalletTransfers.allowance(user.uuid).catch((error) => {
      logger.warn("Space wallet allowance unavailable", { spaceId: space.id, error });
      return null;
    }) : null,
  ]);
  return c.json({
    space: { id: space.id, name: space.name, avatarUrl: space.avatarUrl, description: space.description },
    publicFunding: space.publicFunding,
    checkout: catalog.paymentAvailable,
    tiers: catalog.products
      .map((product) => ({ productKey: product.key, amountUsd: creditedUsd(product), priceUsd: product.pricing.amountUsd }))
      .sort((a, b) => a.amountUsd - b.amountUsd),
    transfer: allowanceUsd === null ? null : { allowanceUsd, minUsd: SPACE_WALLET_TRANSFER_MIN_USD, maxUsd: SPACE_WALLET_TRANSFER_MAX_USD },
  } satisfies SpaceWalletFunding);
});

router.get("/activities", async (c) => {
  const user = await requireViewer(c);
  if (user instanceof Response) return user;
  const spaceId = c.get("walletSpace").id;
  const parsed = pageSchema.safeParse(c.req.query("page"));
  if (!parsed.success) return c.json({ message: "Invalid page" }, 400);
  if (!spaceWalletBillingOperations.status.configured) return c.json({ items: [], hasMore: false } satisfies SpaceWalletActivityPage);
  const activities = await spaceWalletBillingOperations.listBalanceActivities({ userId: spaceWalletCustomerId(spaceId), page: parsed.data, limit: 10, createCustomer: false, transactionLedger: true });
  const items: SpaceWalletActivity[] = [];
  for (const item of activities.items) {
    const actor = item.description?.match(ACTOR_PATTERN)?.[1];
    const previous = items.at(-1);
    if (previous && item.kind === "grant" && previous.kind === "grant" && item.sourceId?.startsWith("cohub:swt:") && previous.sourceId === item.sourceId) {
      previous.amountUsd += item.amountUsd;
      continue;
    }
    items.push({
      id: item.id, kind: item.kind, title: item.title,
      amountUsd: item.amountUsd, createdAt: item.createdAt, sourceId: item.sourceId,
      actorUserId: actor ? decodeActor(actor) : null,
    });
  }
  return c.json({ items, hasMore: activities.pagination.hasMore } satisfies SpaceWalletActivityPage);
});

router.post("/orders", async (c) => {
  const user = await requireFunder(c);
  if (user instanceof Response) return user;
  const spaceId = c.get("walletSpace").id;
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
  const { id, productKey, returnPath } = parsed.data;
  let returnUrl: string | undefined;
  if (config.webOrigin) {
    const url = new URL(returnPath ?? `/spaces/${spaceId}/wallet`, config.webOrigin);
    // URL parsing drops tabs/newlines, so only the resolved origin proves the path stays on site.
    if (url.origin !== new URL(config.webOrigin).origin) return c.json({ message: "Invalid wallet order" }, 400);
    url.searchParams.set("wallet_order", id);
    url.searchParams.set("wallet_space", spaceId);
    returnUrl = url.toString();
  }
  const checkout = await spaceWalletBillingOperations.purchaseAddon({ userId, productKey, returnUrl,
    walletCheckout: { id, actorUserId: user.uuid, spaceId },
  });
  return c.json({ checkout, orderId: id });
});

router.get("/orders/:orderId", async (c) => {
  const user = await requireFunder(c);
  if (user instanceof Response) return user;
  const spaceId = c.get("walletSpace").id;
  const requestId = c.req.param("orderId");
  if (!requireValidId(requestId)) return c.json({ message: "Order not found" }, 404);
  if (!spaceWalletBillingOperations.status.configured) return c.json({ message: "Space wallet billing business is not configured" }, 409);
  try {
    const confirmation = await spaceWalletBillingOperations.confirmSpaceWalletOrder({ userId: spaceWalletCustomerId(spaceId), requestId, actorUserId: user.uuid, spaceId });
    if (confirmation.settled) await dispatchSpaceWalletUpdated(spaceId);
    return c.json(confirmation);
  } catch (error) {
    if (isBillingApiError(error) && error.status === 404) return c.json({ message: "Order not found" }, 404);
    throw error;
  }
});

router.post("/transfers", async (c) => {
  const user = await requireFunder(c);
  if (user instanceof Response) return user;
  if (!isDirectUser(c)) return c.json({ message: "Balance transfers require a signed-in user session", code: "transfer_forbidden" }, 403);
  const parsed = transferSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ message: `Amount must be a whole number of USD between ${SPACE_WALLET_TRANSFER_MIN_USD} and ${SPACE_WALLET_TRANSFER_MAX_USD}`, code: "transfer_amount_invalid" }, 400);
  const space = c.get("walletSpace");
  const profile = (await getProfilesByUuids([user.uuid])).get(user.uuid);
  try {
    return c.json(await spaceWalletTransfers.start({
      id: parsed.data.id,
      amountUsd: parsed.data.amountUsd,
      spaceId: space.id,
      spaceName: space.name,
      userId: user.uuid,
      actorName: profile?.username ? `@${profile.username}` : profile?.displayName ?? "a contributor",
    }));
  } catch (error) {
    if (error instanceof SpaceWalletTransferError) return transferError(c, error);
    throw error;
  }
});

router.get("/transfers/:transferId", async (c) => {
  const user = await requireFunder(c);
  if (user instanceof Response) return user;
  const id = c.req.param("transferId");
  if (!z.uuid().safeParse(id).success) return c.json({ message: "Transfer not found" }, 404);
  const space = c.get("walletSpace");
  return c.json(await spaceWalletTransfers.status({ id, spaceId: space.id, spaceName: space.name, userId: user.uuid, actorName: "" }));
});

export default router;
