import { Hono, type Context } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { appDomains, apps } from "@cohub/db";
import { getAppDomainEligibility, type AppDomainRow } from "@cohub/core/app-domains";
import {
  APP_DOMAIN_EXCLUSIVE_STATUSES,
  APP_DOMAIN_PRICE_USD,
  normalizeAppDomainHostname,
  type AppDomainErrorCode,
  type AppDomainListResponse,
} from "@cohub/protocol";
import { createLogger } from "@cohub/infra/logging";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { isPostgresUniqueViolation } from "../db/postgres-error.js";
import { authzDenied, requireValidId, useAuth } from "../lib/middleware.js";
import { hasPermission } from "../permissions.js";
import {
  APP_DOMAIN_FIRST_CHECK_DELAY_MS,
  appDomainBilling,
  claimAppDomainCheck,
  enqueueAppDomainCheck,
  isReservedAppDomain,
  newAppDomainToken,
  publishAppDomainRemoved,
  publishAppDomainUpdated,
  removeAppDomain,
  requestAppDomainRefresh,
  toAppDomainRecord,
} from "../app-domains.js";

const logger = createLogger({ serviceName: "cohub-api" });
const EXCLUSIVE = new Set<string>(APP_DOMAIN_EXCLUSIVE_STATUSES);

const domainError = (c: Context, status: 400 | 402 | 404 | 409 | 503, code: AppDomainErrorCode | "custom_domains_disabled" | "billing_unavailable", message: string) =>
  c.json({ code, message }, status);

async function loadManagedApp(c: Context) {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const appId = c.req.param("appId") ?? "";
  if (!requireValidId(appId)) return c.json({ message: "app not found" }, 404);
  const [app] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
  if (!app) return c.json({ message: "app not found" }, 404);
  if (!(await hasPermission(user, "app.manage", { spaceId: app.spaceId }))) return authzDenied(c);
  return { user, app };
}

async function loadAppDomain(appId: string, domainId: string | undefined) {
  if (!domainId || !requireValidId(domainId)) return null;
  const [row] = await db
    .select()
    .from(appDomains)
    .where(and(eq(appDomains.id, domainId), eq(appDomains.appId, appId)))
    .limit(1);
  return row ?? null;
}

/** Retries a failed binding under a new token; any earlier charge still counts. */
async function resetFailedAppDomain(row: AppDomainRow) {
  // A new token keeps an old TXT value from ever promoting this claim.
  const [reset] = await db
    .update(appDomains)
    .set({
      status: "pending",
      ...newAppDomainToken(),
      errorCode: null,
      errorMessage: null,
      verifiedAt: null,
      lastCheckedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(appDomains.id, row.id), eq(appDomains.status, "failed")))
    .returning();
  if (!reset) return null;
  await publishAppDomainUpdated(reset);
  await enqueueAppDomainCheck(reset.id, APP_DOMAIN_FIRST_CHECK_DELAY_MS);
  return reset;
}

function createAppDomainsRouter(): Hono {
  const router = new Hono();

  router.get("/:appId/domains", async (c) => {
    const loaded = await loadManagedApp(c);
    if (loaded instanceof Response) return loaded;
    const [rows, eligibility] = await Promise.all([
      db.select().from(appDomains).where(eq(appDomains.appId, loaded.app.id)),
      getAppDomainEligibility(db, loaded.app.id),
    ]);
    const body: AppDomainListResponse = {
      domains: rows.map(toAppDomainRecord),
      enabled: config.appCustomDomainsEnabled,
      eligible: eligibility === "eligible",
      priceUsd: APP_DOMAIN_PRICE_USD,
      cnameTarget: config.appCustomDomainsEnabled ? config.appCustomDomainCnameTarget : null,
    };
    return c.json(body);
  });

  router.post("/:appId/domains", async (c) => {
    const loaded = await loadManagedApp(c);
    if (loaded instanceof Response) return loaded;
    const { user, app } = loaded;
    if (!config.appCustomDomainsEnabled) {
      return domainError(c, 404, "custom_domains_disabled", "Custom domains are not enabled on this deployment");
    }
    const body = await c.req.json().catch(() => null) as { hostname?: unknown } | null;
    const hostname = typeof body?.hostname === "string" ? normalizeAppDomainHostname(body.hostname) : null;
    if (!hostname) return domainError(c, 400, "domain_invalid", "hostname must be a domain name such as app.example.com");
    if (isReservedAppDomain(hostname)) return domainError(c, 400, "domain_reserved", `${hostname} is reserved by Cohub`);
    if ((await getAppDomainEligibility(db, app.id)) !== "eligible") {
      return domainError(c, 409, "app_not_eligible", "Only published public web or port Apps can use a custom domain");
    }

    const [existing] = await db.select().from(appDomains).where(eq(appDomains.appId, app.id)).limit(1);
    if (existing && EXCLUSIVE.has(existing.status)) {
      if (existing.hostname === hostname) return c.json({ domain: toAppDomainRecord(existing) });
      return domainError(c, 409, "app_domain_exists", `Remove ${existing.hostname} before adding another domain`);
    }
    if (existing?.hostname === hostname) {
      if (existing.status === "pending") return c.json({ domain: toAppDomainRecord(existing) });
      const reset = await resetFailedAppDomain(existing);
      if (!reset) return c.json({ message: "domain changed concurrently; reload and retry" }, 409);
      return c.json({ domain: toAppDomainRecord(reset) });
    }

    try {
      if (!(await appDomainBilling.canAfford({ spaceId: app.spaceId, userId: user.uuid }))) {
        return domainError(c, 402, "insufficient_balance", `Balance must cover $${APP_DOMAIN_PRICE_USD} to add a custom domain`);
      }
    } catch (error) {
      logger.warn("[app-domains] balance check failed", { appId: app.id, error });
      return domainError(c, 503, "billing_unavailable", "Balance check is unavailable; try again shortly");
    }

    // A different hostname is a new binding with its own id (and its own charge).
    let result: { row: AppDomainRow; replaced: AppDomainRow | null } | "app_missing" | null = null;
    try {
      result = await db.transaction(async (tx) => {
        // App deletion takes the same lock, so a binding never outlives its App.
        const [locked] = await tx.select({ id: apps.id }).from(apps).where(eq(apps.id, app.id)).for("update");
        if (!locked) return "app_missing" as const;
        let replaced: AppDomainRow | null = null;
        if (existing) {
          [replaced = null] = await tx
            .delete(appDomains)
            .where(and(eq(appDomains.id, existing.id), inArray(appDomains.status, ["pending", "failed"])))
            .returning();
          if (!replaced) return null;
        }
        const [inserted] = await tx
          .insert(appDomains)
          .values({ appId: app.id, spaceId: app.spaceId, hostname, createdBy: user.uuid, ...newAppDomainToken() })
          .returning();
        return inserted ? { row: inserted, replaced } : null;
      });
    } catch (error) {
      if (!isPostgresUniqueViolation(error, "v2_uq_app_domains_app")) throw error;
    }
    if (result === "app_missing") return c.json({ message: "app not found" }, 404);
    if (!result) return domainError(c, 409, "app_domain_exists", "The App's domain changed concurrently; reload and retry");
    const { row, replaced } = result;

    if (replaced) await publishAppDomainRemoved(replaced, "removed");
    await publishAppDomainUpdated(row);
    await enqueueAppDomainCheck(row.id, APP_DOMAIN_FIRST_CHECK_DELAY_MS);
    return c.json({ domain: toAppDomainRecord(row) }, 201);
  });

  router.post("/:appId/domains/:domainId/check", async (c) => {
    const loaded = await loadManagedApp(c);
    if (loaded instanceof Response) return loaded;
    const row = await loadAppDomain(loaded.app.id, c.req.param("domainId"));
    if (!row) return c.json({ message: "domain not found" }, 404);
    if (!(await claimAppDomainCheck(row.id))) return c.json({ domain: toAppDomainRecord(row) });

    if (row.status === "failed") {
      const reset = await resetFailedAppDomain(row);
      if (!reset) return c.json({ message: "domain changed concurrently; reload and retry" }, 409);
      return c.json({ domain: toAppDomainRecord(reset) });
    }
    if (row.status === "provisioning" || row.status === "active") await requestAppDomainRefresh(row.id);
    await enqueueAppDomainCheck(row.id);
    return c.json({ domain: toAppDomainRecord(row) });
  });

  router.delete("/:appId/domains/:domainId", async (c) => {
    const loaded = await loadManagedApp(c);
    if (loaded instanceof Response) return loaded;
    const row = await loadAppDomain(loaded.app.id, c.req.param("domainId"));
    if (!row) return c.json({ message: "domain not found" }, 404);
    const remaining = await removeAppDomain(row);
    return c.json({ ok: true, domain: remaining ? toAppDomainRecord(remaining) : null });
  });

  return router;
}

/** Mounted under `/api/apps` and, for the dual-mount contract, `/api/works`. */
export const appDomainsRouter = createAppDomainsRouter();
