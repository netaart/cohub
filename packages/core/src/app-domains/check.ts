import { appDomains } from "@cohub/db";
import {
  APP_DOMAIN_EXCLUSIVE_STATUSES,
  APP_DOMAIN_PRICE_USD,
  appDomainChallengeName,
  appDomainChallengeValue,
  type AppDomainErrorCode,
  type AppDomainRemovedReason,
  type AppDomainStatus,
} from "@cohub/protocol";
import { and, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { AppDomainBilling } from "./billing.js";
import { CloudflareApiError, type CustomHostname, type CustomHostnameClient } from "./cloudflare.js";
import type { DomainDnsLookup } from "./dns.js";
import { getAppDomainEligibility } from "./eligibility.js";
import type { AppDomainRow } from "./records.js";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const APP_DOMAIN_PENDING_TTL_MS = 7 * DAY;
export const APP_DOMAIN_PROVISIONING_TTL_MS = 7 * DAY;
export const APP_DOMAIN_MOVED_GRACE_MS = 72 * HOUR;
export const APP_DOMAIN_ACTIVE_RECHECK_MS = 6 * HOUR;
const UNHEALTHY_RECHECK_MS = HOUR;
const REMOVING_RETRY_MS = MINUTE;
const RETRY_SOON_MS = SECOND;
const LOCK_BUSY_RETRY_MS = 15 * SECOND;
const BILLING_RETRY_MS = 5 * MINUTE;
const INSUFFICIENT_BALANCE_RECHECK_MS = HOUR;
/** `provider_status` while a Cloudflare create is in flight or its outcome is unknown. */
const CREATING = "creating";

/** Certificate states Cloudflare only leaves after an explicit refresh. */
const STALLED_SSL_STATUSES = new Set(["validation_timed_out", "issuance_timed_out", "expired", "deleted"]);
const STALLED_HOSTNAME_STATUSES = new Set(["moved", "deleted"]);

type Db = PostgresJsDatabase<Record<string, unknown>>;

export type AppDomainCheckDeps = {
  db: Db;
  cf: CustomHostnameClient;
  dns: DomainDnsLookup;
  billing: AppDomainBilling;
  cnameTarget: string;
  /** Serializes checks of one hostname across replicas; null when the lock is held. */
  withHostnameLock<T>(hostname: string, run: () => Promise<T>): Promise<T | null>;
  /** True once after a user asked to recheck, so validation is restarted. */
  consumeRefreshRequest(domainId: string): Promise<boolean>;
  invalidateOrigin(hostname: string): Promise<void>;
  publishUpdated(row: AppDomainRow): Promise<void>;
  publishRemoved(row: AppDomainRow, reason: AppDomainRemovedReason): Promise<void>;
  warn(message: string, context: Record<string, unknown>): void;
  now?: () => Date;
};

export type AppDomainCheckResult = { nextCheckMs: number | null };

const done: AppDomainCheckResult = { nextCheckMs: null };
const after = (ms: number): AppDomainCheckResult => ({ nextCheckMs: ms });

function backoff(elapsedMs: number, steps: Array<[number, number]>, last: number) {
  for (const [limit, delay] of steps) if (elapsedMs < limit) return delay;
  return last;
}

const pendingBackoff = (elapsedMs: number) =>
  backoff(elapsedMs, [[5 * MINUTE, 30 * SECOND], [30 * MINUTE, 2 * MINUTE], [2 * HOUR, 10 * MINUTE]], HOUR);
const provisioningBackoff = (elapsedMs: number) =>
  backoff(elapsedMs, [[10 * MINUTE, 30 * SECOND], [HOUR, 2 * MINUTE], [6 * HOUR, 15 * MINUTE]], HOUR);

const VISIBLE_FIELDS = [
  "status",
  "verificationToken",
  "providerStatus",
  "certificateStatus",
  "errorCode",
  "errorMessage",
  "verifiedAt",
  "activatedAt",
  "billingClaimedAt",
] as const satisfies ReadonlyArray<keyof AppDomainRow>;

function visiblyChanged(before: AppDomainRow, after: AppDomainRow) {
  return VISIBLE_FIELDS.some((field) => String(before[field] ?? "") !== String(after[field] ?? ""));
}

function errorPatch(code: AppDomainErrorCode | null, message: string | null = null) {
  return { errorCode: code, errorMessage: code ? message : null };
}

export async function checkAppDomain(deps: AppDomainCheckDeps, domainId: string): Promise<AppDomainCheckResult> {
  const initial = await loadDomain(deps.db, domainId);
  if (!initial) return done;
  const result = await deps.withHostnameLock(initial.hostname, async () => {
    const row = await loadDomain(deps.db, domainId);
    return row ? runCheck(deps, row) : done;
  });
  return result ?? after(LOCK_BUSY_RETRY_MS);
}

async function loadDomain(db: Db, id: string) {
  const [row] = await db.select().from(appDomains).where(eq(appDomains.id, id)).limit(1);
  return row ?? null;
}

async function runCheck(deps: AppDomainCheckDeps, row: AppDomainRow): Promise<AppDomainCheckResult> {
  if (row.status !== "removing" && row.status !== "failed") {
    const eligibility = await getAppDomainEligibility(deps.db, row.appId);
    // A binding must never outlive its App (e.g. one created while it was being deleted).
    if (eligibility === "missing") return releaseOrphan(deps, row);
    if (eligibility === "ineligible" && row.status === "pending" && !pendingExpired(deps, row)) {
      const next = await transition(deps, row, {
        lastCheckedAt: now(deps),
        ...errorPatch("app_not_eligible", "Only published public web or port Apps can use a custom domain"),
      });
      return next ? after(pendingBackoff(now(deps).getTime() - row.tokenIssuedAt.getTime())) : after(RETRY_SOON_MS);
    }
  }
  switch (row.status as AppDomainStatus) {
    case "pending":
      return checkPending(deps, row);
    case "provisioning":
      return checkProvisioning(deps, row);
    case "active":
      return checkActive(deps, row);
    case "removing":
      return checkRemoving(deps, row);
    default:
      return Promise.resolve(done);
  }
}

const now = (deps: AppDomainCheckDeps) => deps.now?.() ?? new Date();

async function releaseOrphan(deps: AppDomainCheckDeps, row: AppDomainRow): Promise<AppDomainCheckResult> {
  if (row.status === "pending") {
    const removed = await deps.db
      .delete(appDomains)
      .where(and(eq(appDomains.id, row.id), eq(appDomains.status, "pending")))
      .returning({ id: appDomains.id });
    if (removed.length === 0) return after(RETRY_SOON_MS);
    await deps.publishRemoved(row, "removed");
    return done;
  }
  const next = await transition(deps, row, { status: "removing", removalIntent: "user", lastCheckedAt: now(deps) });
  if (!next) return after(RETRY_SOON_MS);
  await deps.invalidateOrigin(row.hostname);
  return checkRemoving(deps, next);
}

/** Compare-and-set on status; null when the row moved on concurrently. */
async function transition(
  deps: AppDomainCheckDeps,
  row: AppDomainRow,
  patch: Partial<typeof appDomains.$inferInsert>,
  extra?: ReturnType<typeof eq>,
): Promise<AppDomainRow | null> {
  const [next] = await deps.db
    .update(appDomains)
    .set({ ...patch, updatedAt: now(deps) })
    .where(and(eq(appDomains.id, row.id), eq(appDomains.status, row.status), extra))
    .returning();
  if (!next) return null;
  if (visiblyChanged(row, next)) await deps.publishUpdated(next);
  return next;
}

const pendingExpired = (deps: AppDomainCheckDeps, row: AppDomainRow) =>
  now(deps).getTime() - row.tokenIssuedAt.getTime() > APP_DOMAIN_PENDING_TTL_MS;

async function checkPending(deps: AppDomainCheckDeps, row: AppDomainRow): Promise<AppDomainCheckResult> {
  const checkedAt = now(deps);
  const elapsed = checkedAt.getTime() - row.tokenIssuedAt.getTime();
  const challenge = appDomainChallengeName(row.hostname);
  if (pendingExpired(deps, row)) {
    await transition(deps, row, {
      status: "failed",
      lastCheckedAt: checkedAt,
      ...errorPatch("verification_expired", `TXT record ${challenge} was not found within 7 days`),
    });
    return done;
  }

  const values = await deps.dns.txt(challenge);
  const expected = appDomainChallengeValue(row.verificationToken);
  if (!values.includes(expected)) {
    const next = await transition(deps, row, {
      lastCheckedAt: checkedAt,
      ...errorPatch("ownership_not_found", `TXT record ${challenge} not found; expected ${expected}`),
    });
    return next ? after(pendingBackoff(elapsed)) : after(RETRY_SOON_MS);
  }

  let affordable: boolean;
  try {
    affordable = await deps.billing.canAfford({ spaceId: row.spaceId, userId: row.createdBy });
  } catch (error) {
    deps.warn("App domain balance check failed", { domainId: row.id, error });
    return after(BILLING_RETRY_MS);
  }
  if (!affordable) {
    await transition(deps, row, {
      lastCheckedAt: checkedAt,
      ...errorPatch("insufficient_balance", `Balance must cover $${APP_DOMAIN_PRICE_USD}; recharge, then check again`),
    });
    return after(INSUFFICIENT_BALANCE_RECHECK_MS);
  }

  const [holder] = await deps.db
    .select()
    .from(appDomains)
    .where(and(
      eq(appDomains.hostname, row.hostname),
      inArray(appDomains.status, [...APP_DOMAIN_EXCLUSIVE_STATUSES]),
      ne(appDomains.id, row.id),
    ))
    .limit(1);
  if (holder?.status === "removing") {
    await transition(deps, row, { lastCheckedAt: checkedAt });
    return after(REMOVING_RETRY_MS);
  }
  if (holder) {
    const holderValue = appDomainChallengeValue(holder.verificationToken);
    if (values.includes(holderValue)) {
      await transition(deps, row, {
        lastCheckedAt: checkedAt,
        ...errorPatch("domain_in_use", `${row.hostname} is bound to another App; remove ${holderValue} from ${challenge} to move it here`),
      });
      return after(pendingBackoff(elapsed));
    }
    return transfer(deps, row, holder);
  }

  let promoted: AppDomainRow | null;
  try {
    promoted = await transition(deps, row, {
      status: "provisioning",
      verifiedAt: checkedAt,
      lastCheckedAt: checkedAt,
      ...errorPatch(null),
    });
  } catch (error) {
    // Another claim became exclusive between the holder read and this write.
    deps.warn("App domain promotion conflicted", { domainId: row.id, error });
    return after(RETRY_SOON_MS);
  }
  if (!promoted) return after(RETRY_SOON_MS);
  await deps.invalidateOrigin(promoted.hostname);
  return checkProvisioning(deps, promoted);
}

/**
 * Moves an exclusive binding to a claim that just proved DNS control. The
 * Cloudflare hostname is reused, so a working certificate keeps serving.
 */
async function transfer(deps: AppDomainCheckDeps, row: AppDomainRow, holder: AppDomainRow): Promise<AppDomainCheckResult> {
  const transferredAt = now(deps);
  const serving = holder.status === "active" && holder.providerStatus === "active" && holder.certificateStatus === "active";
  const next = await deps.db.transaction(async (tx) => {
    const removed = await tx
      .delete(appDomains)
      .where(and(eq(appDomains.id, holder.id), eq(appDomains.status, holder.status)))
      .returning({ id: appDomains.id });
    if (removed.length === 0) return null;
    const [updated] = await tx
      .update(appDomains)
      .set({
        status: serving ? "active" : "provisioning",
        providerHostnameId: holder.providerHostnameId,
        providerStatus: holder.providerStatus,
        certificateStatus: holder.certificateStatus,
        providerUnhealthySince: null,
        verifiedAt: transferredAt,
        activatedAt: serving ? transferredAt : null,
        lastCheckedAt: transferredAt,
        ...errorPatch(null),
        updatedAt: transferredAt,
      })
      .where(and(eq(appDomains.id, row.id), eq(appDomains.status, "pending")))
      .returning();
    if (!updated) {
      tx.rollback();
      return null;
    }
    return updated;
  }).catch((error: unknown) => {
    deps.warn("App domain transfer aborted", { domainId: row.id, holderId: holder.id, error });
    return null;
  });
  if (!next) return after(RETRY_SOON_MS);

  await deps.publishRemoved(holder, "transferred");
  await deps.invalidateOrigin(row.hostname);
  await deps.publishUpdated(next);
  if (next.status !== "active") return checkProvisioning(deps, next);
  await chargeOnce(deps, next);
  return after(APP_DOMAIN_ACTIVE_RECHECK_MS);
}

async function createOrAdopt(
  cf: CustomHostnameClient,
  hostname: string,
  beforeCreate: () => Promise<void>,
): Promise<CustomHostname> {
  const existing = await cf.findByHostname(hostname);
  if (existing) return existing;
  await beforeCreate();
  try {
    return await cf.create(hostname);
  } catch (error) {
    // A crashed earlier attempt (or an operator) may have created it already.
    const adopted = error instanceof CloudflareApiError ? await cf.findByHostname(hostname) : null;
    if (adopted) return adopted;
    throw error;
  }
}

const isStalled = (hostname: CustomHostname) =>
  STALLED_HOSTNAME_STATUSES.has(hostname.status) || STALLED_SSL_STATUSES.has(hostname.sslStatus ?? "");

async function checkProvisioning(deps: AppDomainCheckDeps, row: AppDomainRow): Promise<AppDomainCheckResult> {
  const checkedAt = now(deps);
  const elapsed = checkedAt.getTime() - (row.verifiedAt ?? row.updatedAt).getTime();
  let hostname: CustomHostname;
  try {
    let found = row.providerHostnameId ? await deps.cf.get(row.providerHostnameId) : null;
    if (!found && row.providerHostnameId) {
      // Forget an id Cloudflare no longer knows, so cleanup can't latch onto it.
      await deps.db
        .update(appDomains)
        .set({ providerHostnameId: null, updatedAt: checkedAt })
        .where(and(eq(appDomains.id, row.id), eq(appDomains.providerHostnameId, row.providerHostnameId)));
    }
    if (!found) {
      // Recorded first: if the create response is lost, removal still knows
      // to look the hostname up before dropping the row.
      found = await createOrAdopt(deps.cf, row.hostname, async () => {
        await deps.db
          .update(appDomains)
          .set({ providerStatus: CREATING, updatedAt: checkedAt })
          .where(eq(appDomains.id, row.id));
      });
      // Saved by id alone: if the user removed the domain meanwhile, the
      // removal must still see and delete this hostname.
      await deps.db
        .update(appDomains)
        .set({ providerHostnameId: found.id, updatedAt: checkedAt })
        .where(eq(appDomains.id, row.id));
    }
    const refreshRequested = await deps.consumeRefreshRequest(row.id);
    hostname = isStalled(found) || refreshRequested ? await deps.cf.refresh(found.id) : found;
  } catch (error) {
    deps.warn("App domain provisioning call failed", { domainId: row.id, error });
    const message = error instanceof Error ? error.message : String(error);
    // Cloudflare rejected the hostname itself (invalid, reserved, owned elsewhere); retrying cannot help.
    if (error instanceof CloudflareApiError && [400, 409, 422].includes(error.status)) {
      return fail(deps, row, "domain_invalid", `Cloudflare rejected ${row.hostname}: ${message}`);
    }
    await transition(deps, row, { lastCheckedAt: checkedAt, ...errorPatch("provider_unavailable", `Cloudflare: ${message}`) });
    return after(provisioningBackoff(elapsed));
  }

  const providerPatch = {
    providerHostnameId: hostname.id,
    providerStatus: hostname.status,
    certificateStatus: hostname.sslStatus,
    lastCheckedAt: checkedAt,
  };
  if (hostname.status === "active" && hostname.sslStatus === "active") {
    const active = await transition(deps, row, {
      ...providerPatch,
      status: "active",
      activatedAt: row.activatedAt ?? checkedAt,
      providerUnhealthySince: null,
      ...errorPatch(null),
    });
    if (!active) return after(RETRY_SOON_MS);
    await deps.invalidateOrigin(active.hostname);
    await chargeOnce(deps, active);
    return after(APP_DOMAIN_ACTIVE_RECHECK_MS);
  }

  if (elapsed > APP_DOMAIN_PROVISIONING_TTL_MS) {
    const detail = hostname.errors.join("; ") || `certificate is ${hostname.sslStatus ?? "unknown"}`;
    return fail(deps, row, "certificate_failed", `Certificate for ${row.hostname} was not issued within 7 days: ${detail}`);
  }
  const next = await transition(deps, row, {
    ...providerPatch,
    ...(hostname.errors.length
      ? errorPatch("certificate_failed", hostname.errors.join("; "))
      : errorPatch(null)),
  });
  return next ? after(provisioningBackoff(elapsed)) : after(RETRY_SOON_MS);
}

async function checkActive(deps: AppDomainCheckDeps, row: AppDomainRow): Promise<AppDomainCheckResult> {
  const checkedAt = now(deps);
  let hostname: CustomHostname | null;
  try {
    hostname = row.providerHostnameId ? await deps.cf.get(row.providerHostnameId) : null;
  } catch (error) {
    deps.warn("App domain status check failed", { domainId: row.id, error });
    return after(15 * MINUTE);
  }

  if (!hostname) {
    // The Cloudflare hostname vanished; provision it again.
    const next = await transition(deps, row, {
      status: "provisioning",
      providerHostnameId: null,
      providerStatus: null,
      certificateStatus: null,
      verifiedAt: checkedAt,
      lastCheckedAt: checkedAt,
    });
    if (!next) return after(RETRY_SOON_MS);
    await deps.invalidateOrigin(row.hostname);
    return checkProvisioning(deps, next);
  }

  const refreshRequested = await deps.consumeRefreshRequest(row.id);
  if (hostname.status !== "active") {
    // Read DNS and any manual request before judging the grace period, so a
    // domain restored just before the deadline is refreshed, not released.
    const pointsHere = (await deps.dns.cname(row.hostname)).includes(deps.cnameTarget);
    if (refreshRequested || pointsHere) hostname = await refreshQuietly(deps, row, hostname);
    if (hostname.status !== "active") {
      const since = row.providerUnhealthySince ?? checkedAt;
      const movedMessage = `${row.hostname} no longer points to ${deps.cnameTarget}`;
      const expired = checkedAt.getTime() - since.getTime() > APP_DOMAIN_MOVED_GRACE_MS;
      if (expired && !pointsHere && !refreshRequested) return fail(deps, row, "dns_moved", movedMessage);
      const next = await transition(deps, row, {
        providerStatus: hostname.status,
        certificateStatus: hostname.sslStatus,
        providerUnhealthySince: since,
        lastCheckedAt: checkedAt,
        ...errorPatch("dns_moved", movedMessage),
      });
      return next ? after(UNHEALTHY_RECHECK_MS) : after(RETRY_SOON_MS);
    }
  } else if (refreshRequested || STALLED_SSL_STATUSES.has(hostname.sslStatus ?? "")) {
    // The hostname still routes here but its certificate renewal stalled.
    hostname = await refreshQuietly(deps, row, hostname);
  }

  const certificateStalled = STALLED_SSL_STATUSES.has(hostname.sslStatus ?? "");
  const next = await transition(deps, row, {
    providerStatus: hostname.status,
    certificateStatus: hostname.sslStatus,
    providerUnhealthySince: null,
    lastCheckedAt: checkedAt,
    ...(certificateStalled
      ? errorPatch("certificate_failed", `Certificate for ${row.hostname} is ${hostname.sslStatus}; validation was restarted`)
      : errorPatch(null)),
  });
  if (!next) return after(RETRY_SOON_MS);
  // Covers a crash between going live and claiming the charge.
  if (!next.billingClaimedAt) await chargeOnce(deps, next);
  return after(certificateStalled ? UNHEALTHY_RECHECK_MS : APP_DOMAIN_ACTIVE_RECHECK_MS);
}

async function refreshQuietly(deps: AppDomainCheckDeps, row: AppDomainRow, hostname: CustomHostname) {
  return deps.cf.refresh(hostname.id).catch((error: unknown) => {
    deps.warn("App domain refresh failed", { domainId: row.id, error });
    return hostname;
  });
}

/** Exclusive rows release their Cloudflare hostname before becoming `failed`. */
async function fail(
  deps: AppDomainCheckDeps,
  row: AppDomainRow,
  code: AppDomainErrorCode,
  message: string,
): Promise<AppDomainCheckResult> {
  const next = await transition(deps, row, {
    status: "removing",
    removalIntent: "failure",
    lastCheckedAt: now(deps),
    ...errorPatch(code, message),
  });
  if (!next) return after(RETRY_SOON_MS);
  await deps.invalidateOrigin(row.hostname);
  return checkRemoving(deps, next);
}

async function checkRemoving(deps: AppDomainCheckDeps, row: AppDomainRow): Promise<AppDomainCheckResult> {
  const checkedAt = now(deps);
  if (row.providerHostnameId || row.providerStatus === CREATING) {
    try {
      // This row was verified and exclusive when it tried to create the
      // hostname, so a hostname found by name is its own.
      const ids = new Set<string>();
      if (row.providerHostnameId) ids.add(row.providerHostnameId);
      // A create whose response was lost leaves no id; find it by name.
      if (row.providerStatus === CREATING) {
        const created = await deps.cf.findByHostname(row.hostname);
        if (created) ids.add(created.id);
      }
      for (const id of ids) await deps.cf.delete(id);
    } catch (error) {
      deps.warn("App domain Cloudflare cleanup failed", { domainId: row.id, error });
      await transition(deps, row, { lastCheckedAt: checkedAt });
      return after(REMOVING_RETRY_MS);
    }
  }

  if (row.removalIntent === "failure") {
    const failed = await transition(
      deps,
      row,
      {
        status: "failed",
        removalIntent: null,
        providerHostnameId: null,
        providerStatus: null,
        certificateStatus: null,
        providerUnhealthySince: null,
        lastCheckedAt: checkedAt,
      },
      eq(appDomains.removalIntent, "failure"),
    );
    if (!failed) return after(RETRY_SOON_MS);
    await deps.invalidateOrigin(row.hostname);
    return done;
  }

  const removed = await deps.db
    .delete(appDomains)
    .where(and(eq(appDomains.id, row.id), eq(appDomains.status, "removing")))
    .returning({ id: appDomains.id });
  if (removed.length === 0) return after(RETRY_SOON_MS);
  await deps.invalidateOrigin(row.hostname);
  await deps.publishRemoved(row, "removed");
  return done;
}

async function chargeOnce(deps: AppDomainCheckDeps, row: AppDomainRow) {
  const [claimed] = await deps.db
    .update(appDomains)
    .set({ billingClaimedAt: now(deps), updatedAt: now(deps) })
    .where(and(eq(appDomains.id, row.id), isNull(appDomains.billingClaimedAt)))
    .returning();
  if (!claimed) return;
  try {
    await deps.billing.charge({ domainId: row.id, hostname: row.hostname, spaceId: row.spaceId, userId: row.createdBy });
  } catch (error) {
    // The debit may have landed; never retry or switch payer automatically.
    deps.warn("App domain charge failed; manual billing verification required", {
      domainId: row.id,
      spaceId: row.spaceId,
      userId: row.createdBy,
      operationId: `app-domain:${row.id}`,
      error,
    });
  }
  await deps.publishUpdated(claimed);
}

/** Rows whose scheduled check is overdue, e.g. after a lost queue job. */
export async function listOverdueAppDomains(db: Db, at = new Date()) {
  const busyCutoff = new Date(at.getTime() - 2 * HOUR);
  const activeCutoff = new Date(at.getTime() - APP_DOMAIN_ACTIVE_RECHECK_MS - HOUR);
  const rows = await db
    .select({ id: appDomains.id })
    .from(appDomains)
    .where(or(
      and(
        inArray(appDomains.status, ["pending", "provisioning", "removing"]),
        or(isNull(appDomains.lastCheckedAt), lt(appDomains.lastCheckedAt, busyCutoff)),
      ),
      and(
        eq(appDomains.status, "active"),
        or(isNull(appDomains.lastCheckedAt), lt(appDomains.lastCheckedAt, activeCutoff)),
      ),
    ))
    .orderBy(sql`${appDomains.lastCheckedAt} asc nulls first`)
    .limit(500);
  return rows.map((row) => row.id);
}
