import { markWorkspaceUsage } from "@cohub/infra/workspace-usage";
import { asc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { spaceSandboxes, spaces } from "@cohub/db";
import type { RpcMethod, SandboxHeartbeat, SandboxStatus } from "@cohub/protocol/sandbox";

export const SANDBOX_LIFECYCLE_STATUSES = [
  "pending",
  "provisioning",
  "ready",
  "running",
  "stopping",
  "stopped",
  "error",
  "terminated",
] as const;
export type SandboxLifecycleStatus = (typeof SANDBOX_LIFECYCLE_STATUSES)[number];

export const SANDBOX_RUNTIME_STATUSES = [
  "unknown",
  "starting",
  "healthy",
  "degraded",
  "unhealthy",
] as const;
export type SandboxRuntimeStatus = (typeof SANDBOX_RUNTIME_STATUSES)[number];

export const SANDBOX_STOP_REASONS = ["idle", "manual", "replaced", "cleanup", "disconnected"] as const;
export type SandboxStopReason = (typeof SANDBOX_STOP_REASONS)[number];

export type SandboxActivityReason = "rpc" | "manual" | "resume";
export type SandboxResumeReason = "rpc" | "new_message" | "manual" | "auto_recover";

export const SANDBOX_SPECS = {
  standard: {
    id: "standard",
    rank: 0,
    label: "Standard",
    description: "Everyday building",
    requiredPlan: null,
    resources: {
      limits: { cpu: "2", memory: "4Gi" },
      requests: { cpu: "100m", memory: "256Mi" },
    },
  },
  boost: {
    id: "boost",
    rank: 1,
    label: "Boost",
    description: "Faster builds and heavier dev servers",
    requiredPlan: "Pro",
    resources: {
      limits: { cpu: "4", memory: "8Gi" },
      requests: { cpu: "250m", memory: "768Mi" },
    },
  },
  ultra: {
    id: "ultra",
    rank: 2,
    label: "Ultra",
    description: "Highest-priority compute for large work",
    requiredPlan: "Max",
    resources: {
      limits: { cpu: "4", memory: "12Gi" },
      requests: { cpu: "500m", memory: "1536Mi" },
    },
  },
} as const;
export type SandboxSpecId = keyof typeof SANDBOX_SPECS;
export type SandboxSpec = (typeof SANDBOX_SPECS)[SandboxSpecId];
export const DEFAULT_SANDBOX_SPEC_ID: SandboxSpecId = "standard";

export function isSandboxSpecId(value: unknown): value is SandboxSpecId {
  return typeof value === "string" && value in SANDBOX_SPECS;
}

export function normalizeSandboxSpecId(value: unknown): SandboxSpecId {
  return isSandboxSpecId(value) ? value : DEFAULT_SANDBOX_SPEC_ID;
}

export function getSandboxSpecRank(specId: SandboxSpecId) {
  return SANDBOX_SPECS[specId].rank;
}

export function getHighestAllowedSandboxSpecId(maxRank: number | null | undefined): SandboxSpecId {
  const rank = typeof maxRank === "number" && Number.isFinite(maxRank) ? Math.floor(maxRank) : 0;
  return Object.values(SANDBOX_SPECS)
    .filter((spec) => spec.rank <= rank)
    .sort((left, right) => right.rank - left.rank)[0]?.id ?? DEFAULT_SANDBOX_SPEC_ID;
}

const STALE_SANDBOX_CLEANUP_GRACE_MS = 30 * 60_000;

export type RedisLike = {
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: unknown[]): Promise<unknown>;
};

export type LoggerLike = Pick<Console, "info" | "warn" | "error">;

type SpaceSandboxRow = typeof spaceSandboxes.$inferSelect;
type ControllerDb = PostgresJsDatabase<Record<string, unknown>>;

export type SandboxInfraAdapter = {
  deletePod(input: { podName: string }): Promise<void>;
  waitForPodDeleted(input: { podName: string; timeoutMs?: number }): Promise<boolean>;
  deletePublicNetwork?(input: { spaceId: string }): Promise<void>;
  resumeSandbox(input: { spaceId: string; reason: SandboxResumeReason }): Promise<unknown>;
};

export type SandboxLifecycleController = ReturnType<typeof createSandboxLifecycleController>;

const DEFAULT_LOCK_TTL_MS = 10 * 60_000;
const nowDate = () => new Date();

export function getDefaultSandboxIdleTtl(env: "dev" | "prod"): number {
  return env === "prod" ? 12 * 60 * 60 : 10 * 60;
}

const resolvedEnv = (typeof process !== "undefined" && process.env?.ENV === "prod" ? "prod" : "dev") as "dev" | "prod";
export const DEFAULT_SPACE_SANDBOX_IDLE_TTL_SECONDS = getDefaultSandboxIdleTtl(resolvedEnv);
export const MIN_SPACE_SANDBOX_IDLE_TTL_SECONDS = 60;
export const MAX_SPACE_SANDBOX_IDLE_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTO_DESTROY_TTL_SQL = sql`
  case
    when (${spaces.meta}->'config'->'sandbox'->'autoDestroy'->>'ttlSeconds') ~ '^[0-9]+$'
      and (${spaces.meta}->'config'->'sandbox'->'autoDestroy'->>'ttlSeconds')::numeric between ${MIN_SPACE_SANDBOX_IDLE_TTL_SECONDS} and ${MAX_SPACE_SANDBOX_IDLE_TTL_SECONDS}
      then (${spaces.meta}->'config'->'sandbox'->'autoDestroy'->>'ttlSeconds')::int
    else ${DEFAULT_SPACE_SANDBOX_IDLE_TTL_SECONDS}
  end
`;

export type SpaceSandboxAutoDestroyPolicy =
  | { mode: "idle"; ttlSeconds: number }
  | { mode: "never" };

export const SANDBOX_PUBLIC_NETWORK_HTTP_ROUTE_GROUP = "gateway.networking.k8s.io";
export const SANDBOX_PUBLIC_NETWORK_HTTP_ROUTE_VERSION = "v1";
export const SANDBOX_PUBLIC_NETWORK_HTTP_ROUTE_PLURAL = "httproutes";

export function getSandboxPublicServiceName(spaceId: string) {
  return `sandbox-${spaceId}`;
}

export function getSandboxPublicRouteName(spaceId: string, port: number) {
  return `sandbox-${spaceId}-p${port}-route`;
}

export const SANDBOX_IDLE_CHECK_JOB = "sandbox.idle_check";
export type SandboxIdleCheckJobData = { spaceId: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function buildSandboxIdleCheckJobId(spaceId: string) {
  return `sandbox-idle-check-${spaceId}`;
}

/** Delay options shared by API schedule and worker reschedule. */
export const SANDBOX_IDLE_CHECK_JOB_ATTEMPTS = 3;
export const SANDBOX_IDLE_CHECK_JOB_BACKOFF_MS = 60_000;

export function computeSandboxIdleCheckDelayMs(dueAt: Date, now = Date.now()) {
  return Math.max(0, dueAt.getTime() - now);
}

/**
 * Decide how an idle_check result should leave the next delayed job.
 * - not_due: keep the same job and delay until dueAt (worker uses moveToDelayed)
 * - terminal: no next job (stopped / never / local / not usable / missing)
 */
export function resolveSandboxIdleCheckReschedule(result: {
  ok?: boolean;
  skipped?: boolean;
  reason?: string;
  dueAt?: string | null;
}): { action: "delay"; dueAt: Date } | { action: "none"; reason: string } {
  if (result.ok && result.skipped && result.reason === "not_due" && result.dueAt) {
    const dueAt = new Date(result.dueAt);
    if (!Number.isNaN(dueAt.getTime())) return { action: "delay", dueAt };
  }
  const reason =
    typeof result.reason === "string" && result.reason
      ? result.reason
      : result.ok
        ? "completed"
        : "failed";
  return { action: "none", reason };
}

export function isLocalSandboxProvider(provider: string | null | undefined) {
  return provider === "local";
}

export function isSandboxUsableStatus(status: string | null | undefined) {
  return status === "ready" || status === "running";
}

export function isSandboxPromptAcceptingStatus(status: string | null | undefined) {
  return isSandboxUsableStatus(status) || status === "stopped" || status === "stopping";
}

/** True when meta has a dialable coordinate (wsEndpoint or legacy podIp). */
export function hasSandboxEndpoint(meta: unknown): boolean {
  if (!isRecord(meta)) return false;
  const wsEndpoint = typeof meta.wsEndpoint === "string" ? meta.wsEndpoint.trim() : "";
  if (wsEndpoint) return true;
  const podIp = typeof meta.podIp === "string" ? meta.podIp.trim() : "";
  return Boolean(podIp);
}

/** Status usable and meta has coordinates an agent can dial. */
export function isSandboxDialable(sandbox: {
  status?: string | null;
  meta?: unknown;
} | null | undefined): boolean {
  return Boolean(sandbox && isSandboxUsableStatus(sandbox.status) && hasSandboxEndpoint(sandbox.meta));
}

/**
 * Clear connection coordinates (+ report token) so concurrent agents stop dialing
 * a dying pod and the old pod cannot report the dead endpoint back.
 */
export function buildInvalidatedSandboxEndpointMeta(
  meta: Record<string, unknown>,
  reason: string,
  at = new Date().toISOString(),
): Record<string, unknown> {
  return {
    ...meta,
    ...sandboxEndpointInvalidationPatch(reason, at),
  };
}

/** JSONB merge patch for stop/cleanup/recover paths. */
export function sandboxEndpointInvalidationPatch(reason: string, at = new Date().toISOString()) {
  return {
    podIp: null,
    wsEndpoint: null,
    endpointInvalidatedAt: at,
    endpointInvalidatedReason: reason,
    // Drop report credentials so a dying pod cannot re-publish stale coordinates.
    reportTokenHash: null,
    reportTokenIssuedAt: null,
  };
}

/** Grace window after invalidate/recover while the new pod reports coordinates. */
export const SANDBOX_ENDPOINT_REPORT_GRACE_MS = 2 * 60_000;

function readMetaTimeMs(meta: unknown, key: string): number | null {
  if (!isRecord(meta)) return null;
  const raw = meta[key];
  if (typeof raw !== "string" || !raw.trim()) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** True while recover just cleared endpoint and report has not landed yet. */
export function isSandboxAwaitingEndpointReport(
  meta: unknown,
  input: { now?: Date; graceMs?: number } = {},
): boolean {
  if (!isRecord(meta)) return false;
  if (meta.recoveryStatus === "recreating") return true;
  const nowMs = (input.now ?? nowDate()).getTime();
  const graceMs = input.graceMs ?? SANDBOX_ENDPOINT_REPORT_GRACE_MS;
  const markers = ["endpointInvalidatedAt", "lastRecoveryStartedAt", "lastRecoveredAt"] as const;
  return markers.some((key) => {
    const ms = readMetaTimeMs(meta, key);
    return ms != null && nowMs - ms >= 0 && nowMs - ms < graceMs;
  });
}

export type SandboxPromptRecoveryReason =
  | "missing"
  | "auto_resume"
  | "auto_recover"
  | "missing_endpoint";

/**
 * Prompt-path liveness gate. Decides whether to fire-and-forget recover before
 * the agent even dials the sandbox.
 *
 * Intentionally does NOT use heartbeat age: idle sandboxes stop heartbeating
 * while the pod is still healthy. Dead coordinates with a present podIp are
 * handled by agent-side endpoint-unreachable recover instead.
 */
export function getSandboxPromptRecoveryReason(
  sandbox: {
    status?: string | null;
    provider?: string | null;
    meta?: unknown;
  } | null | undefined,
  input: { now?: Date } = {},
): SandboxPromptRecoveryReason | null {
  if (!sandbox) return "missing";
  if (isLocalSandboxProvider(sandbox.provider)) return null;
  if (sandbox.status === "provisioning" || sandbox.status === "pending") return null;
  if (sandbox.status === "terminated") return null;
  if (sandbox.status === "error") return "auto_recover";
  if (!isSandboxUsableStatus(sandbox.status)) return "auto_resume";
  if (!hasSandboxEndpoint(sandbox.meta)) {
    // Recover success marks running before report fills podIp; do not thrash.
    if (isSandboxAwaitingEndpointReport(sandbox.meta, input)) return null;
    return "missing_endpoint";
  }
  return null;
}

export function normalizeSandboxRuntimeStatus(status: SandboxStatus | string | null | undefined): SandboxRuntimeStatus {
  if (status === "ready" || status === "busy") return "healthy";
  if (status === "connecting" || status === "preparing") return "starting";
  if (status === "degraded") return "degraded";
  if (status === "error") return "unhealthy";
  return "unknown";
}

export function normalizeSandboxLifecycleStatus(status: SandboxStatus | string | null | undefined): SandboxLifecycleStatus {
  if (status === "ready" || status === "busy") return "running";
  if (status === "connecting" || status === "preparing" || status === "provisioning" || status === "pending") return "provisioning";
  if (status === "stopping" || status === "stopped" || status === "error" || status === "terminated") return status;
  if (status === "running") return "running";
  if (status === "degraded") return "running";
  return "pending";
}

export function normalizeSpaceSandboxAutoDestroyPolicy(value: unknown): SpaceSandboxAutoDestroyPolicy {
  if (!isRecord(value) || typeof value.mode !== "string") {
    throw new Error("sandbox autoDestroy must be an object with mode");
  }
  if (value.mode === "never") return { mode: "never" };
  if (value.mode !== "idle") {
    throw new Error("sandbox autoDestroy.mode must be one of: idle, never");
  }
  const ttlSeconds = Number((value as { ttlSeconds?: unknown }).ttlSeconds);
  if (!Number.isInteger(ttlSeconds)) {
    throw new Error("sandbox autoDestroy.ttlSeconds must be an integer number of seconds");
  }
  if (ttlSeconds < MIN_SPACE_SANDBOX_IDLE_TTL_SECONDS || ttlSeconds > MAX_SPACE_SANDBOX_IDLE_TTL_SECONDS) {
    throw new Error(`sandbox autoDestroy.ttlSeconds must be between ${MIN_SPACE_SANDBOX_IDLE_TTL_SECONDS} and ${MAX_SPACE_SANDBOX_IDLE_TTL_SECONDS}`);
  }
  return { mode: "idle", ttlSeconds };
}

export function resolveSpaceSandboxAutoDestroyPolicy(meta: unknown): SpaceSandboxAutoDestroyPolicy {
  if (!isRecord(meta)) return { mode: "idle", ttlSeconds: DEFAULT_SPACE_SANDBOX_IDLE_TTL_SECONDS };
  const config = isRecord(meta.config) ? meta.config : null;
  const sandbox = isRecord(config?.sandbox) ? config.sandbox : null;
  const autoDestroy = sandbox?.autoDestroy;
  if (!autoDestroy) return { mode: "idle", ttlSeconds: DEFAULT_SPACE_SANDBOX_IDLE_TTL_SECONDS };
  try {
    return normalizeSpaceSandboxAutoDestroyPolicy(autoDestroy);
  } catch {
    return { mode: "idle", ttlSeconds: DEFAULT_SPACE_SANDBOX_IDLE_TTL_SECONDS };
  }
}

export function getSpaceSandboxAutoDestroyDeadline(baseAt: Date, policy: SpaceSandboxAutoDestroyPolicy): Date | null {
  if (policy.mode === "never") return null;
  return new Date(baseAt.getTime() + policy.ttlSeconds * 1000);
}

export function getIdleBaseAt(row: Pick<SpaceSandboxRow, "lastActivityAt" | "lastHeartbeatAt" | "createdAt">) {
  return row.lastActivityAt ?? row.lastHeartbeatAt ?? row.createdAt ?? null;
}

export function isIdleCandidate(
  row: Pick<SpaceSandboxRow, "status" | "lastActivityAt" | "lastHeartbeatAt" | "createdAt">,
  input: { now?: Date; idleTtlSeconds?: number } = {},
) {
  if (!isSandboxUsableStatus(row.status)) return false;
  const baseAt = getIdleBaseAt(row);
  if (!baseAt) return false;
  const now = input.now ?? nowDate();
  const ttlSeconds = input.idleTtlSeconds ?? DEFAULT_SPACE_SANDBOX_IDLE_TTL_SECONDS;
  return now.getTime() - baseAt.getTime() >= ttlSeconds * 1000;
}

function toReportMeta(heartbeat: SandboxHeartbeat) {
  return {
    podName: heartbeat.metadata?.podName ?? null,
    sandboxId: heartbeat.sandboxId,
    hostname: heartbeat.metadata?.hostname ?? null,
    imageVersion: heartbeat.metadata?.imageVersion ?? null,
    startedAt: heartbeat.metadata?.startedAt ?? null,
    heartbeatStatus: heartbeat.status,
  };
}

function lockValue() {
  return `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

const LOCK_RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  end
  return 0
`;

export function createSandboxLifecycleController(input: {
  db: ControllerDb;
  infra: SandboxInfraAdapter | null;
  redis?: RedisLike | null;
  logger?: LoggerLike;
  lockTtlMs?: number;
}) {
  const db = input.db;
  const logger = input.logger ?? console;
  const lockTtlMs = input.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
  const infra = input.infra;
  const inputRedis = input.redis;

  async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T | { locked: true }> {
    if (!input.redis) return fn();
    const token = lockValue();
    const locked = await input.redis.set(key, token, "PX", lockTtlMs, "NX");
    if (locked !== "OK") return { locked: true };
    try {
      return await fn();
    } finally {
      await input.redis.eval(LOCK_RELEASE_SCRIPT, 1, key, token).catch(() => undefined);
    }
  }

  async function getSandbox(spaceId: string) {
    const [sandbox] = await db.select().from(spaceSandboxes).where(eq(spaceSandboxes.spaceId, spaceId)).limit(1);
    return sandbox ?? null;
  }

  async function getSpace(spaceId: string) {
    const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
    return space ?? null;
  }

  async function recordActivity(input: { spaceId: string; reason: SandboxActivityReason; rpcMethod?: RpcMethod | string | null; at?: Date }) {
    const at = input.at ?? nowDate();
    const patch = { lastActivityReason: input.reason, lastActivityRpcMethod: input.rpcMethod ?? null, lastActivityRecordedAt: at.toISOString() };
    const [sandbox] = await db.update(spaceSandboxes).set({
      lastActivityAt: at,
      meta: sql`coalesce(${spaceSandboxes.meta}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: at,
    }).where(eq(spaceSandboxes.spaceId, input.spaceId)).returning();
    return sandbox ?? null;
  }

  async function recordHeartbeat(input: { spaceId: string; heartbeat: SandboxHeartbeat; at?: Date }) {
    const at = input.at ?? nowDate();
    const heartbeat = input.heartbeat;
    const runtimeStatus = normalizeSandboxRuntimeStatus(heartbeat.status);
    const lifecycleStatus = normalizeSandboxLifecycleStatus(heartbeat.status);
    const reportedImageVersion = heartbeat.metadata?.imageVersion?.trim() || null;
    const existing = await getSandbox(input.spaceId);
    const reportMeta = toReportMeta(heartbeat);
    const shouldRefreshReport = Boolean(reportedImageVersion || heartbeat.capabilities || heartbeat.filesystem || heartbeat.metadata);

    const [sandbox] = await db.update(spaceSandboxes).set({
      status: lifecycleStatus === "running" ? "running" : lifecycleStatus,
      podName: heartbeat.metadata?.podName ?? existing?.podName ?? `sandbox-${input.spaceId}`,
      runtimeStatus,
      reportedImageVersion: reportedImageVersion ?? existing?.reportedImageVersion ?? null,
      ...(shouldRefreshReport ? { reportedAt: at } : {}),
      lastHeartbeatAt: at,
      stoppedAt: null,
      stopReason: null,
      meta: sql`coalesce(${spaceSandboxes.meta}, '{}'::jsonb) || ${JSON.stringify(reportMeta)}::jsonb`,
      updatedAt: at,
    }).where(eq(spaceSandboxes.spaceId, input.spaceId)).returning();
    return sandbox ?? null;
  }

  async function deletePublicNetworkBestEffort(spaceId: string, context: string) {
    if (!infra?.deletePublicNetwork) return {};

    try {
      await infra.deletePublicNetwork({ spaceId });
      return {
        publicNetworkStatus: "stopped",
        publicNetworkDeletedAt: nowDate().toISOString(),
        publicNetworkCleanupLastError: null,
        publicNetworkCleanupFailedAt: null,
        publicNetworkLastError: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[SandboxLifecycle] failed to delete ${context} sandbox public network spaceId=${spaceId}: ${message}`);
      return {
        publicNetworkStatus: "cleanup_error",
        publicNetworkCleanupLastError: "public network cleanup failed; see system logs",
        publicNetworkCleanupFailedAt: nowDate().toISOString(),
      };
    }
  }

  async function ensureRunning(input: { spaceId: string; reason: SandboxResumeReason }) {
    const sandbox = await getSandbox(input.spaceId);
    if (sandbox && isLocalSandboxProvider(sandbox.provider)) {
      // Local sandboxes are provided by the user's machine; they cannot be
      // resumed server-side. Usable only while the local runner is connected.
      return { ok: isSandboxUsableStatus(sandbox.status), status: sandbox.status, resumed: false, local: true };
    }
    if (sandbox && isSandboxUsableStatus(sandbox.status)) return { ok: true as const, status: sandbox.status, resumed: false };
    if (sandbox?.status === "provisioning") return { ok: true as const, status: sandbox.status, resumed: false, provisioning: true };
    if (sandbox?.status === "terminated") return { ok: false as const, status: sandbox.status, resumed: false, message: "sandbox is terminated" };
    if (!infra) return { ok: false as const, status: sandbox?.status ?? null, resumed: false, message: "sandbox infra adapter is not configured" };

    const result = await withLock(`sandbox:resume:${input.spaceId}`, async () => {
      const latest = await getSandbox(input.spaceId);
      if (latest && isSandboxUsableStatus(latest.status)) return { ok: true as const, status: latest.status, resumed: false };
      await db.update(spaceSandboxes).set({
        status: "provisioning",
        runtimeStatus: "starting",
        stoppedAt: null,
        stopReason: null,
        meta: sql`coalesce(${spaceSandboxes.meta}, '{}'::jsonb) || ${JSON.stringify({ resumeReason: input.reason, resumeStartedAt: new Date().toISOString() })}::jsonb`,
        updatedAt: new Date(),
      }).where(eq(spaceSandboxes.spaceId, input.spaceId));
      if (inputRedis) await markWorkspaceUsage(inputRedis, resolvedEnv, input.spaceId, 0, true);
      await infra.resumeSandbox(input);
      return { ok: true as const, status: "provisioning", resumed: true };
    });
    return "locked" in result ? { ok: true as const, status: sandbox?.status ?? "provisioning", resumed: false, recovering: true } : result;
  }

  async function stopSandbox(input: { spaceId: string; reason: SandboxStopReason; podName?: string | null; at?: Date }) {
    if (!infra) throw new Error("sandbox infra adapter is not configured");
    const at = input.at ?? nowDate();
    const sandbox = await getSandbox(input.spaceId);
    if (!sandbox) return { ok: false as const, status: null, message: "sandbox not found" };
    if (sandbox.status === "stopped") return { ok: true as const, status: "stopped", skipped: true };
    if (!isSandboxUsableStatus(sandbox.status)) return { ok: true as const, status: sandbox.status, skipped: true };
    const podName = input.podName ?? sandbox.podName ?? `sandbox-${input.spaceId}`;

    const result = await withLock(`sandbox:stop:${input.spaceId}`, async () => {
      const stoppingAt = at.toISOString();
      await db.update(spaceSandboxes).set({
        status: "stopping",
        runtimeStatus: "unknown",
        meta: sql`coalesce(${spaceSandboxes.meta}, '{}'::jsonb) || ${JSON.stringify({
          stopReason: input.reason,
          stoppingStartedAt: stoppingAt,
          ...sandboxEndpointInvalidationPatch(input.reason, stoppingAt),
        })}::jsonb`,
        updatedAt: at,
      }).where(eq(spaceSandboxes.spaceId, input.spaceId));

      await infra.deletePod({ podName });
      const deleted = await infra.waitForPodDeleted({ podName, timeoutMs: 120_000 });
      if (!deleted) throw new Error(`timed out waiting for sandbox pod deletion: ${podName}`);

      const publicNetworkMeta = await deletePublicNetworkBestEffort(input.spaceId, input.reason);

      const stoppedAt = nowDate();
      const stoppedAtIso = stoppedAt.toISOString();
      const [updated] = await db.update(spaceSandboxes).set({
        status: "stopped",
        runtimeStatus: "unknown",
        podName: null,
        stoppedAt,
        stopReason: input.reason,
        meta: sql`coalesce(${spaceSandboxes.meta}, '{}'::jsonb) || ${JSON.stringify({
          stoppedAt: stoppedAtIso,
          stopReason: input.reason,
          ...sandboxEndpointInvalidationPatch(input.reason, stoppedAtIso),
          ...publicNetworkMeta,
        })}::jsonb`,
        updatedAt: stoppedAt,
      }).where(eq(spaceSandboxes.spaceId, input.spaceId)).returning();
      if (inputRedis) await markWorkspaceUsage(inputRedis, resolvedEnv, input.spaceId, 0, false);
      return { ok: true as const, status: updated?.status ?? "stopped", stoppedAt };
    });
    return "locked" in result ? { ok: true as const, status: sandbox.status, skipped: true, locked: true } : result;
  }

  async function checkIdleSandbox(input: { spaceId: string; now?: Date }) {
    const now = input.now ?? nowDate();
    const [space, sandbox] = await Promise.all([getSpace(input.spaceId), getSandbox(input.spaceId)]);
    if (!space) return { ok: false as const, skipped: true, reason: "space_not_found" };
    if (!sandbox) return { ok: true as const, skipped: true, reason: "sandbox_not_found" };
    if (isLocalSandboxProvider(sandbox.provider)) return { ok: true as const, skipped: true, reason: "local_provider" };
    if (!isSandboxUsableStatus(sandbox.status)) return { ok: true as const, skipped: true, reason: "not_usable" };

    const policy = resolveSpaceSandboxAutoDestroyPolicy(space.meta);
    if (policy.mode === "never") return { ok: true as const, skipped: true, reason: "never" };

    const evaluateDue = (row: NonNullable<typeof sandbox>) => {
      const baseAt = getIdleBaseAt(row);
      if (!baseAt) return { due: false as const, reason: "no_base_time" as const, dueAt: null as Date | null };
      const dueAt = getSpaceSandboxAutoDestroyDeadline(baseAt, policy);
      if (!dueAt || now.getTime() < dueAt.getTime()) {
        return { due: false as const, reason: "not_due" as const, dueAt };
      }
      return { due: true as const, reason: "due" as const, dueAt };
    };

    const first = evaluateDue(sandbox);
    if (!first.due) {
      return {
        ok: true as const,
        skipped: true,
        reason: first.reason,
        dueAt: first.dueAt?.toISOString() ?? null,
      };
    }

    // Re-read before stop so concurrent recover/activity that refreshed
    // lastActivityAt is not wiped by a stale first-pass due decision.
    const latest = await getSandbox(input.spaceId);
    if (!latest) return { ok: true as const, skipped: true, reason: "sandbox_not_found" };
    if (!isSandboxUsableStatus(latest.status)) return { ok: true as const, skipped: true, reason: "not_usable" };
    const second = evaluateDue(latest);
    if (!second.due) {
      return {
        ok: true as const,
        skipped: true,
        reason: second.reason,
        dueAt: second.dueAt?.toISOString() ?? null,
      };
    }

    const stopped = await stopSandbox({
      spaceId: input.spaceId,
      reason: "idle",
      podName: latest.podName ?? null,
      at: now,
    });
    return { ...stopped, dueAt: second.dueAt.toISOString() };
  }

  async function cleanupStaleSandbox(input: { spaceId: string; podName: string | null; status: string }) {
    if (!infra) throw new Error("sandbox infra adapter is not configured");
    const podName = input.podName ?? `sandbox-${input.spaceId}`;
    const result = await withLock(`sandbox:cleanup:${input.spaceId}`, async () => {
      await infra.deletePod({ podName });
      const deleted = await infra.waitForPodDeleted({ podName, timeoutMs: 120_000 });
      if (!deleted) throw new Error(`timed out waiting for stale sandbox pod deletion: ${podName}`);

      const publicNetworkMeta = await deletePublicNetworkBestEffort(input.spaceId, "stale");

      const stoppedAt = nowDate();
      const stoppedAtIso = stoppedAt.toISOString();
      const [updated] = await db.update(spaceSandboxes).set({
        status: "stopped",
        runtimeStatus: "unknown",
        podName: null,
        stoppedAt,
        stopReason: "cleanup",
        meta: sql`coalesce(${spaceSandboxes.meta}, '{}'::jsonb) || ${JSON.stringify({
          stoppedAt: stoppedAtIso,
          stopReason: "cleanup",
          cleanupFromStatus: input.status,
          ...sandboxEndpointInvalidationPatch("cleanup", stoppedAtIso),
          ...publicNetworkMeta,
        })}::jsonb`,
        updatedAt: stoppedAt,
      }).where(eq(spaceSandboxes.spaceId, input.spaceId)).returning();
      if (inputRedis) await markWorkspaceUsage(inputRedis, resolvedEnv, input.spaceId, 0, false);
      return { ok: true as const, status: updated?.status ?? "stopped", stoppedAt };
    });
    return "locked" in result ? { ok: true as const, status: input.status, skipped: true, locked: true } : result;
  }

  async function reapIdleSandboxes(input: { limit?: number; now?: Date } = {}) {
    const now = input.now ?? nowDate();
    const limit = input.limit ?? 50;
    const candidates = await db
      .select({ spaceId: spaceSandboxes.spaceId })
      .from(spaceSandboxes)
      .innerJoin(spaces, eq(spaceSandboxes.spaceId, spaces.id))
      .where(sql`
        ${spaceSandboxes.status} in ('ready', 'running')
        and ${spaceSandboxes.provider} <> 'local'
        and coalesce(${spaces.meta}->'config'->'sandbox'->'autoDestroy'->>'mode', 'idle') <> 'never'
        and coalesce(${spaceSandboxes.lastActivityAt}, ${spaceSandboxes.lastHeartbeatAt}, ${spaceSandboxes.createdAt}) is not null
        and coalesce(${spaceSandboxes.lastActivityAt}, ${spaceSandboxes.lastHeartbeatAt}, ${spaceSandboxes.createdAt})
          + (${AUTO_DESTROY_TTL_SQL} || ' seconds')::interval <= ${now.toISOString()}::timestamptz
      `)
      .orderBy(sql`
        coalesce(${spaceSandboxes.lastActivityAt}, ${spaceSandboxes.lastHeartbeatAt}, ${spaceSandboxes.createdAt})
          + (${AUTO_DESTROY_TTL_SQL} || ' seconds')::interval
      `)
      .limit(limit);
    const staleBefore = new Date(now.getTime() - STALE_SANDBOX_CLEANUP_GRACE_MS);
    const staleCandidates = await db
      .select({ spaceId: spaceSandboxes.spaceId, status: spaceSandboxes.status, podName: spaceSandboxes.podName })
      .from(spaceSandboxes)
      .where(sql`
        ${spaceSandboxes.status} in ('stopping', 'error')
        and ${spaceSandboxes.provider} <> 'local'
        and ${spaceSandboxes.podName} is not null
        and coalesce(${spaceSandboxes.updatedAt}, ${spaceSandboxes.createdAt}) <= ${staleBefore.toISOString()}::timestamptz
      `)
      .orderBy(asc(spaceSandboxes.updatedAt), asc(spaceSandboxes.createdAt))
      .limit(limit);
    const stopped: Array<{ spaceId: string; status: string }> = [];
    const skipped: Array<{ spaceId: string; status: string; reason: string }> = [];
    const cleaned: Array<{ spaceId: string; status: string }> = [];
    const failed: Array<{ spaceId: string; error: string }> = [];

    for (const candidate of candidates) {
      try {
        const result = await checkIdleSandbox({ spaceId: candidate.spaceId, now });
        if (result.ok && !("skipped" in result)) {
          stopped.push({ spaceId: candidate.spaceId, status: result.status ?? "unknown" });
        } else {
          const reason = "reason" in result ? String(result.reason) : "locked" in result ? "locked" : "unknown";
          const status = "status" in result ? String(result.status ?? "unknown") : "unknown";
          skipped.push({ spaceId: candidate.spaceId, status, reason });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ spaceId: candidate.spaceId, error: message });
        logger.error(`[SandboxReaper] failed to stop idle sandbox spaceId=${candidate.spaceId}: ${message}`);
      }
    }

    for (const candidate of staleCandidates) {
      try {
        const result = await cleanupStaleSandbox({ spaceId: candidate.spaceId, podName: candidate.podName, status: candidate.status });
        if (result.ok && !("skipped" in result)) {
          cleaned.push({ spaceId: candidate.spaceId, status: result.status ?? "unknown" });
        } else {
          const reason = "locked" in result ? "locked" : "unknown";
          skipped.push({ spaceId: candidate.spaceId, status: candidate.status, reason });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ spaceId: candidate.spaceId, error: message });
        logger.error(`[SandboxReaper] failed to clean stale sandbox spaceId=${candidate.spaceId}: ${message}`);
      }
    }

    return { scanned: candidates.length, staleScanned: staleCandidates.length, stopped, cleaned, skipped, failed };
  }

  return { getSandbox, recordActivity, recordHeartbeat, ensureRunning, stopSandbox, checkIdleSandbox, reapIdleSandboxes };
}
