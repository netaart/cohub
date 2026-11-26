import { DEFAULT_SANDBOX_SPEC_ID, getSandboxSpecRank } from "@cohub/sandbox-controller";
import { createLogger } from "@cohub/infra/logging";
import { Hono, type Context } from "hono";
import { getDefaultSpaceModsForEnv } from "@cohub/protocol";
import {
  HOME_SPACE_SLUG,
  parseSpaceSlug,
  validatePublicIdentifierAssignment,
} from "@cohub/protocol/public-identifiers";
import { db } from "../../db/index.js";
import { getPostgresErrorConstraint, isPostgresUniqueViolation } from "../../db/postgres-error.js";
import { spaces, spaceChannels, spaceSandboxes, userChannels, checkpoints } from "@cohub/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { isSpaceLikeStickerUrl } from "../../public-asset-storage.js";
import { useAuth, getOptionalAuth, requireValidId, authzDenied, normalizePublicAvatarUrl } from "../../lib/middleware.js";
import { getAllowedSandboxSpecId } from "../../space-sandbox-preferences.js";
import { config } from "../../config.js";
import {
  createOwnedSpace,
  provisionCreatedSpace,
  type ProvisionCreatedSpaceResult,
  type SpaceBootstrapSource,
} from "../../space-create.js";
import { normalizeSpaceBootstrapSource } from "../../space-bootstrap-source.js";
import { normalizeSpaceEnv } from "../../space-sessions.js";
import { syncSpaceChannelConfigCache, bindSpaceChannelsToGateway } from "../../channels.js";
import { asAccountIdentity, hasPermission } from "../../permissions.js";
import { LogtoUserRequiredError } from "../../user-profiles.js";
import { publicSpacePath, recordSpaceSlugChange, redirectTarget, resolvePublicSpace } from "../../slug-history.js";
import type { AuthUser } from "../../lib/middleware.js";
import { dispatchSpaceListChanged } from "../../space-list-events.js";
import { decodeSpaceListCursor, isSpaceListFilter, listLegacySpaces, listMemberSpaces, listRecentSpaces, parseSpaceVisits, type SpaceListRow } from "../../space-list.js";
import { prepareSpaceModInserts, spaceModErrorResponse, type CreateSpaceModInput } from "../../space-mods.js";
import { parseChannelConfigPatch } from "../../lib/channel-model-config.js";
import { applyRequestSourceToMeta, getRequestSource } from "../../lib/request-source.js";
import { type SpaceRow, buildMinimalSpaceResponse, buildSpaceResponse, serializeSpaceForResponse } from "./space-response.js";
import { DEFAULT_SPACE_SANDBOX_AUTO_DESTROY, type SpaceConfigInput, createSandboxSpecRequiredResponse, isRecord, normalizeSpaceConfigInput, validateSpaceEnvForResponse } from "./space-config.js";

const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();
const MAX_SPACE_DESCRIPTION_LENGTH = 10_000;
const HOME_SPACE_NAME = "Home";

const normalizeSpaceSlug = (value: unknown): { slug: string | null; error?: string } => {
  if (value === undefined || value === null) return { slug: null };
  if (typeof value !== "string") return { slug: null, error: "slug must be a string or null" };
  const rawSlug = value.trim();
  if (!rawSlug) return { slug: null };
  const slug = parseSpaceSlug(rawSlug);
  if (!slug) {
    return {
      slug: null,
      error: "slug must be 1-80 characters, lowercase letters, numbers, hyphens, or underscores, and cannot start or end with a separator",
    };
  }
  return { slug };
};

const reservedSpaceSlugResponse = (c: Context) => c.json({
  code: "public_identifier_reserved",
  field: "slug",
  message: "This Space slug is reserved.",
}, 400);

const uniqueViolationConstraint = (error: unknown): string | null =>
  isPostgresUniqueViolation(error) ? getPostgresErrorConstraint(error) : null;

async function findOwnedHomeSpace(userUuid: string): Promise<SpaceRow | null> {
  const [ownedHome] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.userUuid, userUuid), eq(spaces.slug, HOME_SPACE_SLUG)))
    .limit(1);
  return ownedHome ?? null;
}

async function findLandingSpace(userUuid: string): Promise<SpaceRow | null> {
  const home = await findOwnedHomeSpace(userUuid);
  if (home) return home;
  const [recent] = await db
    .select()
    .from(spaces)
    .where(eq(spaces.userUuid, userUuid))
    .orderBy(sql`${spaces.lastActivityAt} desc nulls last`, sql`${spaces.createdAt} desc nulls last`)
    .limit(1);
  return recent ?? null;
}

type PreparedHomeMods = Awaited<ReturnType<typeof prepareSpaceModInserts>>;

type HomeEnsureProvenance = {
  source: "default_ensure" | "home_ensure";
  appId?: string | null;
};

const homeEnsureMeta = (c: Context, provenance: HomeEnsureProvenance): Record<string, unknown> => {
  const via = getRequestSource(c)?.via;
  const meta = {
    createdSource: provenance.source,
    ...(via ? { createdVia: via } : {}),
    ...(provenance.appId ? { createdByAppId: provenance.appId } : {}),
  };
  return applyRequestSourceToMeta(c, meta) ?? meta;
};

const HOME_BOOTSTRAP: SpaceBootstrapSource = { type: "blank" };

/**
 * Home bootstrap source: fork from `HOME_BOOTSTRAP_CHECKPOINT_ID` when set,
 * otherwise create a blank workspace.
 */
function resolveHomeBootstrap(): SpaceBootstrapSource {
  const checkpointId = config.homeBootstrapCheckpointId;
  return checkpointId ? { type: "checkpoint", checkpointId } : HOME_BOOTSTRAP;
}

async function insertHomeSpaceRecord(
  user: AuthUser,
  preparedModValues: PreparedHomeMods,
  bootstrapSource: SpaceBootstrapSource,
  meta: Record<string, unknown>,
): Promise<SpaceRow> {
  const { space } = await createOwnedSpace({
    user,
    name: HOME_SPACE_NAME,
    slug: HOME_SPACE_SLUG,
    bootstrapSource,
    sandbox: {
      provider: "cloud",
      autoDestroy: DEFAULT_SPACE_SANDBOX_AUTO_DESTROY,
      spec: DEFAULT_SANDBOX_SPEC_ID,
    },
    extraEnv: [],
    mods: preparedModValues,
    meta,
  });
  return space;
}

const isHomeUniqueConflict = (error: unknown) => {
  const constraint = uniqueViolationConstraint(error);
  return Boolean(constraint?.includes("user_slug") || constraint?.includes("user_name"));
};

type EnsuredHome = { space: SpaceRow; created: boolean };

/** Returns null when another owned Space already uses the Home name. */
async function createHomeSpace(
  c: Context,
  user: AuthUser,
  provenance: HomeEnsureProvenance,
): Promise<EnsuredHome | null> {
  const bootstrapSource = resolveHomeBootstrap();
  const meta = homeEnsureMeta(c, provenance);
  const createMods = getDefaultSpaceModsForEnv(config.env);
  // spaceId is remapped at insert; placeholder only for prepare validation.
  const preparedModValues = await prepareSpaceModInserts({
    actor: user,
    spaceId: crypto.randomUUID(),
    mods: createMods,
    existing: [],
  }).catch((error) => {
    const response = spaceModErrorResponse(error);
    logger.warn("[HomeSpace] failed to prepare home mods; creating without mods", {
      userUuid: user.uuid,
      message: response?.message ?? (error instanceof Error ? error.message : String(error)),
      status: response?.status,
    });
    return [] as PreparedHomeMods;
  });

  const existingHome = async () => {
    const space = await findOwnedHomeSpace(user.uuid);
    if (!space) logger.warn("[HomeSpace] home name is taken by another Space", { userUuid: user.uuid, source: provenance.source });
    return space ? { space, created: false } : null;
  };

  let space: SpaceRow;
  try {
    space = await insertHomeSpaceRecord(user, preparedModValues, bootstrapSource, meta);
  } catch (error) {
    if (isHomeUniqueConflict(error)) return existingHome();
    const modResponse = spaceModErrorResponse(error);
    if (!modResponse) throw error;
    // Retry once without mods.
    logger.warn("[HomeSpace] home mod insert failed; retrying without mods", {
      userUuid: user.uuid,
      message: modResponse.message,
    });
    try {
      space = await insertHomeSpaceRecord(user, [], bootstrapSource, meta);
    } catch (retryError) {
      if (isHomeUniqueConflict(retryError)) return existingHome();
      throw retryError;
    }
  }

  const provisioned = await provisionCreatedSpace({
    user,
    space,
    bootstrapSource,
    extraEnv: [],
    sandbox: {
      provider: "cloud",
      autoDestroy: DEFAULT_SPACE_SANDBOX_AUTO_DESTROY,
    },
    onBootstrapFailure: "soft",
  });
  await dispatchSpaceListChanged(provisioned.space.id);
  return { space: provisioned.space, created: true };
}

async function ensureHomeSpace(
  c: Context,
  user: AuthUser,
  provenance: HomeEnsureProvenance,
): Promise<EnsuredHome | Response> {
  if (!(await hasPermission(user, "space.create", { spaceId: "" }))) return authzDenied(c);
  let ensured: EnsuredHome | null;
  try {
    ensured = await createHomeSpace(c, user, provenance);
  } catch (error) {
    if (error instanceof LogtoUserRequiredError) return c.json({ message: error.message }, 403);
    throw error;
  }
  return ensured ?? c.json({
    code: "home_space_name_taken",
    message: `Another Space is named ${HOME_SPACE_NAME}. Set its slug to ${HOME_SPACE_SLUG} to make it your Home Space.`,
  }, 409);
}

async function toSpaceListItems(rows: SpaceListRow[], viewerUuid: string, options: { personalActivity: boolean }) {
  const sandboxRows = rows.length ? await db.select({ spaceId: spaceSandboxes.spaceId, status: spaceSandboxes.status }).from(spaceSandboxes).where(inArray(spaceSandboxes.spaceId, rows.map((r) => r.id))) : [];
  const sandboxBySpace = new Map(sandboxRows.map((r) => [r.spaceId, r.status]));
  return rows.map((row) => ({
    id: row.id, userUuid: row.user_uuid, name: row.name, slug: row.slug, description: row.description,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    title: null, status: null, meta: null,
    lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at).toISOString() : null,
    publicProfile: { avatarUrl: normalizePublicAvatarUrl(row.avatar_url) },
    ownerProfile: { userUuid: row.user_uuid, username: row.owner_username, displayName: row.owner_display_name, avatarUrl: normalizePublicAvatarUrl(row.owner_avatar_url) },
    sandboxStatus: sandboxBySpace.get(row.id) ?? null, isPinned: row.is_pinned, isArchived: row.is_archived,
    relation: row.user_uuid === viewerUuid ? "owner" : "member",
    joinedAt: new Date(row.joined_at).toISOString(),
    ...(options.personalActivity ? { personalActivityAt: new Date(row.sort_at).toISOString() } : {}),
  }));
}

router.get("/", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  if (!(await hasPermission(user, "user.space.list", { spaceId: "" }))) return authzDenied(c);
  const identity = asAccountIdentity(user);
  if (!identity) return authzDenied(c);

  // Legacy clients send a bare request and expect an array.
  if (!new URL(c.req.url).search) {
    c.header("Deprecation", "true");
    return c.json(await toSpaceListItems(await listLegacySpaces(identity.uuid), identity.uuid, { personalActivity: false }));
  }

  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 100);
  const filter = c.req.query("filter") ?? "recent";
  if (!isSpaceListFilter(filter)) return c.json({ message: "invalid filter" }, 400);
  const query = (c.req.query("q") ?? "").trim().slice(0, 120);
  const exactName = c.req.query("name")?.trim().slice(0, 255) ?? "";
  const cursor = decodeSpaceListCursor(c.req.query("cursor"));
  if (cursor === false) return c.json({ message: "invalid cursor" }, 400);

  const recent = filter === "recent" && !query && !exactName;
  const { rows, nextCursor } = recent
    ? {
        rows: await listRecentSpaces(identity.uuid, parseSpaceVisits(c.req.queries("recentSpaceId") ?? [], c.req.queries("recentSpaceAt") ?? []), limit),
        nextCursor: null,
      }
    : await listMemberSpaces({ userUuid: identity.uuid, filter: filter === "recent" ? "all" : filter, query, exactName, cursor, limit });

  const items = await toSpaceListItems(rows, identity.uuid, { personalActivity: recent });
  return c.json({ items, pageInfo: { hasMore: nextCursor !== null, nextCursor } });
});

router.get("/default", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  if (!(await hasPermission(user, "user.space.list", { spaceId: "" }))) return authzDenied(c);
  const identity = asAccountIdentity(user);
  if (!identity) return authzDenied(c);

  const landing = await findLandingSpace(identity.uuid);
  if (landing) return c.json({ space: await buildSpaceResponse(c, landing, user) });

  const ensured = await ensureHomeSpace(c, user, { source: "default_ensure" });
  if (ensured instanceof Response) return ensured;
  return c.json({ space: await buildSpaceResponse(c, ensured.space, user) });
});

router.post("/", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  if (!(await hasPermission(user, "space.create", { spaceId: "" }))) return authzDenied(c);

  const body = (await c.req
    .json<{
      name?: string;
      slug?: string | null;
      description?: string | null;
      source?: string;
      cwd?: string;
      protocol?: "pi" | "acp" | "internal";
      meta?: Record<string, unknown>;
      extraEnv?: Array<{ name: string; value: string }>;
      channelBindings?: Array<{ channelId: string; config?: Record<string, unknown> | null }>;
      mods?: CreateSpaceModInput[];
      bootstrapSource?:
        | { type: "blank" }
        | { type: "git_repo"; repoUrl?: string; ref?: string | null }
        | { type: "checkpoint"; checkpointId?: string };
    gitHubToken?: string;
    }>()
    .catch(() => ({}))) as {
    name?: string;
    slug?: string | null;
    description?: string | null;
    source?: string;
    cwd?: string;
    protocol?: "pi" | "acp" | "internal";
    meta?: Record<string, unknown>;
    extraEnv?: Array<{ name: string; value: string }>;
    channelBindings?: Array<{ channelId: string; config?: Record<string, unknown> | null }>;
    mods?: CreateSpaceModInput[];
    bootstrapSource?:
      | { type: "blank" }
      | { type: "git_repo"; repoUrl?: string; ref?: string | null }
      | { type: "checkpoint"; checkpointId?: string };
    gitHubToken?: string;
    config?: SpaceConfigInput;
  };

  const name = body.name?.trim();
  if (!name) return c.json({ message: "name is required" }, 400);

  const { slug, error: slugError } = normalizeSpaceSlug(body.slug);
  if (slugError) return c.json({ message: slugError }, 400);
  if (slug && validatePublicIdentifierAssignment("spaceSlug", slug).reason === "reserved") {
    return reservedSpaceSlugResponse(c);
  }

  const existingSpace = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.userUuid, user.uuid), eq(spaces.name, name)))
    .limit(1);
  if (existingSpace.length > 0) return c.json({ message: "space already exists" }, 409);

  const normalizedExtraEnv = normalizeSpaceEnv(body.extraEnv);
  const envValidationError = validateSpaceEnvForResponse(normalizedExtraEnv);
  if (envValidationError) return c.json(envValidationError, 400);

  let normalizedConfig: SpaceConfigInput;
  try {
    normalizedConfig = normalizeSpaceConfigInput(body.config ?? null);
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "invalid space config" }, 400);
  }
  const requestedSpec = normalizedConfig.sandbox?.spec ?? DEFAULT_SANDBOX_SPEC_ID;
  const allowedSpec = await getAllowedSandboxSpecId(user.uuid);
  if (getSandboxSpecRank(requestedSpec) > getSandboxSpecRank(allowedSpec)) {
    return createSandboxSpecRequiredResponse(c, requestedSpec);
  }

  let normalizedChannelBindings: Array<{ channelId: string; config: ReturnType<typeof parseChannelConfigPatch> }> = [];
  try {
    normalizedChannelBindings = Array.isArray(body.channelBindings)
      ? body.channelBindings
          .filter((binding) => binding?.channelId && requireValidId(binding.channelId))
          .map((binding) => ({ channelId: binding.channelId, config: parseChannelConfigPatch(binding.config ?? null) }))
      : [];
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "invalid channel config" }, 400);
  }

  if (normalizedChannelBindings.length > 0) {
    const ids = normalizedChannelBindings.map((binding) => binding.channelId);
    const channels = await db
      .select({ id: userChannels.id })
      .from(userChannels)
      .where(and(eq(userChannels.userUuid, user.uuid), inArray(userChannels.id, ids)));
    if (channels.length !== ids.length) return c.json({ message: "one or more channels are invalid" }, 400);
  }

  const occupiedChannels = normalizedChannelBindings.length
    ? await db
        .select({ channelId: spaceChannels.channelId })
        .from(spaceChannels)
        .where(inArray(spaceChannels.channelId, normalizedChannelBindings.map((binding) => binding.channelId)))
    : [];
  if (occupiedChannels.length > 0) {
    return c.json({ message: "channel binding already exists for this channel" }, 409);
  }

  let normalizedBootstrapSource: SpaceBootstrapSource;
  const gitToken = body.gitHubToken?.trim() || c.req.header("X-Git-Token")?.trim() || null;
  try {
    normalizedBootstrapSource = normalizeSpaceBootstrapSource(
      body.bootstrapSource,
      requireValidId,
    );
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message.toLowerCase().replace(/\.$/, "") : "invalid bootstrap source" }, 400);
  }

  if (normalizedBootstrapSource.type === "checkpoint") {
    const [checkpoint] = await db.select().from(checkpoints).where(eq(checkpoints.id, normalizedBootstrapSource.checkpointId)).limit(1);
    if (!checkpoint) return c.json({ message: "checkpoint not found" }, 404);
    if (!(await hasPermission(user, "checkpoint.view", { spaceId: checkpoint.spaceId }))) return authzDenied(c);
  }

  const createMods = Array.isArray(body.mods) ? body.mods : getDefaultSpaceModsForEnv(config.env);
  // spaceId is remapped inside createOwnedSpace; placeholder for prepare only.
  const preparedModValues = await prepareSpaceModInserts({
    actor: user,
    spaceId: crypto.randomUUID(),
    mods: createMods,
    existing: [],
  }).catch((error) => {
    const response = spaceModErrorResponse(error);
    if (response) return response;
    throw error;
  });
  if (!Array.isArray(preparedModValues)) return c.json({ message: preparedModValues.message }, preparedModValues.status);

  const sandboxProvider = normalizedConfig.sandbox?.provider ?? "cloud";
  const sandboxAutoDestroy = normalizedConfig.sandbox?.autoDestroy ?? DEFAULT_SPACE_SANDBOX_AUTO_DESTROY;

  let space: typeof spaces.$inferSelect | undefined;
  let insertedChannels: Array<typeof spaceChannels.$inferSelect> = [];
  try {
    const result = await createOwnedSpace({
      user,
      name,
      slug,
      description: body.description ?? null,
      bootstrapSource: normalizedBootstrapSource,
      sandbox: {
        provider: sandboxProvider,
        autoDestroy: sandboxAutoDestroy,
        spec: normalizedConfig.sandbox?.spec ?? null,
        image: normalizedConfig.sandbox?.image ?? null,
      },
      extraEnv: normalizedExtraEnv,
      mods: preparedModValues,
      meta: applyRequestSourceToMeta(c, body.meta ?? {}) ?? {},
      channelBindings: normalizedChannelBindings.map((binding) => ({
        channelId: binding.channelId,
        config: (binding.config as Record<string, unknown> | null) ?? null,
      })),
    });
    space = result.space;
    insertedChannels = result.insertedChannels;
  } catch (error) {
    if (error instanceof LogtoUserRequiredError) {
      return c.json({ message: error.message }, 403);
    }
    const constraint = uniqueViolationConstraint(error);
    if (constraint?.includes("user_slug")) return c.json({ message: "space slug already exists" }, 409);
    const modResponse = spaceModErrorResponse(error);
    if (modResponse) return c.json({ message: modResponse.message }, modResponse.status);
    if (error instanceof Error && error.message === "model not found") return c.json({ message: "model not found" }, 400);
    throw error;
  }

  if (!space) return c.json({ message: "failed to create space" }, 500);
  await dispatchSpaceListChanged(space.id);

  if (insertedChannels.length > 0) {
    await Promise.all(
      insertedChannels.map((channel) =>
        syncSpaceChannelConfigCache({
          spaceChannelId: channel.id,
          config: (channel.config as Record<string, unknown> | null) ?? null,
        }),
      ),
    );
    // Push channel config to gateway so it starts long-polling
    void bindSpaceChannelsToGateway(space.id).catch((error) => logger.error("[SpaceChannels] failed to bind channels after space creation", { spaceId: space.id, error }));
  }

  let provisioned: ProvisionCreatedSpaceResult;
  try {
    provisioned = await provisionCreatedSpace({
      user,
      space,
      bootstrapSource: normalizedBootstrapSource,
      extraEnv: normalizedExtraEnv,
      sandbox: {
        provider: sandboxProvider,
        autoDestroy: sandboxAutoDestroy,
      },
      gitToken,
      onBootstrapFailure: "throw",
    });
  } catch (error) {
    const message =
      error instanceof Error && error.message === "failed to register local sandbox"
        ? error.message
        : "failed to create bootstrap job";
    // Space row is already committed — return it so the caller can close with
    // a created-but-not-provisioned result instead of 409-ing on the same name.
    return c.json({ message, space: { id: space.id, name: space.name } }, 500);
  }

  if (!provisioned.taskRunId) {
    return c.json({ message: "failed to create bootstrap job", space: { id: space.id, name: space.name } }, 500);
  }

  return c.json({
    space: await buildSpaceResponse(c, provisioned.space, user),
    taskRunId: provisioned.taskRunId,
  });
});

router.get("/:id", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);

  if (await hasPermission(user, "space.view", { spaceId })) {
    return c.json(await buildSpaceResponse(c, space, user));
  }

  // Fallback: only session-level access — keep the response intentionally tiny.
  // Access is omitted here because effective permissions depend on a concrete session policy.
  return c.json(await buildMinimalSpaceResponse(space));
});

router.get("/by-slug/:username/:slug", async (c) => {
  const user = getOptionalAuth(c);
  const username = c.req.param("username");
  const rawSlug = c.req.param("slug");
  const { slug, error: slugError } = normalizeSpaceSlug(rawSlug);
  if (slugError || !slug) return c.json({ message: "space not found" }, 404);

  const resolved = await resolvePublicSpace(username, slug);
  if (!resolved) return c.json({ message: "space not found" }, 404);
  const { space } = resolved;
  const redirect = resolved.redirected
    ? { redirectTo: redirectTarget(c.req.url, publicSpacePath(resolved.owner.username, space.slug)) }
    : {};

  if (await hasPermission(user, "space.view", { spaceId: space.id })) {
    return c.json({ ...(await buildSpaceResponse(c, space, user)), ...redirect });
  }

  return c.json({ ...(await buildMinimalSpaceResponse(space)), ...redirect });
});

export const meSpacesRouter = new Hono();

meSpacesRouter.get("/spaces/by-slug/:slug", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  if (!(await hasPermission(user, "user.space.list", { spaceId: "" }))) return authzDenied(c);
  const identity = asAccountIdentity(user);
  if (!identity) return authzDenied(c);

  const slug = parseSpaceSlug(c.req.param("slug"));
  if (!slug) return c.json({ message: "space not found" }, 404);

  const [space] = await db
    .select()
    .from(spaces)
    .where(and(eq(spaces.userUuid, identity.uuid), eq(spaces.slug, slug)))
    .limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);
  return c.json(await buildSpaceResponse(c, space, user));
});

meSpacesRouter.post("/spaces/home", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  if (!(await hasPermission(user, "user.space.list", { spaceId: "" }))) return authzDenied(c);
  const identity = asAccountIdentity(user);
  if (!identity) return authzDenied(c);

  const home = await findOwnedHomeSpace(identity.uuid);
  if (home) return c.json(await buildSpaceResponse(c, home, user));

  const body = await c.req.json<{ appId?: unknown }>().catch(() => null);
  const appId = typeof body?.appId === "string" && requireValidId(body.appId) ? body.appId : null;
  const ensured = await ensureHomeSpace(c, user, { source: "home_ensure", appId });
  if (ensured instanceof Response) return ensured;
  return c.json(await buildSpaceResponse(c, ensured.space, user), ensured.created ? 201 : 200);
});

router.patch("/:id", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  const body = await c.req.json<{ name?: string; slug?: string | null }>().catch(() => null);
  if (!body) return c.json({ message: "invalid body" }, 400);

  const updates: Partial<Pick<typeof spaces.$inferSelect, "name" | "slug">> = {};

  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return c.json({ message: "name is required" }, 400);
    if (name !== space.name) {
      const duplicate = await db
        .select({ id: spaces.id })
        .from(spaces)
        .where(and(eq(spaces.userUuid, space.userUuid), eq(spaces.name, name)))
        .limit(1);
      if (duplicate.length > 0) return c.json({ message: "space name already exists" }, 409);
      updates.name = name;
    }
  }

  if (body.slug !== undefined) {
    const { slug, error: slugError } = normalizeSpaceSlug(body.slug);
    if (slugError) return c.json({ message: slugError }, 400);
    if (!slug && space.slug) return c.json({ message: "space slug cannot be cleared once set" }, 400);
    if (
      slug &&
      slug !== space.slug &&
      validatePublicIdentifierAssignment("spaceSlug", slug).reason === "reserved"
    ) {
      return reservedSpaceSlugResponse(c);
    }
    if (slug !== space.slug) updates.slug = slug;
  }

  if (updates.name === undefined && updates.slug === undefined) {
    return c.json({ space: await serializeSpaceForResponse(space, user) });
  }

  try {
    const applyUpdates = (executor: Pick<typeof db, "update">) => executor
      .update(spaces)
      .set({ ...updates, updatedAt: new Date(), lastActivityAt: new Date() })
      .where(eq(spaces.id, spaceId))
      .returning();
    const [updated] = updates.slug
      ? await db.transaction(async (tx) => {
          // Record the slug this update actually replaces, so concurrent renames each leave history.
          const [locked] = await tx.select({ slug: spaces.slug }).from(spaces).where(eq(spaces.id, spaceId)).for("update");
          if (locked?.slug && locked.slug !== updates.slug) await recordSpaceSlugChange(tx, space, locked.slug);
          return await applyUpdates(tx);
        })
      : await applyUpdates(db);

    const result = updated ?? space;
    await dispatchSpaceListChanged(spaceId);
    return c.json({ space: await serializeSpaceForResponse(result, user) });
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (constraint?.includes("user_slug")) return c.json({ message: "space slug already exists" }, 409);
    throw error;
  }
});

router.patch("/:id/profile", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "space.edit", { spaceId }))) return authzDenied(c);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || !isRecord(body)) return c.json({ message: "invalid body" }, 400);

  const changes: { description?: string | null } = {};
  if ("description" in body) {
    if (body.description !== null && typeof body.description !== "string") {
      return c.json({ message: "description must be a string or null" }, 400);
    }
    if (typeof body.description === "string" && body.description.length > MAX_SPACE_DESCRIPTION_LENGTH) {
      return c.json({ message: `description must be at most ${MAX_SPACE_DESCRIPTION_LENGTH} characters` }, 400);
    }
    changes.description = body.description;
  }

  const profilePatch: Record<string, unknown> = {};
  if ("avatarUrl" in body) {
    if (body.avatarUrl !== null && typeof body.avatarUrl !== "string") {
      return c.json({ message: "avatarUrl must be a URL string or null" }, 400);
    }
    const avatarUrl = body.avatarUrl === null ? null : normalizePublicAvatarUrl(body.avatarUrl);
    if (body.avatarUrl !== null && !avatarUrl) {
      return c.json({ message: "avatarUrl must be a valid http(s) URL under 2048 characters" }, 400);
    }
    profilePatch.avatarUrl = avatarUrl;
  }
  if ("likeSticker" in body) {
    const sticker = body.likeSticker;
    if (sticker === null) {
      profilePatch.likeSticker = null;
    } else if (isRecord(sticker) && typeof sticker.url === "string" && isSpaceLikeStickerUrl(sticker.url, space.id)) {
      profilePatch.likeSticker = { url: sticker.url };
    } else {
      return c.json({ message: "likeSticker must be null or { url } of an uploaded like sticker" }, 400);
    }
  }

  if ("fundingEnabled" in body) {
    if (typeof body.fundingEnabled !== "boolean") return c.json({ message: "fundingEnabled must be a boolean" }, 400);
    profilePatch.fundingEnabled = body.fundingEnabled;
  }

  const meta = sql`case when jsonb_typeof(${spaces.meta}) = 'object' then ${spaces.meta} else '{}'::jsonb end`;
  const profile = sql`case when jsonb_typeof(${spaces.meta}->'publicProfile') = 'object' then ${spaces.meta}->'publicProfile' else '{}'::jsonb end`;
  const [updated] = await db
    .update(spaces)
    .set({
      ...changes,
      meta: sql`jsonb_set(${meta}, '{publicProfile}', (${profile} - 'pictureUrl') || ${JSON.stringify(profilePatch)}::jsonb)`,
      updatedAt: new Date(),
      lastActivityAt: new Date(),
    })
    .where(eq(spaces.id, spaceId))
    .returning();

  const result = updated ?? space;
  await dispatchSpaceListChanged(spaceId);
  return c.json({ space: await serializeSpaceForResponse(result, user) });
});

export default router;
