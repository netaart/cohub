import { and, asc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { billingOperations, COHUB_BILLING_FEATURES } from "@cohub/billing";
import {
  DEFAULT_SANDBOX_SPEC_ID,
  SANDBOX_SPECS,
  buildInvalidatedSandboxEndpointMeta,
  getSandboxSpecRank,
  isSandboxAwaitingEndpointReport,
  isSandboxDialable,
  normalizeSandboxSpecId,
  resolveSpaceSandboxAutoDestroyPolicy,
  type SandboxSpecId,
} from "@cohub/sandbox-controller";
import { createSandboxRpcNonce, createSandboxRpcToken } from "@cohub/sandbox-client";
import { db } from "./db/index.js";
import { listEnabledSpaceMods, getSpaceModMountSignature } from "@cohub/core/space-mods";
import { spaceSandboxes, spaces } from "@cohub/db";
import { sessionsNamespace, config } from "./config.js";
import { k8sCoreApi } from "./k8s.js";
import { renderSandboxPodTemplate } from "./sandbox-template.js";
import { deleteSandboxPublicNetwork, getSandboxPublicEndpoints, reconcileSandboxPublicNetwork } from "./sandbox-public-network.js";
import { createSandboxReportToken, hashSandboxReportToken } from "./crypto.js";
import { redisCommandClient } from "./redis.js";
import { publishSandboxLifecycleEvent } from "./sandbox-events.js";
import { scheduleSandboxAutoDestroy } from "./sandbox-idle-scheduler.js";
import type { SpaceSandboxRuntimeStatus, SpaceSandboxStatus, SpaceSandboxStopReason } from "./lib/sandbox/types.js";
import { smokeVerifySandboxPod } from "./lib/sandbox/recovery.js";
import { acquireSandboxProvisioningLease, type SandboxProvisioningLease } from "./lib/sandbox/provisioning-lock.js";
import type { V1Pod } from "@kubernetes/client-node";
import { createLogger } from "@cohub/infra/logging";


const logger = createLogger({ serviceName: "cohub-api" });
export const toSandboxImageVersion = (image: string) => {
  const normalized = image.trim();
  if (!normalized) return "cohub-sandbox:unknown";
  return normalized.split("/").pop() ?? normalized;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const RECOVERY_COOLDOWN_MS = 60_000;

const asMetaObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
};

const getK8sStatusCode = (error: unknown) => {
  return (error as { statusCode?: number; code?: number }).statusCode
    ?? (error as { statusCode?: number; code?: number }).code
    ?? null;
};

const getSpaceSandboxSpec = async (spaceId: string): Promise<SandboxSpecId> => {
  const [space] = await db.select({ meta: spaces.meta }).from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  const meta = asMetaObject(space?.meta);
  const config = asMetaObject(meta.config);
  const sandbox = asMetaObject(config.sandbox);
  return normalizeSandboxSpecId(sandbox.spec);
};

const getAllowedSandboxSpecId = async (userId: string): Promise<SandboxSpecId> => {
  try {
    const state = await billingOperations.getState({ userId });
    const keys = new Set(state.entitlements.filter((entitlement) => entitlement.enabled).map((entitlement) => entitlement.key));
    if (keys.has(COHUB_BILLING_FEATURES.sandboxSpecUltra)) return "ultra";
    if (keys.has(COHUB_BILLING_FEATURES.sandboxSpecBoost)) return "boost";
    return DEFAULT_SANDBOX_SPEC_ID;
  } catch (error) {
    logger.warn("[SandboxSpec] failed to check entitlement during reconcile", { userId, error });
    return DEFAULT_SANDBOX_SPEC_ID;
  }
};

const getK8sErrorMessage = (error: unknown) => {
  const body = (error as { body?: unknown }).body;
  if (typeof body === "string" && body.trim()) return body;
  if (body && typeof body === "object") {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error);
};

export const waitForSandboxPodDeleted = async (podName: string, timeoutMs = 120_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await k8sCoreApi.readNamespacedPod({
        name: podName,
        namespace: sessionsNamespace,
      });
      await sleep(1000);
    } catch (error: unknown) {
      const statusCode = getK8sStatusCode(error);
      if (statusCode === 404) return true;
      throw error;
    }
  }
  return false;
};

const resourcesMatch = (actual: unknown, expected: { limits: Record<string, string>; requests: Record<string, string> }) => {
  const value = asMetaObject(actual);
  const limits = asMetaObject(value.limits);
  const requests = asMetaObject(value.requests);
  return limits.cpu === expected.limits.cpu
    && limits.memory === expected.limits.memory
    && requests.cpu === expected.requests.cpu
    && requests.memory === expected.requests.memory;
};

type SandboxPodResizeOutcome = { status: "applied" } | { status: "pending" } | { status: "timeout" };

const waitForSandboxPodResizeApplied = async (input: { podName: string; resources: { limits: Record<string, string>; requests: Record<string, string> }; timeoutMs?: number }): Promise<SandboxPodResizeOutcome> => {
  const timeoutMs = input.timeoutMs ?? 15_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pod = await k8sCoreApi.readNamespacedPod({ name: input.podName, namespace: sessionsNamespace });
    const sandboxStatus = pod.status?.containerStatuses?.find((container) => container.name === "sandbox");
    if (resourcesMatch((sandboxStatus as { resources?: unknown } | undefined)?.resources, input.resources)) return { status: "applied" };
    // kubelet defers or rejects the in-place resize when the node lacks capacity; a restart reschedules the pod.
    const resizePending = pod.status?.conditions?.some((condition) => condition.type === "PodResizePending" && condition.status === "True") === true;
    if (resizePending) return { status: "pending" };
    await sleep(1000);
  }
  return { status: "timeout" };
};

export const markSandboxSpecPendingRestart = async (input: { spaceId: string; specId: SandboxSpecId; reason: string }) => {
  const spec = SANDBOX_SPECS[input.specId] ?? SANDBOX_SPECS[DEFAULT_SANDBOX_SPEC_ID];
  await mergeSpaceSandboxMeta(input.spaceId, {
    desiredSpec: input.specId,
    desiredSpecResources: spec.resources,
    specApplying: false,
    specPendingRestart: true,
    specPendingRestartReason: input.reason,
    specPendingRestartAt: new Date().toISOString(),
  });
};

export const resizeSpaceSandboxToSpec = async (input: { spaceId: string; specId: SandboxSpecId }) => {
  const sandbox = await getSpaceSandboxBySpaceId(input.spaceId);
  if (!sandbox || sandbox.provider === "local") return { resized: false, pendingRestart: false, skipped: true };
  if (sandbox.status !== "running" && sandbox.status !== "ready") {
    await markSandboxSpecPendingRestart({ spaceId: input.spaceId, specId: input.specId, reason: "sandbox_not_running" });
    return { resized: false, pendingRestart: true, skipped: true };
  }
  const podName = sandbox.podName ?? `sandbox-${input.spaceId}`;
  const spec = SANDBOX_SPECS[input.specId] ?? SANDBOX_SPECS[DEFAULT_SANDBOX_SPEC_ID];
  const k8sObjectApi = k8sCoreApi as typeof k8sCoreApi & {
    patchNamespacedPodResize?: (input: { name: string; namespace: string; body: unknown }) => Promise<unknown>;
  };
  if (!k8sObjectApi.patchNamespacedPodResize) {
    await markSandboxSpecPendingRestart({ spaceId: input.spaceId, specId: input.specId, reason: "pod_resize_api_unavailable" });
    return { resized: false, pendingRestart: true, message: "pod resize API is unavailable; restart required" };
  }

  const startedAt = new Date();
  await k8sObjectApi.patchNamespacedPodResize({
    name: podName,
    namespace: sessionsNamespace,
    body: [
      {
        op: "replace",
        path: "/spec/containers/0/resources",
        value: spec.resources,
      },
    ],
  });

  await mergeSpaceSandboxMeta(input.spaceId, {
    desiredSpec: input.specId,
    desiredSpecResources: spec.resources,
    specApplying: true,
    specApplyingStartedAt: startedAt.toISOString(),
    specPendingRestart: false,
  });

  const outcome = await waitForSandboxPodResizeApplied({ podName, resources: spec.resources });
  if (outcome.status === "pending") {
    await markSandboxSpecPendingRestart({ spaceId: input.spaceId, specId: input.specId, reason: "resize_deferred" });
    return { resized: false, pendingRestart: true, message: "restart the sandbox to apply the new spec" };
  }
  if (outcome.status === "timeout") return { resized: true, applying: true, pendingRestart: false, message: "pod resize is still applying" };

  await mergeSpaceSandboxMeta(input.spaceId, {
    appliedSpec: input.specId,
    appliedSpecResources: spec.resources,
    appliedSpecUpdatedAt: new Date().toISOString(),
    specApplying: false,
    specPendingRestart: false,
  });
  return { resized: true, applying: false, pendingRestart: false, appliedSpec: input.specId };
};

export const waitForSandboxPodReady = async (podName: string, timeoutMs = 120_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const pod = await k8sCoreApi.readNamespacedPod({ name: podName, namespace: sessionsNamespace });
      const ready = pod.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True") === true;
      if (ready) return true;
    } catch (error: unknown) {
      const statusCode = getK8sStatusCode(error);
      if (statusCode !== 404) throw error;
    }
    await sleep(1000);
  }
  return false;
};

export const getSpaceSandboxBySpaceId = async (spaceId: string) => {
  const [sandbox] = await db
    .select()
    .from(spaceSandboxes)
    .where(eq(spaceSandboxes.spaceId, spaceId))
    .limit(1);

  return sandbox ?? null;
};

async function claimSandboxProvisioning(
  spaceId: string,
  existing: Awaited<ReturnType<typeof getSpaceSandboxBySpaceId>>,
  lease: SandboxProvisioningLease,
) {
  await lease.assertOwned();
  const previousGeneration = asMetaObject(existing?.meta).provisioningGeneration ?? null;
  const marker = { provisioningGeneration: lease.generation };
  const [claimed] = await db.insert(spaceSandboxes).values({
    spaceId,
    provider: "cloud",
    status: "provisioning",
    runtimeStatus: "starting",
    podName: `sandbox-${spaceId}`,
    meta: marker,
  }).onConflictDoUpdate({
    target: spaceSandboxes.spaceId,
    set: {
      meta: sql`coalesce(${spaceSandboxes.meta}, '{}'::jsonb) || ${JSON.stringify(marker)}::jsonb`,
      updatedAt: new Date(),
    },
    // A late claim must not take ownership back from a newer generation.
    setWhere: sql`${spaceSandboxes.meta}->>'provisioningGeneration' is not distinct from ${previousGeneration}`,
  }).returning();
  if (!claimed) throw new Error("Sandbox provisioning generation changed");
  await lease.assertOwned();
  return claimed;
}

export const ensureSpaceSandbox = async (input: {
  spaceId: string;
  provider?: "cloud" | "local";
  status?: SpaceSandboxStatus;
  runtimeStatus?: SpaceSandboxRuntimeStatus;
  podName?: string | null;
  desiredImage?: string | null;
  reportedImageVersion?: string | null;
  reportedAt?: Date | null;
  lastActivityAt?: Date | null;
  stoppedAt?: Date | null;
  stopReason?: SpaceSandboxStopReason | null;
  meta?: Record<string, unknown> | null;
}) => {
  const [sandbox] = await db
    .insert(spaceSandboxes)
    .values({
      spaceId: input.spaceId,
      provider: input.provider ?? "cloud",
      status: input.status ?? "pending",
      runtimeStatus: input.runtimeStatus ?? "unknown",
      podName: input.podName ?? null,
      desiredImage: input.desiredImage ?? null,
      reportedImageVersion: input.reportedImageVersion ?? null,
      reportedAt: input.reportedAt ?? null,
      lastActivityAt: input.lastActivityAt ?? null,
      stoppedAt: input.stoppedAt ?? null,
      stopReason: input.stopReason ?? null,
      meta: input.meta ?? null,
    })
    .onConflictDoUpdate({
      target: spaceSandboxes.spaceId,
      set: {
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        status: input.status ?? "pending",
        runtimeStatus: input.runtimeStatus ?? "unknown",
        podName: input.podName ?? null,
        ...(input.desiredImage !== undefined ? { desiredImage: input.desiredImage } : {}),
        ...(input.reportedImageVersion !== undefined ? { reportedImageVersion: input.reportedImageVersion } : {}),
        ...(input.reportedAt !== undefined ? { reportedAt: input.reportedAt } : {}),
        ...(input.lastActivityAt !== undefined ? { lastActivityAt: input.lastActivityAt } : {}),
        ...(input.stoppedAt !== undefined ? { stoppedAt: input.stoppedAt } : {}),
        ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
        meta: input.meta ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  if (!sandbox) throw new Error("Failed to ensure space sandbox");
  return sandbox;
};

export const deleteSpaceSandbox = async (spaceId: string) => {
  await deleteSandboxPublicNetwork(spaceId);

  const [sandbox] = await db
    .delete(spaceSandboxes)
    .where(eq(spaceSandboxes.spaceId, spaceId))
    .returning();

  return sandbox ?? null;
};

export const updateSpaceSandbox = async (input: {
  spaceId: string;
  expectedReportTokenHash?: string;
  expectedProvisioningGeneration?: string | null;
  status?: SpaceSandboxStatus;
  runtimeStatus?: SpaceSandboxRuntimeStatus;
  podName?: string | null;
  desiredImage?: string | null;
  reportedImageVersion?: string | null;
  reportedAt?: Date | null;
  lastHeartbeatAt?: Date | null;
  lastActivityAt?: Date | null;
  stoppedAt?: Date | null;
  stopReason?: SpaceSandboxStopReason | null;
  meta?: Record<string, unknown> | null;
}) => {
  const [sandbox] = await db
    .update(spaceSandboxes)
    .set({
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.runtimeStatus !== undefined ? { runtimeStatus: input.runtimeStatus } : {}),
      ...(input.podName !== undefined ? { podName: input.podName } : {}),
      ...(input.desiredImage !== undefined ? { desiredImage: input.desiredImage } : {}),
      ...(input.reportedImageVersion !== undefined ? { reportedImageVersion: input.reportedImageVersion } : {}),
      ...(input.reportedAt !== undefined ? { reportedAt: input.reportedAt } : {}),
      ...(input.lastHeartbeatAt !== undefined ? { lastHeartbeatAt: input.lastHeartbeatAt } : {}),
      ...(input.lastActivityAt !== undefined ? { lastActivityAt: input.lastActivityAt } : {}),
      ...(input.stoppedAt !== undefined ? { stoppedAt: input.stoppedAt } : {}),
      ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
      ...(input.meta !== undefined ? { meta: input.meta } : {}),
      updatedAt: new Date(),
    })
    .where(and(
      eq(spaceSandboxes.spaceId, input.spaceId),
      input.expectedReportTokenHash !== undefined
        ? sql`${spaceSandboxes.meta}->>'reportTokenHash' = ${input.expectedReportTokenHash}`
        : undefined,
      input.expectedProvisioningGeneration !== undefined
        ? sql`${spaceSandboxes.meta}->>'provisioningGeneration' is not distinct from ${input.expectedProvisioningGeneration}`
        : undefined,
    ))
    .returning();

  return sandbox ?? null;
};

export const mergeSpaceSandboxMeta = async (spaceId: string, metaPatch: Record<string, unknown>) => {
  const [sandbox] = await db
    .update(spaceSandboxes)
    .set({
      meta: sql`(
        CASE
          WHEN jsonb_typeof(${spaceSandboxes.meta}) = 'object' THEN ${spaceSandboxes.meta}
          ELSE '{}'::jsonb
        END
      ) || ${JSON.stringify(metaPatch)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(spaceSandboxes.spaceId, spaceId))
    .returning();

  return sandbox ?? null;
};

export const listSandboxRolloutTargets = async (input?: {
  targetImageVersion?: string;
  limit?: number;
}) => {
  const baseQuery = db
    .select({
      spaceId: spaceSandboxes.spaceId,
      userUuid: spaces.userUuid,
      podName: spaceSandboxes.podName,
      status: spaceSandboxes.status,
      desiredImage: spaceSandboxes.desiredImage,
      reportedImageVersion: spaceSandboxes.reportedImageVersion,
      updatedAt: spaceSandboxes.updatedAt,
      createdAt: spaceSandboxes.createdAt,
    })
    .from(spaceSandboxes)
    .innerJoin(spaces, eq(spaceSandboxes.spaceId, spaces.id))
    .orderBy(asc(spaceSandboxes.updatedAt), asc(spaceSandboxes.createdAt));

  if (input?.targetImageVersion) {
    return baseQuery
      .where(or(
        isNull(spaceSandboxes.desiredImage),
        ne(spaceSandboxes.desiredImage, input.targetImageVersion),
        isNull(spaceSandboxes.reportedImageVersion),
        ne(spaceSandboxes.reportedImageVersion, input.targetImageVersion),
      ))
      .limit(input.limit ?? 10_000);
  }

  return baseQuery.limit(input?.limit ?? 10_000);
};

const triggerSandboxPublicNetworkReconcile = (spaceId: string) => {
  void reconcileSandboxPublicNetwork(spaceId)
    .then(async () => {
      await mergeSpaceSandboxMeta(spaceId, {
        publicNetappStatus: "ready",
        publicNetworkLastError: null,
        publicNetworkReconciledAt: new Date().toISOString(),
        publicEndpoints: getSandboxPublicEndpoints(spaceId),
      });
    })
    .catch(async (error) => {
      await mergeSpaceSandboxMeta(spaceId, {
        publicNetappStatus: "error",
        publicNetworkLastError: error instanceof Error ? error.message : String(error),
        publicEndpoints: getSandboxPublicEndpoints(spaceId),
      }).catch(() => undefined);
      logger.error(`[SandboxPublicNetwork] reconcile failed spaceId=${spaceId}`, error);
    });
};

const tryCreatePod = async (spaceId: string, pod: V1Pod, lease: SandboxProvisioningLease): Promise<{ podName: string; created: boolean }> => {
  await lease.assertOwned();
  try {
    await k8sCoreApi.createNamespacedPod({
      namespace: sessionsNamespace,
      body: pod,
    });
    return { podName: `sandbox-${spaceId}`, created: true };
  } catch (error: unknown) {
    const statusCode = getK8sStatusCode(error);
    const message = getK8sErrorMessage(error).toLowerCase();
    const podName = `sandbox-${spaceId}`;

    if (statusCode === 409 && message.includes("object is being deleted")) {
      const deleted = await waitForSandboxPodDeleted(podName);
      if (!deleted) throw new Error(`timed out waiting for deleted sandbox pod: ${podName}`);
      return tryCreatePod(spaceId, pod, lease);
    }

    if (statusCode === 409) return { podName, created: false };
    throw error;
  }
};

type ReconcileSandboxInput = {
  spaceId: string;
  userUuid: string;
  ownerUserUuid?: string;
  mode: "ensure" | "replace";
  reason: "space_created" | "manual_recreate" | "auto_recover" | "auto_resume" | "space_mods_changed";
};

async function recordProvisioningFailure(spaceId: string, lease: SandboxProvisioningLease, error: unknown) {
  try {
    // A lost lease may fail its own unfinished generation, never a successor's row.
    const latest = await getSpaceSandboxBySpaceId(spaceId);
    await updateSpaceSandbox({
      spaceId,
      expectedProvisioningGeneration: lease.generation,
      status: "error",
      runtimeStatus: "unhealthy",
      meta: {
        ...asMetaObject(latest?.meta),
        recoveryStatus: "failed",
        lastRecoveryFailedAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
        lastRecoveryError: error instanceof Error ? error.message : String(error),
      },
    });
  } catch (cleanupError) {
    logger.warn(`[SandboxProvisioning] skipped failure update spaceId=${spaceId}:`, cleanupError);
  }
}

export const reconcileSpaceSandbox = async (input: ReconcileSandboxInput) => {
  const lease = await acquireSandboxProvisioningLease(input.spaceId);
  if (!lease) return;
  try {
    await reconcileSpaceSandboxLocked(input, lease);
  } catch (error) {
    await recordProvisioningFailure(input.spaceId, lease, error);
    throw error;
  } finally {
    await lease.release().catch((error) => logger.warn("[SandboxProvisioning] lock release failed", error));
  }
};

async function reconcileSpaceSandboxLocked(
  input: ReconcileSandboxInput,
  lease: SandboxProvisioningLease,
  recovery?: { reason: string; source: string },
) {
  const podName = `sandbox-${input.spaceId}`;
  const existing = await getSpaceSandboxBySpaceId(input.spaceId);
  const existingSandbox = await claimSandboxProvisioning(input.spaceId, existing, lease);
  const existingMeta = asMetaObject(existingSandbox.meta);
  const recoveryMeta = recovery ? {
    recoveryStatus: "recreating",
    recoveryLevel: "L2",
    recoverySource: recovery.source,
    lastRecoveryReason: recovery.reason,
    lastRecoveryStartedAt: new Date().toISOString(),
    lastRecoveryError: null,
  } : {};

  if (input.mode === "replace") {
    const generation = new Date().toISOString();
    await publishSandboxLifecycleEvent({
      type: "sandbox.replacing",
      spaceId: input.spaceId,
      reason: input.reason,
      source: "api",
      generation,
      podName: existingSandbox?.podName ?? podName,
      podIp: typeof existingMeta.podIp === "string" ? existingMeta.podIp : null,
    }).catch((error) => {
      logger.warn(`[SandboxEvents] failed to publish replacing event spaceId=${input.spaceId}:`, error);
    });

    // Invalidate endpoint + report token immediately so agents stop dialing the
    // dying pod and it cannot re-publish the dead coordinates.
    await lease.assertOwned();
    const invalidated = await updateSpaceSandbox({
      spaceId: input.spaceId,
      expectedProvisioningGeneration: lease.generation,
      status: "provisioning",
      runtimeStatus: "starting",
      meta: {
        ...buildInvalidatedSandboxEndpointMeta(existingMeta, input.reason, generation),
        ...recoveryMeta,
        provisioningGeneration: lease.generation,
      },
    });
    if (!invalidated) throw new Error("Sandbox provisioning generation changed");

    const podToReplace = existingSandbox.podName ?? podName;
    try {
      const pod = await k8sCoreApi.readNamespacedPod({ name: podToReplace, namespace: sessionsNamespace });
      if (!pod.metadata?.uid) throw new Error("Sandbox Pod UID is missing");
      await lease.assertOwned();
      await k8sCoreApi.deleteNamespacedPod({
        name: podToReplace,
        namespace: sessionsNamespace,
        body: { preconditions: { uid: pod.metadata.uid } },
      });
    } catch (error: unknown) {
      const statusCode = getK8sStatusCode(error);
      if (statusCode !== 404) throw error;
    }

    const deleted = await waitForSandboxPodDeleted(podToReplace);
    if (!deleted) {
      throw new Error(`Timed out waiting for sandbox pod deletion: ${podToReplace}`);
    }
  }

  const configuredSpec = await getSpaceSandboxSpec(input.spaceId);
  const allowedSpec = await getAllowedSandboxSpecId(input.ownerUserUuid ?? input.userUuid);
  const desiredSpec = getSandboxSpecRank(configuredSpec) > getSandboxSpecRank(allowedSpec) ? allowedSpec : configuredSpec;
  const specEntitlementDowngraded = desiredSpec !== configuredSpec;
  const desiredSpecConfig = SANDBOX_SPECS[desiredSpec] ?? SANDBOX_SPECS[DEFAULT_SANDBOX_SPEC_ID];
  const reportToken = createSandboxReportToken();
  const reportTokenHash = hashSandboxReportToken(reportToken);
  const rpcTokenNonce = createSandboxRpcNonce();
  const rpcToken = createSandboxRpcToken(config.appEncryptionKey, input.spaceId, rpcTokenNonce);
  const reportTokenIssuedAt = new Date().toISOString();
  const nowIso = new Date().toISOString();
  const baseMeta = input.mode === "replace"
    ? buildInvalidatedSandboxEndpointMeta(existingMeta, input.reason, nowIso)
    : existingMeta;
  const provisioningMeta = {
    ...baseMeta,
    ...recoveryMeta,
    provisioningGeneration: lease.generation,
    ...(input.mode === "replace" ? { recreatedAt: nowIso } : {}),
    reconcileReason: input.reason,
    provisioningStartedAt: nowIso,
    reportTokenHash,
    rpcTokenNonce,
    reportTokenIssuedAt,
    publicNetappStatus: "provisioning",
    publicNetworkLastError: null,
    publicEndpoints: getSandboxPublicEndpoints(input.spaceId),
  };

  const pod = renderSandboxPodTemplate({
    SPACE_ID: input.spaceId,
    USER_ID: input.userUuid,
    OWNER_USER_ID: input.ownerUserUuid ?? input.userUuid,
    ENV: config.env,
    SPACE_STORAGE_PVC: config.spaceStoragePvc,
    SPACE_STORAGE_SUBPATH: config.spaceStorageSubpath,
    SPACE_SYSTEM_PVC: config.spaceSystemPvc,
    SPACE_SYSTEM_SUBPATH: config.spaceSystemSubpath,
    CONFIGS_SUBPATH: config.configsSubpath,
    SANDBOX_SPEC_ID: desiredSpec,
  }) as V1Pod;

  const enabledMods = await listEnabledSpaceMods(db, input.spaceId);
  const modMountSignature = getSpaceModMountSignature(enabledMods);

  if (pod.spec?.containers?.[0]) {
    const container = pod.spec.containers[0];
    container.volumeMounts = [
      ...(container.volumeMounts ?? []),
      ...enabledMods.map((mod) => ({
        name: "checkpoint-cache",
        mountPath: mod.mountPath,
        subPath: `${config.checkpointCacheSubpath}/${mod.modSpaceId}/latest`,
        readOnly: true,
      })),
    ];
    if (!pod.spec.volumes?.some((volume) => volume.name === "checkpoint-cache")) {
      pod.spec.volumes = [
        ...(pod.spec.volumes ?? []),
        {
          name: "checkpoint-cache",
          persistentVolumeClaim: { claimName: config.checkpointCachePvc },
        },
      ];
    }
    container.env = [
      { name: "COHUB_SPACE_ID", value: input.spaceId },
      ...(config.env === "dev" ? [{ name: "ENV", value: "dev" }] : []),
      { name: "WORKSPACE_DIR", value: "/workspace" },
      { name: "PLATFORM_AGENTS_DIR", value: "/configs/platform/.agents" },
      { name: "USER_AGENTS_DIR", value: "/configs/user/.agents" },
      { name: "COHUB_SEARCH_ENABLED", value: String(config.sandboxSearchEnabled) },
      { name: "COHUB_SEARCH_VERSION", value: config.sandboxSearchVersion },
      { name: "COHUB_SEARCH_CDN_BASE_URL", value: config.sandboxSearchCdnBaseUrl },
      { name: "COHUB_SANDBOX_VERSION", value: toSandboxImageVersion(config.sandboxImage) },
      { name: "POD_IP", valueFrom: { fieldRef: { fieldPath: "status.podIP" } } },
      {
        name: "INTERNAL_API_BASE_URL",
        value:
          config.env === "prod"
            ? "http://cohub-api.cohub.svc.cluster.local:8787"
            : "http://cohub-api-dev.cohub-dev.svc.cluster.local:8787",
      },
      {
        name: "PUBLIC_URL_PREFIX",
        value:
          config.env === "prod"
            ? `https://public.cohub.run/s/${input.spaceId}`
            : `https://public.cohub.run/dev/s/${input.spaceId}`,
      },
      { name: "SANDBOX_REPORT_TOKEN", value: reportToken },
      { name: "SANDBOX_RPC_TOKEN", value: rpcToken },
    ];
  }

  const created = await tryCreatePod(input.spaceId, pod, lease);
  if (!created.created) {
    if (input.mode === "ensure") return;
    throw new Error(`Sandbox Pod already exists during replacement: ${podName}`);
  }

  // Lease ownership and the DB generation fence must both hold before publishing credentials.
  await lease.assertOwned();
  const provisionedAt = new Date().toISOString();
  const published = await updateSpaceSandbox({
    spaceId: input.spaceId,
    expectedProvisioningGeneration: lease.generation,
    status: "provisioning",
    runtimeStatus: "starting",
    podName,
    desiredImage: toSandboxImageVersion(config.sandboxImage),
    meta: {
      ...provisioningMeta,
      desiredSpec,
      configuredSpec,
      ...(specEntitlementDowngraded ? { specEntitlementDowngraded: true, specEntitlementAllowedSpec: allowedSpec, specEntitlementCheckedAt: nowIso } : { specEntitlementDowngraded: false }),
      desiredSpecResources: desiredSpecConfig.resources,
      modMountSignature,
      modMounts: enabledMods.map((mod) => ({
        modSpaceId: mod.modSpaceId,
        mountSlug: mod.mountSlug,
        mountPath: mod.mountPath,
        name: mod.name ?? mod.modSpaceName,
      })),
      appliedSpec: desiredSpec,
      appliedSpecResources: desiredSpecConfig.resources,
      specApplying: false,
      specPendingRestart: false,
      lastProvisionedAt: provisionedAt,
    },
  });
  if (!published) throw new Error("Sandbox provisioning generation changed");
  await lease.assertOwned();

  triggerSandboxPublicNetworkReconcile(input.spaceId);
}

export const provisionSpaceSandbox = async (input: {
  spaceId: string;
  userUuid: string;
  ownerUserUuid?: string;
}) => {
  return reconcileSpaceSandbox({
    spaceId: input.spaceId,
    userUuid: input.userUuid,
    ownerUserUuid: input.ownerUserUuid,
    mode: "ensure",
    reason: "space_created",
  });
};

export const recoverSpaceSandbox = async (input: {
  spaceId: string;
  userUuid: string;
  ownerUserUuid?: string;
  reason?: string;
  source?: string;
  verify?: boolean;
}) => {
  const existing = await getSpaceSandboxBySpaceId(input.spaceId);
  if (existing?.provider === "local") {
    // Local sandboxes live on the user's machine; there is nothing to recover
    // server-side. Report current status without attempting a cloud recreate.
    return {
      ok: existing.status === "ready" || existing.status === "running",
      status: existing.status,
      verified: false,
      local: true,
    };
  }
  const cooldownKey = `sandbox:recover:cooldown:${input.spaceId}`;
  const lease = await acquireSandboxProvisioningLease(input.spaceId);
  if (!lease) {
    const sandbox = await getSpaceSandboxBySpaceId(input.spaceId);
    // Another recover is in flight — ok only if already dialable.
    return {
      ok: isSandboxDialable(sandbox),
      status: sandbox?.status ?? "provisioning",
      verified: false,
      recovering: true,
    };
  }

  try {
    const cooldown = await redisCommandClient.get(cooldownKey).catch(() => null);
    if (cooldown && input.source !== "manual") {
      const sandbox = await getSpaceSandboxBySpaceId(input.spaceId);
      const dialable = isSandboxDialable(sandbox);
      const awaitingReport = sandbox?.status === "provisioning"
        || isSandboxAwaitingEndpointReport(sandbox?.meta);
      // Dialable → ok. Still provisioning/report-pending → recovering (wait).
      // Otherwise hard throttle without a usable endpoint.
      return {
        ok: dialable,
        status: sandbox?.status ?? "provisioning",
        verified: false,
        throttled: true,
        recovering: !dialable && awaitingReport,
      };
    }
    await lease.assertOwned();
    await redisCommandClient.set(cooldownKey, "1", "PX", RECOVERY_COOLDOWN_MS).catch(() => undefined);

    await reconcileSpaceSandboxLocked({
      spaceId: input.spaceId,
      userUuid: input.userUuid,
      ownerUserUuid: input.ownerUserUuid,
      mode: "replace",
      reason: input.source === "manual" ? "manual_recreate" : "auto_recover",
    }, lease, { reason: input.reason ?? "recover", source: input.source ?? "auto" });

    const podName = `sandbox-${input.spaceId}`;
    const ready = await waitForSandboxPodReady(podName);
    if (!ready) throw new Error(`Timed out waiting for sandbox pod ready: ${podName}`);

    const checks = input.verify === false
      ? null
      : await smokeVerifySandboxPod(podName, sessionsNamespace);
    const latest = await getSpaceSandboxBySpaceId(input.spaceId);
    // Product choice: recover/resume resets the idle clock (full TTL from now),
    // rather than continuing prior idle progress. Keeps just-recovered sandboxes
    // from being immediately reaped off a stale lastActivityAt.
    await lease.assertOwned();
    const recoveredAt = new Date();
    const recovered = await updateSpaceSandbox({
      spaceId: input.spaceId,
      expectedProvisioningGeneration: lease.generation,
      status: "running",
      runtimeStatus: "healthy",
      lastActivityAt: recoveredAt,
      meta: {
        ...asMetaObject(latest?.meta),
        recoveryStatus: "ready",
        lastRecoveredAt: recoveredAt.toISOString(),
        lastRecoveryReason: input.reason ?? "recover",
        lastRecoveryChecks: checks,
        lastRecoveryError: null,
      },
    });
    if (!recovered) throw new Error("Sandbox provisioning generation changed");
    await lease.assertOwned();

    // Resume/recover is the common path that used to drop idle_check jobs.
    // Re-arm from now so a recovered sandbox always has a next check.
    const [space] = await db.select({ meta: spaces.meta }).from(spaces).where(eq(spaces.id, input.spaceId)).limit(1);
    void scheduleSandboxAutoDestroy({
      spaceId: input.spaceId,
      policy: resolveSpaceSandboxAutoDestroyPolicy(space?.meta),
      baseAt: recoveredAt,
    }).then((result) => {
      logger.info("[SandboxAutoDestroy] scheduled after recover", {
        spaceId: input.spaceId,
        ...result,
        dueAt: "dueAt" in result && result.dueAt instanceof Date ? result.dueAt.toISOString() : null,
      });
    }).catch((error) => {
      logger.error("[SandboxAutoDestroy] failed to schedule policy after recover", {
        spaceId: input.spaceId,
        error,
      });
    });

    return { ok: true as const, status: "running" as const, verified: input.verify !== false, checks };
  } catch (error) {
    await recordProvisioningFailure(input.spaceId, lease, error);
    throw error;
  } finally {
    await lease.release().catch((error) => logger.warn("[SandboxProvisioning] lock release failed", error));
  }
};

