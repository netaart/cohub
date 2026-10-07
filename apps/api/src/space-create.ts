import { createLogger } from "@cohub/infra/logging";
import type { SandboxSpecId } from "@cohub/sandbox-controller";
import { spaceChannels, spaceMembers, spaceMods, spaces } from "@cohub/db";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import type { AuthUser } from "./lib/middleware.js";
import {
  type ChannelModelSelection,
  validateChannelModelConfig,
} from "./lib/channel-model-config.js";
import { scheduleSandboxAutoDestroy } from "./sandbox-idle-scheduler.js";
import type { PreparedSpaceModInsert } from "./space-mods.js";
import { ensureSpaceSandbox, reconcileSpaceSandbox } from "./space-sandboxes.js";
import { setSpaceEnv } from "./space-sessions.js";
import { enqueueTask } from "./tasks.js";
import { ensurePersistedCurrentUserProfile } from "./user-profiles.js";

const logger = createLogger({ serviceName: "cohub-api" });

export type SpaceBootstrapSource =
  | { type: "blank" }
  | { type: "git_repo"; repoUrl: string; ref: string | null }
  | { type: "checkpoint"; checkpointId: string };

export type SpaceSandboxAutoDestroyPolicy =
  | { mode: "never" }
  | { mode: "idle"; ttlSeconds: number };

export type SpaceSandboxProvider = "cloud" | "local";

export type SpaceChannelBindingInsert = {
  channelId: string;
  config: Record<string, unknown> | null;
};

export type CreateOwnedSpaceInput = {
  user: AuthUser;
  name: string;
  slug: string | null;
  description?: string | null;
  bootstrapSource: SpaceBootstrapSource;
  sandbox: {
    provider: SpaceSandboxProvider;
    autoDestroy: SpaceSandboxAutoDestroyPolicy;
    spec: SandboxSpecId;
  };
  extraEnv?: Array<{ name: string; value: string }>;
  /** Prepared mod rows; spaceId is rewritten to the new space id. */
  mods?: PreparedSpaceModInsert[];
  /** Optional extra meta merged under space.meta (config/bootstrap/extraEnv still owned here). */
  meta?: Record<string, unknown>;
  channelBindings?: SpaceChannelBindingInsert[];
};

export type CreateOwnedSpaceResult = {
  space: typeof spaces.$inferSelect;
  insertedChannels: Array<typeof spaceChannels.$inferSelect>;
};

export type ProvisionCreatedSpaceInput = {
  user: AuthUser;
  space: typeof spaces.$inferSelect;
  bootstrapSource: SpaceBootstrapSource;
  extraEnv?: Array<{ name: string; value: string }>;
  sandbox: {
    provider: SpaceSandboxProvider;
    autoDestroy: SpaceSandboxAutoDestroyPolicy;
  };
  gitToken?: string | null;
  /**
   * - throw: POST create — bootstrap enqueue failure is fatal
   * - soft: ensure home — space remains usable as an entry target
   */
  onBootstrapFailure?: "throw" | "soft";
};

export type ProvisionCreatedSpaceResult = {
  space: typeof spaces.$inferSelect;
  taskRunId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getSpaceProvisionParams(user: AuthUser, space: typeof spaces.$inferSelect) {
  return {
    spaceId: space.id,
    userUuid: user.uuid,
    ownerUserUuid: space.userUuid,
  };
}

async function markBootstrapFailed(
  space: typeof spaces.$inferSelect,
  bootstrapSource: SpaceBootstrapSource,
  errorMessage: string,
): Promise<typeof spaces.$inferSelect> {
  const [updated] = await db
    .update(spaces)
    .set({
      meta: {
        ...((space.meta as Record<string, unknown> | null) ?? {}),
        bootstrap: {
          status: "failed",
          stage: null,
          taskRunId: null,
          errorMessage,
          source: bootstrapSource,
          startedAt: null,
          finishedAt: new Date().toISOString(),
        },
      },
      updatedAt: new Date(),
      lastActivityAt: new Date(),
    })
    .where(eq(spaces.id, space.id))
    .returning();
  return updated ?? space;
}

async function insertOwnedSpaceRecord(
  input: CreateOwnedSpaceInput,
): Promise<CreateOwnedSpaceResult> {
  const spaceId = crypto.randomUUID();
  const extraEnv = input.extraEnv ?? [];
  const mods = (input.mods ?? []).map((mod) => ({ ...mod, spaceId }));
  const channelBindings = input.channelBindings ?? [];
  const baseMeta = isRecord(input.meta) ? input.meta : {};
  const baseConfig = isRecord(baseMeta.config) ? baseMeta.config : {};

  return db.transaction(async (tx) => {
    const [createdSpace] = await tx
      .insert(spaces)
      .values({
        id: spaceId,
        userUuid: input.user.uuid,
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        baseCheckpointId:
          input.bootstrapSource.type === "checkpoint"
            ? input.bootstrapSource.checkpointId
            : null,
        headCheckpointId: null,
        lastActivityAt: new Date(),
        meta: {
          ...baseMeta,
          config: {
            ...baseConfig,
            sandbox: {
              provider: input.sandbox.provider,
              autoDestroy: input.sandbox.autoDestroy,
              spec: input.sandbox.spec,
            },
          },
          extraEnv,
          bootstrap: {
            status: "pending",
            stage: null,
            taskRunId: null,
            errorMessage: null,
            source: input.bootstrapSource,
            startedAt: null,
            finishedAt: null,
          },
        },
      })
      .returning();
    if (!createdSpace) throw new Error("failed to create space");

    await tx.insert(spaceMembers).values({
      spaceId: createdSpace.id,
      userId: input.user.uuid,
      role: "host",
      createdBy: input.user.uuid,
      updatedBy: input.user.uuid,
    });

    if (mods.length > 0) {
      await tx.insert(spaceMods).values(mods);
    }

    for (const binding of channelBindings) {
      const model =
        (binding.config as { model?: ChannelModelSelection | null } | null)?.model ?? null;
      if (!(await validateChannelModelConfig(tx as unknown as typeof db, createdSpace.id, model))) {
        throw new Error("model not found");
      }
    }

    const insertedChannels =
      channelBindings.length > 0
        ? await tx
            .insert(spaceChannels)
            .values(
              channelBindings.map((binding) => ({
                spaceId: createdSpace.id,
                channelId: binding.channelId,
                config: binding.config,
              })),
            )
            .returning()
        : [];

    return { space: createdSpace, insertedChannels };
  });
}

/**
 * Establish the owner's durable profile, then atomically insert the Space record.
 * All owned-space creation paths pass through here, including Home ensure.
 */
export async function createOwnedSpace(
  input: CreateOwnedSpaceInput,
): Promise<CreateOwnedSpaceResult> {
  await ensurePersistedCurrentUserProfile(input.user);
  return insertOwnedSpaceRecord(input);
}

/**
 * Post-insert side effects: env cache, sandbox, bootstrap task.
 * Channel gateway binding stays in the route (POST-only concern).
 */
export async function provisionCreatedSpace(
  input: ProvisionCreatedSpaceInput,
): Promise<ProvisionCreatedSpaceResult> {
  const {
    user,
    bootstrapSource,
    sandbox,
    gitToken = null,
    onBootstrapFailure = "throw",
  } = input;
  let space = input.space;
  const extraEnv = input.extraEnv ?? [];

  const taskData: Record<string, unknown> = { source: bootstrapSource };
  // TODO: gitToken is stored in taskData (BullMQ Redis + DB task_runs).
  // For long-term security, encrypt it or use a temporary token reference.
  if (gitToken) taskData.gitToken = gitToken;

  try {
    await setSpaceEnv(space.id, extraEnv);

    if (sandbox.provider === "local") {
      try {
        await ensureSpaceSandbox({
          spaceId: space.id,
          provider: "local",
          status: "stopped",
          runtimeStatus: "unknown",
          stopReason: "disconnected",
          stoppedAt: new Date(),
        });
      } catch (error) {
        logger.error("[LocalSandbox] failed to register local sandbox after space creation", {
          spaceId: space.id,
          error,
        });
        throw new Error("failed to register local sandbox");
      }
    } else {
      void scheduleSandboxAutoDestroy({
        spaceId: space.id,
        policy: sandbox.autoDestroy,
        baseAt: space.createdAt ? new Date(space.createdAt) : new Date(),
      }).catch((error) =>
        logger.error("[SandboxAutoDestroy] failed to schedule policy after space creation", {
          spaceId: space.id,
          error,
        }),
      );
      void reconcileSpaceSandbox({
        ...getSpaceProvisionParams(user, space),
        mode: "ensure",
        reason: "space_created",
      }).catch((error) =>
        logger.error("[SandboxPublicNetwork] failed to reconcile after space creation", {
          spaceId: space.id,
          error,
        }),
      );
    }

    const job = await enqueueTask({
      type: "create_space",
      spaceId: space.id,
      userId: user.uuid,
      data: taskData,
    });
    const taskRunId = job.taskRunId;
    if (!taskRunId) throw new Error("failed to allocate create_space task id");

    const [spaceWithJob] = await db
      .update(spaces)
      .set({
        meta: {
          ...((space.meta as Record<string, unknown> | null) ?? {}),
          bootstrap: {
            status: "pending",
            stage: null,
            taskRunId,
            errorMessage: null,
            source: bootstrapSource,
            startedAt: null,
            finishedAt: null,
          },
        },
        updatedAt: new Date(),
        lastActivityAt: new Date(),
      })
      .where(eq(spaces.id, space.id))
      .returning();

    return { space: spaceWithJob ?? space, taskRunId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    space = await markBootstrapFailed(space, bootstrapSource, message);
    if (onBootstrapFailure === "soft") {
      logger.error("[SpaceCreate] failed to enqueue bootstrap (soft)", {
        spaceId: space.id,
        error,
      });
      return { space, taskRunId: null };
    }
    throw error;
  }
}
