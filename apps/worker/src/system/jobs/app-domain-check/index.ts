import { randomUUID } from "node:crypto";
import { DelayedError, type Job } from "bullmq";
import { billingOperations, spaceWalletBillingOperations } from "@cohub/billing";
import {
  appDomainCheckJobId,
  appDomainOriginCacheKey,
  appDomainRefreshKey,
  checkAppDomain,
  createAppDomainBilling,
  createCloudflareCustomHostnameClient,
  createPublicDnsLookup,
  listOverdueAppDomains,
  serializeAppDomain,
  type AppDomainCheckDeps,
} from "@cohub/core/app-domains";
import { COHUB_SYSTEM_QUEUE, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import { createLogger } from "@cohub/infra/logging";
import { APP_DOMAIN_CHECK_JOB, APP_DOMAIN_SWEEP_JOB, type AppDomainCheckJobData } from "@cohub/protocol";
import { config } from "../../../config.js";
import { db } from "../../../db.js";
import { redisCommandClient } from "../../../redis.js";
import { publishSpaceEvent } from "../../../space-events.js";
import { spaceWalletBilling } from "../../../space-wallet-billing.js";
import { registerSystemJob } from "../../registry.js";

const logger = createLogger({ serviceName: "cohub-worker" });
const LOCK_TTL_MS = 60_000;
const RELEASE_LOCK_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

const queue = createBullmqQueue<AppDomainCheckJobData>(COHUB_SYSTEM_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-worker-app-domains",
});

function createDeps(): AppDomainCheckDeps | null {
  if (!config.cloudflareSaasApiToken || !config.cloudflareSaasZoneId) return null;
  const cnameTarget = config.appCustomDomainCnameTarget;
  return {
    db,
    cf: createCloudflareCustomHostnameClient({ apiToken: config.cloudflareSaasApiToken, zoneId: config.cloudflareSaasZoneId }),
    dns: createPublicDnsLookup(),
    billing: createAppDomainBilling({ billing: billingOperations, walletBilling: spaceWalletBillingOperations, spaceWalletBilling }),
    cnameTarget,
    async withHostnameLock(hostname, run) {
      const key = `app-domain:lock:${hostname}`;
      const token = randomUUID();
      const acquired = await redisCommandClient.set(key, token, "PX", LOCK_TTL_MS, "NX");
      if (acquired !== "OK") return null;
      try {
        return await run();
      } finally {
        await redisCommandClient.eval(RELEASE_LOCK_SCRIPT, 1, key, token).catch(() => undefined);
      }
    },
    async consumeRefreshRequest(domainId) {
      return (await redisCommandClient.getdel(appDomainRefreshKey(domainId))) !== null;
    },
    async invalidateOrigin(hostname) {
      await redisCommandClient.del(appDomainOriginCacheKey(hostname)).catch(() => undefined);
    },
    async publishUpdated(row) {
      await publishSpaceEvent({
        type: "app.domain.updated",
        spaceId: row.spaceId,
        payload: { domain: serializeAppDomain(row, cnameTarget) },
      }).catch((error) => logger.warn("[AppDomains] failed to publish update", { domainId: row.id, error }));
    },
    async publishRemoved(row, reason) {
      await publishSpaceEvent({
        type: "app.domain.removed",
        spaceId: row.spaceId,
        payload: { appId: row.appId, domainId: row.id, hostname: row.hostname, reason },
      }).catch((error) => logger.warn("[AppDomains] failed to publish removal", { domainId: row.id, error }));
    },
    warn: (message, context) => logger.warn(`[AppDomains] ${message}`, context),
  };
}

const deps = createDeps();

registerSystemJob(APP_DOMAIN_CHECK_JOB, async (job: Job<AppDomainCheckJobData>) => {
  const domainId = job.data?.domainId;
  if (!domainId) throw new Error("app domain check job missing domainId");
  if (!deps) {
    logger.warn("[AppDomains] check skipped: CLOUDFLARE_SAAS_API_TOKEN / CLOUDFLARE_SAAS_ZONE_ID not configured", { domainId });
    return { skipped: true };
  }
  const { nextCheckMs } = await checkAppDomain(deps, domainId);
  if (nextCheckMs === null) return { domainId, done: true };
  if (!job.token) throw new Error(`app domain check missing job token domainId=${domainId}`);
  // One job per domain: reschedule it instead of enqueueing a follow-up.
  await job.moveToDelayed(Date.now() + nextCheckMs, job.token);
  throw new DelayedError();
});

/** Re-arms checks whose job was lost, e.g. after a Redis flush. */
registerSystemJob(APP_DOMAIN_SWEEP_JOB, async () => {
  if (!deps) return { skipped: true };
  const ids = await listOverdueAppDomains(db);
  let enqueued = 0;
  for (const domainId of ids) {
    const jobId = appDomainCheckJobId(domainId);
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState().catch(() => "unknown");
      if (state === "delayed" || state === "active" || state === "waiting") continue;
      await existing.remove().catch(() => undefined);
    }
    await queue.add(APP_DOMAIN_CHECK_JOB, { domainId }, {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      ...defaultJobRetention,
    });
    enqueued += 1;
  }
  return { overdue: ids.length, enqueued };
});
