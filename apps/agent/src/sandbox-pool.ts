import { createLogger } from "@cohub/infra/logging";
import { createHash } from "node:crypto";
import type { SandboxHeartbeat } from "@cohub/protocol/sandbox";
import {
  createSandboxLifecycleController,
  getSandboxPromptRecoveryReason,
} from "@cohub/sandbox-controller";
import {
  disconnectSandboxWsClient,
  hasPendingSandboxRequests,
  isSandboxConnectRetryable,
  isSandboxEndpointUnreachable,
  startSandboxWsClient,
  type SandboxConnection,
  waitForSandboxConnection,
} from "@cohub/sandbox-client";
import { getSpaceSandbox, recoverSpaceSandbox } from "./api.js";
import { db } from "./db.js";
import { env } from "./env.js";
import { updateSpaceRuntime } from "./ownership.js";
import { sendSpaceFsChanged, sendSpacePortsChanged } from "./redis.js";


const logger = createLogger({ serviceName: "cohub-agent" });
const LOCAL_SANDBOX_SPACE_ID = process.env.LOCAL_SANDBOX_SPACE_ID?.trim() || null;
const LOCAL_SANDBOX_WS_URL = process.env.LOCAL_SANDBOX_WS_URL?.trim() || null;
const IDLE_TTL_MS = Number(process.env.AGENT_SANDBOX_IDLE_TTL_MS ?? 30 * 60_000);
const MAX_CONNECTIONS = Number(process.env.AGENT_SANDBOX_MAX_CONNECTIONS_PER_WORKER ?? 100);
const DEFAULT_CONNECT_WAIT_MS = 60_000;
const sandboxLifecycle = createSandboxLifecycleController({ db, infra: null });

type NormalizedSandboxStatus = "provisioning" | "ready" | "degraded" | "error";

function hashLogValue(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

type PoolEntry = {
  spaceId: string;
  lastUsedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

export type SandboxRecoverOutcome = {
  ok: boolean;
  recovering: boolean;
  throttled: boolean;
};

const entries = new Map<string, PoolEntry>();
const wsUrlResolutions = new Map<string, Promise<string>>();
const sandboxRecoveries = new Map<string, Promise<SandboxRecoverOutcome>>();

function normalizeSandboxStatus(status: string): NormalizedSandboxStatus {
  return status === "ready" || status === "busy"
    ? "ready"
    : status === "degraded"
      ? "degraded"
      : status === "error"
        ? "error"
        : "provisioning";
}

function toRuntimeSandboxStatus(status: NormalizedSandboxStatus): "idle" | "ready" | "error" {
  return status === "ready" || status === "degraded" ? "ready" : status === "error" ? "error" : "idle";
}

async function syncSandboxHeartbeat(spaceId: string, message: SandboxHeartbeat) {
  const normalized = normalizeSandboxStatus(message.status);
  const setup = message.metadata?.setup;
  if (normalized === "degraded" && setup) {
    logger.warn(`[Agent] sandbox degraded spaceId=${spaceId} setup exitCode=${setup.exitCode} duration=${setup.duration} error=${setup.error ?? "unknown"}`);
  }
  await Promise.allSettled([
    sandboxLifecycle.recordHeartbeat({ spaceId, heartbeat: message }),
    updateSpaceRuntime({
      spaceId,
      status: toRuntimeSandboxStatus(normalized),
      sandboxId: message.sandboxId,
      error: normalized === "error"
        ? `sandbox heartbeat reported ${message.status}`
        : normalized === "degraded"
          ? setup
            ? `sandbox setup.sh failed (exitCode=${setup.exitCode}, error=${setup.error ?? "unknown"})`
            : "sandbox setup.sh failed (no details)"
          : null,
    }),
  ]);
}

async function syncSandboxConnectionState(input: { spaceId: string; status: NormalizedSandboxStatus; reason: string }) {
  await updateSpaceRuntime({
    spaceId: input.spaceId,
    status: toRuntimeSandboxStatus(input.status),
    error: input.reason,
  }).catch(() => undefined);
}

async function recoverSandboxOnce(spaceId: string, reason: string): Promise<SandboxRecoverOutcome> {
  const existing = sandboxRecoveries.get(spaceId);
  if (existing) return existing;

  const promise = recoverSpaceSandbox({ spaceId, reason, source: "agent" })
    .then((result): SandboxRecoverOutcome => {
      // recovering covers in-flight lock and post-recover endpoint report; caller waits.
      if (result?.recovering) {
        return { ok: Boolean(result.ok), recovering: true, throttled: Boolean(result.throttled) };
      }
      if (result?.throttled) {
        if (result.ok) return { ok: true, recovering: false, throttled: true };
        throw new Error(`sandbox recovery throttled without dialable endpoint: ${reason}`);
      }
      if (!result?.ok) {
        throw new Error(`sandbox recovery failed: ${result?.message ?? reason}`);
      }
      return { ok: true, recovering: false, throttled: false };
    })
    .finally(() => {
      sandboxRecoveries.delete(spaceId);
    });
  sandboxRecoveries.set(spaceId, promise);
  return promise;
}

function missingSandboxEndpointError(spaceId: string) {
  return new Error(`sandbox is not ready for requests yet: missing endpoint for ${spaceId}`);
}

/**
 * Resolve a dialable sandbox WS URL.
 *
 * Kick recover when the lifecycle gate says so (stopped / error / missing
 * endpoint). API may already be recovering — that returns recovering:true and
 * must not be treated as failure. Always re-read after recover; never dial
 * pre-recover meta. Missing endpoint throws a connect-retryable error so
 * ensureSandboxConnection can poll until report lands.
 *
 * Skip recover while status is still "stopping" so we do not race the idle
 * reaper's delete; a later poll after status becomes stopped will resume.
 */
async function resolveSandboxWsUrl(spaceId: string): Promise<string> {
  if (LOCAL_SANDBOX_SPACE_ID && LOCAL_SANDBOX_WS_URL && spaceId === LOCAL_SANDBOX_SPACE_ID) {
    return LOCAL_SANDBOX_WS_URL;
  }

  let sandbox = (await getSpaceSandbox({ spaceId }))?.sandbox ?? null;
  const recoverReason = getSandboxPromptRecoveryReason(sandbox);
  if (recoverReason && sandbox?.status !== "stopping") {
    await recoverSandboxOnce(spaceId, recoverReason);
    sandbox = (await getSpaceSandbox({ spaceId }))?.sandbox ?? null;
  }

  const endpoint = resolveSandboxWsEndpoint(sandbox?.meta);
  if (!endpoint) throw missingSandboxEndpointError(spaceId);
  return endpoint;
}

/**
 * Resolve the sandbox websocket endpoint from persisted meta. Prefers an
 * explicit `wsEndpoint` (reported by the sandbox / relay) and falls back to the
 * legacy `podIp` form for sandboxes that have not yet reported an endpoint.
 */
function resolveSandboxWsEndpoint(meta: unknown): string | null {
  const record = (meta as Record<string, unknown> | null) ?? null;
  const wsEndpoint = typeof record?.wsEndpoint === "string" ? record.wsEndpoint.trim() : "";
  if (wsEndpoint) return validateSandboxWsEndpoint(wsEndpoint);
  const podIp = typeof record?.podIp === "string" ? record.podIp.trim() : "";
  if (podIp) return validateSandboxWsEndpoint(`ws://${podIp}:8788/sandbox`);
  return null;
}

/**
 * Guard against tainted meta pointing the agent at an arbitrary address.
 * Only ws:// and wss:// with a real host are accepted. Per-provider host
 * allowlisting (pod CIDR for cloud, relay domain for local) will be added
 * alongside the relay in a later milestone.
 */
function validateSandboxWsEndpoint(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    logger.warn(`[SandboxPool] rejecting malformed wsEndpoint: ${value}`);
    return null;
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    logger.warn(`[SandboxPool] rejecting wsEndpoint with unsupported scheme: ${url.protocol}`);
    return null;
  }
  if (!url.hostname) {
    logger.warn(`[SandboxPool] rejecting wsEndpoint with empty host: ${value}`);
    return null;
  }
  return url.toString();
}

function resolveSandboxWsUrlOnce(spaceId: string) {
  const existing = wsUrlResolutions.get(spaceId);
  if (existing) return existing;
  const promise = resolveSandboxWsUrl(spaceId).finally(() => {
    wsUrlResolutions.delete(spaceId);
  });
  wsUrlResolutions.set(spaceId, promise);
  return promise;
}

async function refreshSandboxWsUrl(spaceId: string) {
  wsUrlResolutions.delete(spaceId);
  return resolveSandboxWsUrlOnce(spaceId);
}

function disconnectEntry(spaceId: string, reason: string) {
  const entry = entries.get(spaceId);
  if (entry?.idleTimer) clearTimeout(entry.idleTimer);
  entries.delete(spaceId);
  disconnectSandboxWsClient(spaceId, reason);
}

export function invalidateSandboxConnection(spaceId: string, reason: string) {
  disconnectEntry(spaceId, reason);
  wsUrlResolutions.delete(spaceId);
}

export async function recoverSandboxForUpgrade(spaceId: string, reason: string): Promise<SandboxRecoverOutcome> {
  invalidateSandboxConnection(spaceId, reason);
  return recoverSandboxOnce(spaceId, reason);
}

function scheduleIdleEviction(entry: PoolEntry) {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    const current = entries.get(entry.spaceId);
    if (!current) return;
    const idleForMs = Date.now() - current.lastUsedAt;
    if (idleForMs < IDLE_TTL_MS) {
      scheduleIdleEviction(current);
      return;
    }
    if (hasPendingSandboxRequests(current.spaceId)) {
      scheduleIdleEviction(current);
      return;
    }
    disconnectEntry(current.spaceId, "sandbox pool idle eviction");
  }, IDLE_TTL_MS);
}

function touchSandboxConnection(spaceId: string) {
  const existing = entries.get(spaceId);
  const entry = existing ?? { spaceId, lastUsedAt: Date.now(), idleTimer: null };
  entry.lastUsedAt = Date.now();
  if (existing) entries.delete(spaceId);
  entries.set(spaceId, entry);
  scheduleIdleEviction(entry);
}

/**
 * Cluster-internal relay peer endpoints (local sandboxes) require the shared
 * worker secret. Cloud sandbox pod endpoints do not. We key off the relay path
 * so the same pool transparently serves both providers.
 */
function relayAuthHeaders(wsUrl: string): Record<string, string> | undefined {
  try {
    const { pathname } = new URL(wsUrl);
    if (pathname.startsWith("/internal/sandbox-relay/") && env.WORKER_SECRET) {
      return { "x-worker-secret": env.WORKER_SECRET };
    }
  } catch {
    // ignore malformed url; resolution already validated it
  }
  return undefined;
}

async function connectSandboxOnce(spaceId: string, options?: { timeoutMs?: number }): Promise<SandboxConnection> {
  touchSandboxConnection(spaceId);
  const wsUrl = await resolveSandboxWsUrlOnce(spaceId);
  await startSandboxWsClient({
    spaceId,
    wsUrl,
    identity: env.AGENT_INSTANCE_ID,
    headers: relayAuthHeaders(wsUrl),
    hooks: {
      onHeartbeat: (message) => syncSandboxHeartbeat(spaceId, message),
      onFsChanged: (payload, broadcast) => {
        void sendSpaceFsChanged(spaceId, payload, broadcast);
      },
      onPortsChanged: (payload, broadcast) => {
        void sendSpacePortsChanged(spaceId, payload, broadcast);
      },
      onDisconnected: ({ reason }) => syncSandboxConnectionState({
        spaceId,
        status: "provisioning",
        reason: reason ?? "sandbox disconnected",
      }),
      onConnectionError: ({ error }) => syncSandboxConnectionState({
        spaceId,
        status: "provisioning",
        reason: error.message,
      }),
      onRefreshWsUrl: async ({ currentWsUrl, error }) => {
        const nextWsUrl = await refreshSandboxWsUrl(spaceId);
        if (nextWsUrl !== currentWsUrl) {
          logger.warn(`[SandboxPool] refreshed sandbox wsUrl spaceId=${spaceId} oldHash=${hashLogValue(currentWsUrl)} newHash=${hashLogValue(nextWsUrl)} reason=${error?.message ?? "unknown"}`);
        }
        return nextWsUrl;
      },
    },
  });
  const connection = await waitForSandboxConnection(spaceId, options?.timeoutMs);
  touchSandboxConnection(spaceId);
  pruneSandboxConnections({ preserveSpaceId: spaceId });
  return connection;
}

async function waitForSandboxConnectionReady(spaceId: string, timeoutMs = DEFAULT_CONNECT_WAIT_MS): Promise<SandboxConnection> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      return await connectSandboxOnce(spaceId, {
        timeoutMs: Math.min(15_000, Math.max(1_000, deadline - Date.now())),
      });
    } catch (error) {
      lastError = error;
      // Only keep polling endpoint/readiness races; surface auth/logic errors immediately.
      if (!isSandboxConnectRetryable(error)) throw error;
      attempt += 1;
      if (Date.now() >= deadline) break;
      const delayMs = Math.min(1_000 * 2 ** Math.min(attempt, 4), 5_000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for recovered sandbox connection for ${spaceId}`);
}

/**
 * Ensure a live sandbox WS connection.
 *
 * - Dead coordinates (stale podIp while DB still says running): recover once, then wait.
 * - Missing endpoint / resume-in-flight (API fire-and-forget or agent join): wait without
 *   thrashing another recreate — resolveSandboxWsUrl already kicks recover when needed.
 */
export async function ensureSandboxConnection(spaceId: string, options?: { timeoutMs?: number }): Promise<SandboxConnection> {
  try {
    return await connectSandboxOnce(spaceId, options);
  } catch (error) {
    const waitMs = options?.timeoutMs ?? DEFAULT_CONNECT_WAIT_MS;
    const reason = error instanceof Error ? error.message : String(error);

    if (isSandboxEndpointUnreachable(error)) {
      logger.warn(`[SandboxPool] endpoint unreachable spaceId=${spaceId}; recovering once reason=${reason}`);
      invalidateSandboxConnection(spaceId, "endpoint_unreachable");
      await recoverSandboxOnce(spaceId, "endpoint_unreachable");
      return waitForSandboxConnectionReady(spaceId, waitMs);
    }

    if (isSandboxConnectRetryable(error)) {
      logger.info(`[SandboxPool] waiting for sandbox readiness spaceId=${spaceId} reason=${reason}`);
      return waitForSandboxConnectionReady(spaceId, waitMs);
    }

    throw error;
  }
}

export function pruneSandboxConnections(options?: { preserveSpaceId?: string }) {
  if (entries.size <= MAX_CONNECTIONS) return;

  let skippedPending = 0;
  for (const entry of [...entries.values()]) {
    if (entries.size <= MAX_CONNECTIONS) break;
    if (entry.spaceId === options?.preserveSpaceId) continue;
    if (hasPendingSandboxRequests(entry.spaceId)) {
      skippedPending += 1;
      continue;
    }
    disconnectEntry(entry.spaceId, "sandbox pool LRU pruning");
  }

  if (entries.size > MAX_CONNECTIONS) {
    logger.warn(`[SandboxPool] max connections exceeded (${entries.size}/${MAX_CONNECTIONS}); skipped ${skippedPending} connections with pending requests`);
  }
}

export function closeSandboxPool() {
  for (const entry of entries.values()) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    disconnectSandboxWsClient(entry.spaceId, "agent shutdown");
  }
  entries.clear();
  wsUrlResolutions.clear();
}
