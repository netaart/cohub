import { sql } from "drizzle-orm";
import {
  pgSchema,
  uuid,
  varchar,
  text,
  timestamp,
  index,
  integer,
  bigint,
  numeric,
  boolean,
  jsonb,
  uniqueIndex,
  unique,
  check,
  doublePrecision,
} from "drizzle-orm/pg-core";
import type { ContentBlock } from "@cohub/protocol/core";
import type { TaskPayload } from "@cohub/protocol/task";
import type {
  SessionTurnExecutionKind,
  SessionTurnIntent,
  SessionTurnIntermediateIndex,
  SessionTurnIntermediateSummary,
  SessionTurnStatus,
  SessionTurnSummary,
} from "@cohub/protocol/model";

export type SpaceRole = "host" | "builder" | "guest";
export type AccessPolicyRole = "builder" | "guest" | null;
export type AccessPolicyResourceType = "space" | "session";
export type ReferralCodeStatus = "active" | "revoked";
export type ReferralStatus = "pending" | "qualified" | "rewarded";

/** Endpoints of a reference: the kinds of resources that can point or be pointed at. */
export type ReferenceResourceType =
  | "turn"
  | "session"
  | "space"
  | "checkpoint"
  | "file"
  | "app";

/** The nature of a reference between two resources. */
export type ReferenceKind =
  | "session_fork"
  | "space_fork"
  | "checkpoint_fork"
  | "mod"
  | "mention"
  | "tool_call"
  | "agent_tool_file_read"
  | "agent_tool_file_write"
  | "agent_tool_file_edit"
  | "agent_tool_file_ls"
  | "agent_tool_file_find"
  | "agent_tool_file_grep";

export const v2 = pgSchema("v2");

export const userProfiles = v2.table(
  "user_profiles",
  {
    userUuid: varchar("user_uuid", { length: 255 }).primaryKey(),
    logtoUserId: varchar("logto_user_id", { length: 255 }).notNull(),
    username: varchar("username", { length: 39 }),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    avatarUrl: text("avatar_url"),
    source: jsonb("source").$type<Record<string, unknown>>().notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    logtoUserIdUniqueIdx: uniqueIndex("v2_uq_user_profiles_logto_user_id").on(
      table.logtoUserId,
    ),
    updatedAtIdx: index("v2_idx_user_profiles_updated_at").on(table.updatedAt),
    usernameUniqueIdx: uniqueIndex("v2_uq_user_profiles_username").on(table.username),
  }),
);


export const userGitAccounts = v2.table(
  "user_git_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userUuid: varchar("user_uuid", { length: 255 }).notNull(),
    provider: varchar("provider", { length: 50 }).notNull().default("gitea"),
    giteaUserId: integer("gitea_user_id").notNull(),
    giteaUsername: varchar("gitea_username", { length: 255 }).notNull(),
    giteaPasswordEncrypted: text("gitea_password_encrypted").notNull(),
    giteaAccessTokenEncrypted: text("gitea_access_token_encrypted").notNull(),
    status: varchar("status", { length: 20 }).default("active"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    userUuidProviderUniqueIdx: uniqueIndex("v2_uq_user_git_accounts_user_provider").on(
      table.userUuid,
      table.provider,
    ),
    giteaUsernameUniqueIdx: uniqueIndex("v2_uq_user_git_accounts_gitea_username").on(
      table.giteaUsername,
    ),
    userUuidIdx: index("v2_idx_user_git_accounts_user_uuid").on(table.userUuid),
    providerIdx: index("v2_idx_user_git_accounts_provider").on(table.provider),
  }),
);

export const userChannels = v2.table(
  "user_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userUuid: varchar("user_uuid", { length: 255 }).notNull(),
    provider: varchar("provider", { length: 50 }).notNull(),
    name: varchar("name", { length: 255 }),
    credentials: jsonb("credentials").notNull(),
    status: varchar("status", { length: 20 }).default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    userUuidIdx: index("v2_idx_user_channels_user_uuid").on(table.userUuid),
    providerIdx: index("v2_idx_user_channels_provider").on(table.provider),
  }),
);

export const spaces = v2.table(
  "spaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userUuid: varchar("user_uuid", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 80 }),
    description: text("description"),
    storageRepoName: varchar("storage_repo_name", { length: 255 }).notNull(),
    baseCheckpointId: uuid("base_checkpoint_id"),
    headCheckpointId: uuid("head_checkpoint_id"),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
  },
  (table) => ({
    userUuidIdx: index("v2_idx_spaces_user_uuid").on(table.userUuid),
    baseCheckpointIdx: index("v2_idx_spaces_base_checkpoint_id").on(table.baseCheckpointId),
    headCheckpointIdx: index("v2_idx_spaces_head_checkpoint_id").on(table.headCheckpointId),
    lastActivityIdx: index("v2_idx_spaces_last_activity_at").on(table.lastActivityAt.desc().nullsLast(), table.createdAt.desc().nullsLast()),
    nameSearchIdx: index("v2_idx_spaces_name_trgm").using("gin", table.name.op("gin_trgm_ops")),
    descriptionSearchIdx: index("v2_idx_spaces_description_trgm").using("gin", table.description.op("gin_trgm_ops")),
    userSpaceNameUniqueIdx: uniqueIndex("v2_uq_spaces_user_name").on(table.userUuid, table.name),
    userSpaceSlugUniqueIdx: uniqueIndex("v2_uq_spaces_user_slug")
      .on(table.userUuid, table.slug)
      .where(sql`${table.slug} is not null`),
    spaceSlugFormatCheck: check(
      "v2_chk_spaces_slug_format",
      sql`${table.slug} is null or (length(${table.slug}) between 1 and 80 and ${table.slug} !~ '[^a-z0-9_-]' and left(${table.slug}, 1) ~ '[a-z0-9]' and right(${table.slug}, 1) ~ '[a-z0-9]')`,
    ),
    storageRepoNameUniqueIdx: uniqueIndex("v2_uq_spaces_storage_repo_name").on(
      table.storageRepoName,
    ),
  }),
);

export const spaceMods = v2.table(
  "space_mods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    modSpaceId: uuid("mod_space_id").notNull(),
    name: varchar("name", { length: 255 }),
    mountSlug: varchar("mount_slug", { length: 64 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdBy: varchar("created_by", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    spaceIdx: index("v2_idx_space_mods_space_id").on(table.spaceId),
    modSpaceIdx: index("v2_idx_space_mods_mod_space_id").on(table.modSpaceId),
    spaceModUniqueIdx: uniqueIndex("v2_uq_space_mods_space_mod").on(
      table.spaceId,
      table.modSpaceId,
    ),
    spaceMountSlugUniqueIdx: uniqueIndex("v2_uq_space_mods_space_mount_slug").on(
      table.spaceId,
      table.mountSlug,
    ),
  }),
);

export const spaceSandboxes = v2.table(
  "space_sandboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    provider: varchar("provider", { length: 20 }).notNull().default("cloud"),
    status: varchar("status", { length: 30 }).notNull().default("pending"),
    runtimeStatus: varchar("runtime_status", { length: 30 }).notNull().default("unknown"),
    podName: varchar("pod_name", { length: 255 }),
    desiredImage: text("desired_image"),
    reportedImageVersion: varchar("reported_image_version", { length: 255 }),
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    stopReason: varchar("stop_reason", { length: 30 }),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    spaceIdx: uniqueIndex("v2_uq_space_sandboxes_space_id").on(table.spaceId),
    statusIdx: index("v2_idx_space_sandboxes_status").on(table.status),
    desiredImageIdx: index("v2_idx_space_sandboxes_desired_image").on(table.desiredImage),
    reportedImageVersionIdx: index("v2_idx_space_sandboxes_reported_image_version").on(table.reportedImageVersion),
    heartbeatIdx: index("v2_idx_space_sandboxes_last_heartbeat_at").on(table.lastHeartbeatAt),
    activityIdx: index("v2_idx_space_sandboxes_last_activity_at").on(table.lastActivityAt),
    runtimeStatusIdx: index("v2_idx_space_sandboxes_runtime_status").on(table.runtimeStatus),
    stoppedAtIdx: index("v2_idx_space_sandboxes_stopped_at").on(table.stoppedAt),
    providerCheck: check(
      "v2_chk_space_sandboxes_provider",
      sql`${table.provider} in ('cloud', 'local')`,
    ),
  }),
);

export const checkpoints = v2.table(
  "checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    commitHash: varchar("commit_hash", { length: 40 }).notNull(),
    description: text("description").notNull(),
    parentCheckpointId: uuid("parent_checkpoint_id"),
    rootCheckpointId: uuid("root_checkpoint_id"),
    forkCount: integer("fork_count").notNull().default(0),
    saveVersion: integer("save_version").notNull().default(1),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    spaceIdx: index("v2_idx_checkpoints_space_id").on(table.spaceId),
    parentIdx: index("v2_idx_checkpoints_parent_id").on(table.parentCheckpointId),
    rootIdx: index("v2_idx_checkpoints_root_id").on(table.rootCheckpointId),
    descriptionSearchIdx: index("v2_idx_checkpoints_description_trgm").using("gin", table.description.op("gin_trgm_ops")),
    spaceCommitUniqueIdx: uniqueIndex("v2_uq_checkpoints_space_commit").on(
      table.spaceId,
      table.commitHash,
    ),
  }),
);

export const apps = v2.table(
  "apps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    userUuid: varchar("user_uuid", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 80 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("disabled"),
    visibility: varchar("visibility", { length: 20 }).notNull().default("public"),
    targetType: varchar("target_type", { length: 20 }).notNull(),
    targetRef: text("target_ref").notNull(),
    assetKey: text("asset_key"),
    currentVersionId: uuid("current_version_id"),
    latestVersion: integer("latest_version").notNull().default(0),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    appScopes: jsonb("app_scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    allowedViewerScopes: jsonb("allowed_viewer_scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    spaceIdx: index("v2_idx_apps_space_id").on(table.spaceId),
    userUuidIdx: index("v2_idx_apps_user_uuid").on(table.userUuid),
    statusIdx: index("v2_idx_apps_status").on(table.status),
    visibilityIdx: index("v2_idx_apps_visibility").on(table.visibility),
    statusCheck: check("v2_chk_apps_status", sql`${table.status} in ('published', 'disabled')`),
    visibilityCheck: check("v2_chk_apps_visibility", sql`${table.visibility} in ('public', 'space')`),
    spaceSlugUniqueIdx: uniqueIndex("v2_uq_apps_space_slug").on(table.spaceId, table.slug),
    slugFormatCheck: check(
      "v2_chk_apps_slug_format",
      sql`length(${table.slug}) between 1 and 80 and ${table.slug} !~ '[^a-z0-9_-]' and left(${table.slug}, 1) ~ '[a-z0-9]' and right(${table.slug}, 1) ~ '[a-z0-9]'`,
    ),
  }),
);

export const appVersions = v2.table(
  "app_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id").notNull(),
    version: integer("version").notNull(),
    targetType: varchar("target_type", { length: 20 }).notNull(),
    targetRef: text("target_ref").notNull(),
    assetKey: text("asset_key"),
    contentKind: varchar("content_kind", { length: 20 }).notNull().default("web"),
    artifact: jsonb("artifact").$type<Record<string, unknown>>(),
    /** Optional provenance / notes for this version (e.g. source session/turn). */
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    appIdx: index("v2_idx_app_versions_app_id").on(table.appId),
    appVersionUniqueIdx: uniqueIndex("v2_uq_app_versions_app_version").on(table.appId, table.version),
    contentKindCheck: check("v2_chk_app_versions_content_kind", sql`${table.contentKind} in ('web', 'file', 'board')`),
  }),
);

/** Hourly app view rollups, split by the immutable published version and source. */
export const appViewStatsHourly = v2.table(
  "app_view_stats_hourly",
  {
    appId: uuid("app_id").notNull(),
    appVersionId: uuid("app_version_id").notNull(),
    bucketStartAt: timestamp("bucket_start_at", { withTimezone: true }).notNull(),
    source: varchar("source", { length: 20 }).notNull(),
    viewCount: bigint("view_count", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    bucketDimensionsUniqueIdx: uniqueIndex("v2_uq_app_view_stats_hourly_bucket_dims").on(
      table.appId,
      table.appVersionId,
      table.bucketStartAt,
      table.source,
    ),
    appBucketIdx: index("v2_idx_app_view_stats_hourly_app_bucket").on(
      table.appId,
      table.bucketStartAt,
    ),
    appVersionIdx: index("v2_idx_app_view_stats_hourly_app_version").on(
      table.appId,
      table.appVersionId,
    ),
  }),
);

/** Immutable promotion configuration for a published app. */
export const appPromotions = v2.table(
  "app_promotions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    provider: varchar("provider", { length: 64 }).notNull(),
    parameters: jsonb("parameters").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    createdBy: varchar("created_by", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    appIdx: index("v2_idx_app_promotions_app_id").on(table.appId),
    providerCheck: check(
      "v2_chk_app_promotions_provider",
      sql`length(${table.provider}) between 1 and 64 and ${table.provider} !~ '[^a-z0-9_-]'`,
    ),
  }),
);

/** Hourly promotion event counts; no visitor-level data is retained. */
export const appPromotionStatsHourly = v2.table(
  "app_promotion_stats_hourly",
  {
    promotionId: uuid("promotion_id").notNull(),
    appVersionId: uuid("app_version_id").notNull(),
    bucketStartAt: timestamp("bucket_start_at", { withTimezone: true }).notNull(),
    eventKey: varchar("event_key", { length: 64 }).notNull(),
    eventCount: bigint("event_count", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    bucketDimensionsUniqueIdx: uniqueIndex("v2_uq_app_promotion_stats_hourly_dims").on(
      table.promotionId,
      table.appVersionId,
      table.bucketStartAt,
      table.eventKey,
    ),
    promotionBucketIdx: index("v2_idx_app_promotion_stats_hourly_promotion_bucket").on(
      table.promotionId,
      table.bucketStartAt,
    ),
  }),
);

/**
 * Per-space viewer grants: a user consents to an app acting on a specific
 * space (or, for `user.*` scopes, on their account). Unique per
 * (app, viewer, space) so one viewer can hold distinct grants for distinct
 * spaces — the app's home space and any space they picked themselves.
 */
export const appViewerGrants = v2.table(
  "app_viewer_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id").notNull(),
    spaceId: uuid("space_id").notNull(),
    viewerUserUuid: varchar("viewer_user_uuid", { length: 255 }).notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    appIdx: index("v2_idx_app_viewer_grants_app_id").on(table.appId),
    spaceIdx: index("v2_idx_app_viewer_grants_space_id").on(table.spaceId),
    viewerIdx: index("v2_idx_app_viewer_grants_viewer_user_uuid").on(table.viewerUserUuid),
    appViewerSpaceUniqueIdx: uniqueIndex("v2_uq_app_viewer_grants_app_viewer_space").on(
      table.appId,
      table.viewerUserUuid,
      table.spaceId,
    ),
  }),
);


export const spaceCommerceBusinesses = v2.table(
  "space_commerce_businesses",
  {
    spaceId: uuid("space_id").primaryKey(),
    billingBusinessKey: varchar("billing_business_key", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    businessKeyUniqueIdx: uniqueIndex("v2_uq_space_commerce_businesses_business_key").on(table.billingBusinessKey),
  }),
);

export const boards = v2.table(
  "boards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    title: text("title").notNull(),
    version: integer("version").notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    spaceIdx: index("v2_idx_boards_space_id").on(table.spaceId),
    updatedAtIdx: index("v2_idx_boards_updated_at").on(table.updatedAt),
  }),
);

export const boardNodes = v2.table(
  "board_nodes",
  {
    boardId: uuid("board_id").notNull().references(() => boards.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    type: varchar("type", { length: 40 }).notNull(),
    parentId: text("parent_id"),
    orderKey: text("order_key"),
    x: doublePrecision("x").notNull().default(0),
    y: doublePrecision("y").notNull().default(0),
    width: doublePrecision("width").notNull().default(240),
    height: doublePrecision("height").notNull().default(160),
    rotation: doublePrecision("rotation").notNull().default(0),
    refKind: varchar("ref_kind", { length: 40 }),
    refPath: text("ref_path"),
    refUrl: text("ref_url"),
    view: jsonb("view").$type<Record<string, unknown>>().notNull().default({}),
    style: jsonb("style").$type<Record<string, unknown>>().notNull().default({}),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    primary: uniqueIndex("v2_uq_board_nodes_board_node").on(table.boardId, table.nodeId),
    boardIdx: index("v2_idx_board_nodes_board_id").on(table.boardId),
    viewportIdx: index("v2_idx_board_nodes_viewport").on(table.boardId, table.x, table.y, table.width, table.height),
    refPathIdx: index("v2_idx_board_nodes_ref_path").on(table.boardId, table.refPath),
  }),
);

/**
 * Node relations on a Board.
 *
 * A separate table rather than a node row because a connection has no geometry of
 * its own: it names two nodes and is resolved against their live frames on read.
 * Storing it as a node would mean persisting a bounding box that is wrong the
 * moment either endpoint moves.
 *
 * `source_node_id` / `target_node_id` are plain columns instead of foreign keys to
 * `board_nodes` because nodes are soft-deleted: a database-level cascade would
 * either fire on a soft delete (losing relations that undo must restore) or not at
 * all. Referential integrity is enforced in the transaction validator, which is
 * the only place that sees a whole edit in order.
 */
export const boardConnections = v2.table(
  "board_connections",
  {
    boardId: uuid("board_id").notNull(),
    connectionId: text("connection_id").notNull(),
    sourceNodeId: text("source_node_id").notNull(),
    targetNodeId: text("target_node_id").notNull(),
    /** Relation kind slug, e.g. "related", "depends-on". */
    relation: varchar("relation", { length: 64 }).notNull().default("related"),
    /** Semantic direction: none | forward | backward | both. */
    direction: varchar("direction", { length: 16 }).notNull().default("forward"),
    label: text("label").notNull().default(""),
    sourceAnchor: jsonb("source_anchor").$type<Record<string, unknown>>().notNull().default({ kind: "auto" }),
    targetAnchor: jsonb("target_anchor").$type<Record<string, unknown>>().notNull().default({ kind: "auto" }),
    routing: jsonb("routing").$type<Record<string, unknown>>().notNull().default({}),
    style: jsonb("style").$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    revision: integer("revision").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    primary: uniqueIndex("v2_uq_board_connections_board_connection").on(table.boardId, table.connectionId),
    boardIdx: index("v2_idx_board_connections_board_id").on(table.boardId),
    // Incident-edge lookups in both directions: "what connects from/to this node".
    // Both are needed because a connection is found by either endpoint, and a
    // single composite index cannot serve a lookup on its second column.
    sourceIdx: index("v2_idx_board_connections_source").on(table.boardId, table.sourceNodeId),
    targetIdx: index("v2_idx_board_connections_target").on(table.boardId, table.targetNodeId),
    relationIdx: index("v2_idx_board_connections_relation").on(table.boardId, table.relation),
  }),
);

export const boardEffects = v2.table(
  "board_effects",
  {
    id: text("id").notNull(),
    boardId: uuid("board_id").notNull().references(() => boards.id, { onDelete: "cascade" }),
    targetType: varchar("target_type", { length: 20 }).notNull(),
    targetId: text("target_id"),
    kind: varchar("kind", { length: 160 }).notNull(),
    kindVersion: integer("kind_version").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    lifecycle: varchar("lifecycle", { length: 24 }).notNull(),
    timeOrigin: varchar("time_origin", { length: 24 }).notNull(),
    layer: varchar("layer", { length: 20 }).notNull(),
    seed: text("seed").notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    assetRefs: jsonb("asset_refs").$type<Array<Record<string, unknown>>>().notNull().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    revision: integer("revision").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    primary: uniqueIndex("v2_uq_board_effects_board_id").on(table.boardId, table.id),
    boardIdx: index("v2_idx_board_effects_board_id").on(table.boardId),
    targetIdx: index("v2_idx_board_effects_target").on(table.boardId, table.targetType, table.targetId),
  }),
);

export const boardCompositions = v2.table(
  "board_compositions",
  {
    id: text("id").notNull(),
    boardId: uuid("board_id").notNull().references(() => boards.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    duration: doublePrecision("duration").notNull(),
    playback: jsonb("playback").$type<Record<string, unknown>>().notNull().default({}),
    markers: jsonb("markers").$type<Array<Record<string, unknown>>>().notNull().default([]),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    revision: integer("revision").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    primary: uniqueIndex("v2_uq_board_compositions_board_id").on(table.boardId, table.id),
    boardIdx: index("v2_idx_board_compositions_board_id").on(table.boardId),
  }),
);

/**
 * Timeline children stay normalized so Track/Clip revision CAS and incremental
 * collaboration can be added without another storage migration. Composition
 * apply is intentionally aggregate-level in protocol v2; writes can become
 * incremental behind that stable command.
 */
export const boardTracks = v2.table(
  "board_tracks",
  {
    id: text("id").notNull(),
    boardId: uuid("board_id").notNull().references(() => boards.id, { onDelete: "cascade" }),
    compositionId: text("composition_id").notNull(),
    target: jsonb("target").$type<Record<string, unknown>>().notNull(),
    channel: varchar("channel", { length: 160 }).notNull(),
    channelVersion: integer("channel_version").notNull(),
    interpolation: varchar("interpolation", { length: 20 }).notNull(),
    fill: varchar("fill", { length: 20 }).notNull(),
    keyframes: jsonb("keyframes").$type<Array<Record<string, unknown>>>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => ({
    primary: uniqueIndex("v2_uq_board_tracks_composition_id").on(table.boardId, table.compositionId, table.id),
    compositionIdx: index("v2_idx_board_tracks_composition_id").on(table.boardId, table.compositionId),
  }),
);

export const boardClips = v2.table(
  "board_clips",
  {
    id: text("id").notNull(),
    boardId: uuid("board_id").notNull().references(() => boards.id, { onDelete: "cascade" }),
    compositionId: text("composition_id").notNull(),
    kind: varchar("kind", { length: 160 }).notNull(),
    kindVersion: integer("kind_version").notNull(),
    target: jsonb("target").$type<Record<string, unknown>>().notNull(),
    start: doublePrecision("start").notNull(),
    duration: doublePrecision("duration").notNull(),
    layer: varchar("layer", { length: 20 }).notNull(),
    fill: varchar("fill", { length: 20 }).notNull(),
    easing: varchar("easing", { length: 80 }).notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    assetRefs: jsonb("asset_refs").$type<Array<Record<string, unknown>>>().notNull().default([]),
    seed: text("seed").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => ({
    primary: uniqueIndex("v2_uq_board_clips_composition_id").on(table.boardId, table.compositionId, table.id),
    timelineIdx: index("v2_idx_board_clips_timeline").on(table.boardId, table.compositionId, table.start),
  }),
);

export const boardTransactions = v2.table(
  "board_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardId: uuid("board_id").notNull().references(() => boards.id, { onDelete: "cascade" }),
    txId: text("tx_id").notNull(),
    baseVersion: integer("base_version").notNull(),
    /** Null for a validated no-op mutation that did not advance Board version. */
    resultVersion: integer("result_version"),
    actorId: varchar("actor_id", { length: 255 }).notNull(),
    clientId: text("client_id"),
    undoGroupId: text("undo_group_id"),
    operations: jsonb("operations").$type<Array<Record<string, unknown>>>().notNull(),
    receipt: jsonb("receipt").$type<Record<string, unknown>>().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    boardTxUniqueIdx: uniqueIndex("v2_uq_board_transactions_board_tx").on(table.boardId, table.txId),
    boardVersionUniqueIdx: uniqueIndex("v2_uq_board_transactions_board_version")
      .on(table.boardId, table.resultVersion)
      .where(sql`${table.resultVersion} is not null`),
  }),
);

export const boardOperations = v2.table(
  "board_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardId: uuid("board_id").notNull().references(() => boards.id, { onDelete: "cascade" }),
    transactionId: uuid("transaction_id").notNull().references(() => boardTransactions.id, { onDelete: "cascade" }),
    operationIndex: integer("operation_index").notNull(),
    type: varchar("type", { length: 80 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    inverse: jsonb("inverse").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    transactionOrderUniqueIdx: uniqueIndex("v2_uq_board_operations_tx_order").on(table.transactionId, table.operationIndex),
    boardIdx: index("v2_idx_board_operations_board_id").on(table.boardId),
  }),
);

export const boardCheckpoints = v2.table(
  "board_checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    checkpointId: uuid("checkpoint_id").notNull(),
    sourceBoardId: uuid("source_board_id").notNull(),
    sourceSpaceId: uuid("source_space_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    checkpointBoardUniqueIdx: uniqueIndex("v2_uq_board_checkpoints_board").on(table.checkpointId, table.sourceBoardId),
    checkpointIdx: index("v2_idx_board_checkpoints_checkpoint_id").on(table.checkpointId),
  }),
);

export const boardPlaybackStates = v2.table(
  "board_playback_states",
  {
    boardId: uuid("board_id").primaryKey().references(() => boards.id, { onDelete: "cascade" }),
    playbackId: uuid("playback_id").notNull(),
    compositionId: text("composition_id").notNull(),
    compositionRevision: integer("composition_revision").notNull(),
    playbackRevision: integer("playback_revision").notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    position: doublePrecision("position").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    timeScale: doublePrecision("time_scale").notNull(),
    seed: text("seed").notNull(),
    commandId: text("command_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    playbackIdx: uniqueIndex("v2_uq_board_playback_id").on(table.playbackId),
  }),
);

export const proposals = v2.table(
  "proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    sourceCheckpointId: uuid("source_checkpoint_id").notNull(),
    targetSpaceId: uuid("target_space_id").notNull(),
    sourceBranchName: varchar("source_branch_name", { length: 255 }),
    targetBranchName: varchar("target_branch_name", { length: 255 }),
    externalPrId: varchar("external_pr_id", { length: 255 }),
    status: varchar("status", { length: 20 }).default("open"),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    targetSpaceIdx: index("v2_idx_proposals_target_space_id").on(table.targetSpaceId),
    sourceCheckpointIdx: index("v2_idx_proposals_source_checkpoint_id").on(table.sourceCheckpointId),
    statusIdx: index("v2_idx_proposals_status").on(table.status),
  }),
);

export const spaceChannels = v2.table(
  "space_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    channelId: uuid("channel_id").notNull(),
    config: jsonb("config"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    spaceIdx: index("v2_idx_space_channels_space").on(table.spaceId),
    channelIdx: uniqueIndex("v2_uq_space_channels_channel").on(table.channelId),
  }),
);

export const spaceSessions = v2.table(
  "space_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    userUuid: varchar("user_uuid", { length: 255 }),
    title: varchar("title", { length: 255 }),
    source: varchar("source", { length: 255 }),
    status: varchar("status", { length: 50 }).default("active"),
    externalSessionId: text("external_session_id"),
    meta: jsonb("meta"),
    latestMessageText: text("latest_message_text"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    lastMessageId: uuid("last_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    spaceIdx: index("v2_idx_space_sessions_space_id").on(table.spaceId),
    userUuidIdx: index("v2_idx_space_sessions_user_uuid").on(table.userUuid),
    lastMessageIdx: index("v2_idx_space_sessions_last_message_id").on(table.lastMessageId),
    lastMessageAtIdx: index("v2_idx_space_sessions_last_message_at").on(table.lastMessageAt),
    titleSearchIdx: index("v2_idx_space_sessions_title_trgm").using("gin", table.title.op("gin_trgm_ops")),
    latestMessageTextSearchIdx: index("v2_idx_space_sessions_latest_message_text_trgm").using("gin", table.latestMessageText.op("gin_trgm_ops")),
    spaceLastMessageIdx: index("v2_idx_space_sessions_space_last_message_id").on(
      table.spaceId,
      table.lastMessageAt.desc().nullsLast(),
      table.id.desc(),
    ),
    // Speeds up /me/sessions creator branch: user_uuid + activity order.
    userLastMessageIdx: index("v2_idx_space_sessions_user_last_message").on(
      table.userUuid,
      table.lastMessageAt.desc().nullsLast(),
      table.id.desc(),
    ),
    // Speeds up participant membership: meta.participants.userUuids ? userUuid.
    participantUserUuidsIdx: index("v2_idx_space_sessions_participant_user_uuids").using(
      "gin",
      sql`(${table.meta} -> 'participants' -> 'userUuids')`,
    ),
  }),
);

export const sessionForks = v2.table(
  "session_forks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    parentSessionId: uuid("parent_session_id").notNull(),
    childSessionId: uuid("child_session_id").notNull(),
    rootSessionId: uuid("root_session_id").notNull(),
    depth: integer("depth").notNull(),
    anchorSourceSessionId: uuid("anchor_source_session_id").notNull(),
    anchorTurnId: uuid("anchor_turn_id").notNull(),
    anchorSequence: integer("anchor_sequence").notNull(),
    ancestorSessionIds: uuid("ancestor_session_ids").array().notNull(),
    sessionPath: uuid("session_path").array().notNull(),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    childUniqueIdx: uniqueIndex("v2_uq_session_forks_child").on(table.childSessionId),
    parentIdx: index("v2_idx_session_forks_parent").on(table.parentSessionId),
    rootDepthIdx: index("v2_idx_session_forks_root_depth").on(table.rootSessionId, table.depth, table.createdAt),
    anchorTurnIdx: index("v2_idx_session_forks_anchor_turn").on(table.anchorTurnId),
  }),
);

export const sessionTurnSegments = v2.table(
  "session_turn_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    sourceSessionId: uuid("source_session_id").notNull(),
    fromSequence: integer("from_sequence").notNull(),
    toSequence: integer("to_sequence"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionOrdinalUniqueIdx: uniqueIndex("v2_uq_session_turn_segments_session_ordinal").on(table.sessionId, table.ordinal),
    sessionIdx: index("v2_idx_session_turn_segments_session").on(table.sessionId, table.ordinal),
    sourceIdx: index("v2_idx_session_turn_segments_source").on(table.sourceSessionId),
  }),
);

export const spaceSessionBindings = v2.table(
  "space_session_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    spaceSessionId: uuid("space_session_id").notNull(),
    spaceChannelId: uuid("space_channel_id").notNull(),
    provider: varchar("provider", { length: 50 }).notNull(),
    bindingKey: varchar("binding_key", { length: 255 }).notNull(),
    externalChatId: varchar("external_chat_id", { length: 255 }).notNull(),
    status: varchar("status", { length: 20 }).default("active"),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  },
  (table) => ({
    spaceIdx: index("v2_idx_space_session_bindings_space").on(table.spaceId),
    sessionIdx: index("v2_idx_space_session_bindings_session").on(table.spaceSessionId),
    channelIdx: index("v2_idx_space_session_bindings_channel").on(table.spaceChannelId),
    bindingKeyIdx: index("v2_idx_space_session_bindings_binding_key").on(table.bindingKey),
    externalChatIdx: index("v2_idx_space_session_bindings_external_chat").on(table.externalChatId),
    uniqueChannelBinding: uniqueIndex("v2_uq_space_session_bindings_channel_binding").on(
      table.spaceChannelId,
      table.bindingKey,
    ),
  }),
);

export const providerMessageRefs = v2.table(
  "provider_message_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: varchar("provider", { length: 50 }).notNull(),
    spaceId: uuid("space_id").notNull(),
    spaceSessionId: uuid("space_session_id").notNull(),
    spaceChannelId: uuid("space_channel_id"),
    sessionMessageId: uuid("session_message_id"),
    direction: varchar("direction", { length: 20 }).notNull(),
    externalConversationId: varchar("external_conversation_id", { length: 255 }).notNull(),
    externalMessageId: varchar("external_message_id", { length: 255 }).notNull(),
    parentExternalConversationId: varchar("parent_external_conversation_id", { length: 255 }),
    parentExternalMessageId: varchar("parent_external_message_id", { length: 255 }),
    externalAuthorId: varchar("external_author_id", { length: 255 }),
    externalAuthorName: varchar("external_author_name", { length: 255 }),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    providerConversationIdx: index("v2_idx_provider_message_refs_provider_conversation").on(
      table.provider,
      table.externalConversationId,
    ),
    providerMessageIdx: uniqueIndex("v2_uq_provider_message_refs_provider_message").on(
      table.provider,
      table.externalConversationId,
      table.externalMessageId,
      table.direction,
    ),
    spaceSessionIdx: index("v2_idx_provider_message_refs_space_session").on(table.spaceSessionId),
    sessionMessageIdx: index("v2_idx_provider_message_refs_session_message").on(
      table.sessionMessageId,
    ),
    parentMessageIdx: index("v2_idx_provider_message_refs_parent_message").on(
      table.provider,
      table.parentExternalConversationId,
      table.parentExternalMessageId,
    ),
    spaceChannelIdx: index("v2_idx_provider_message_refs_space_channel").on(table.spaceChannelId),
  }),
);

export const sessionTurns = v2.table(
  "session_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull(),
    userUuid: varchar("user_uuid", { length: 255 }),
    sequence: integer("sequence").notNull(),
    executionKind: varchar("execution_kind", { length: 32 }).$type<SessionTurnExecutionKind>().notNull().default("agent"),
    status: varchar("status", { length: 20 }).$type<SessionTurnStatus>().notNull().default("queued"),
    intent: varchar("intent", { length: 20 }).$type<SessionTurnIntent>().notNull().default("steer"),
    userContent: jsonb("user_content").notNull().$type<ContentBlock[]>(),
    userText: text("user_text"),
    assistantContent: jsonb("assistant_content").$type<ContentBlock[] | null>(),
    assistantText: text("assistant_text"),
    provider: varchar("provider", { length: 100 }),
    model: varchar("model", { length: 255 }),
    stopReason: varchar("stop_reason", { length: 50 }),
    errorMessage: text("error_message"),
    finalUsage: jsonb("final_usage").$type<import("@cohub/protocol/core").Usage | null>(),
    totalUsage: jsonb("total_usage").$type<import("@cohub/protocol/core").Usage | null>(),
    summary: jsonb("summary").$type<SessionTurnSummary | null>(),
    intermediateIndex: jsonb("intermediate_index").$type<SessionTurnIntermediateIndex | null>(),
    intermediateSummary: jsonb("intermediate_summary").$type<SessionTurnIntermediateSummary | null>(),
    meta: jsonb("meta"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    sessionIdx: index("v2_idx_session_turns_session_id").on(table.sessionId),
    sessionSequenceUniqueIdx: uniqueIndex("v2_uq_session_turns_session_sequence").on(
      table.sessionId,
      table.sequence,
    ),
    userUuidIdx: index("v2_idx_session_turns_user_uuid").on(table.userUuid),
    directGenerationClientMessageUniqueIdx: uniqueIndex("v2_uq_session_turns_direct_generation_client_message").on(
      table.sessionId,
      table.userUuid,
      sql`(${table.meta}->>'clientMessageId')`,
    ).where(sql`${table.executionKind} = 'direct_generation' and ${table.meta}->>'clientMessageId' is not null`),
    directGenerationBarrierIdx: index("v2_idx_session_turns_direct_generation_barrier").on(table.sessionId, table.sequence, table.status).where(sql`${table.executionKind} = 'direct_generation'`),
    createdAtIdx: index("v2_idx_session_turns_created_at").on(table.createdAt),
    userTextSearchIdx: index("v2_idx_session_turns_user_text_trgm").using("gin", table.userText.op("gin_trgm_ops")),
  }),
);

export const sessionMessages = v2.table(
  "session_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull(),
    turnId: uuid("turn_id"),
    role: varchar("role", { length: 20 }).notNull(),
    content: jsonb("content").notNull().$type<ContentBlock[]>(),
    text: text("text"),
    provider: varchar("provider", { length: 100 }),
    model: varchar("model", { length: 255 }),
    stopReason: varchar("stop_reason", { length: 50 }),
    errorMessage: text("error_message"),
    sequence: integer("sequence").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }),
    usage: jsonb("usage").$type<import("@cohub/protocol/core").Usage | null>(),
    meta: jsonb("meta"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    usageAggregatedAt: timestamp("usage_aggregated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    sessionIdx: index("v2_idx_session_messages_session_id").on(table.sessionId),
    turnSequenceIdx: index("v2_idx_session_messages_turn_sequence")
      .on(table.turnId, table.sequence)
      .where(sql`${table.turnId} is not null`),
    sessionSequenceUniqueIdx: uniqueIndex("v2_uq_session_messages_session_sequence").on(
      table.sessionId,
      table.sequence,
    ),
    idempotencyKeyUniqueIdx: uniqueIndex("v2_uq_session_messages_session_id_idempotency_key").on(
      table.sessionId,
      table.idempotencyKey,
    ),
  }),
);

export const tokenUsageStatsHourly = v2.table(
  "token_usage_stats_hourly",
  {
    bucketStartAt: timestamp("bucket_start_at", { withTimezone: true }).notNull(),
    userId: varchar("user_id", { length: 255 }),
    spaceId: uuid("space_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    provider: varchar("provider", { length: 100 }),
    model: varchar("model", { length: 255 }),
    requestCount: integer("request_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    costInput: numeric("cost_input", { precision: 18, scale: 8 }).notNull().default("0"),
    costOutput: numeric("cost_output", { precision: 18, scale: 8 }).notNull().default("0"),
    costCacheRead: numeric("cost_cache_read", { precision: 18, scale: 8 }).notNull().default("0"),
    costCacheWrite: numeric("cost_cache_write", { precision: 18, scale: 8 }).notNull().default("0"),
    costTotal: numeric("cost_total", { precision: 18, scale: 8 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    pk: uniqueIndex("v2_uq_token_usage_stats_hourly_bucket_dims").on(
      table.bucketStartAt,
      table.userId,
      table.spaceId,
      table.sessionId,
      table.provider,
      table.model,
    ),
    bucketIdx: index("v2_idx_token_usage_stats_hourly_bucket").on(table.bucketStartAt),
    userBucketIdx: index("v2_idx_token_usage_stats_hourly_user_bucket").on(table.userId, table.bucketStartAt),
    spaceBucketIdx: index("v2_idx_token_usage_stats_hourly_space_bucket").on(table.spaceId, table.bucketStartAt),
    sessionBucketIdx: index("v2_idx_token_usage_stats_hourly_session_bucket").on(table.sessionId, table.bucketStartAt),
    providerModelBucketIdx: index("v2_idx_token_usage_stats_hourly_provider_model_bucket").on(table.provider, table.model, table.bucketStartAt),
  }),
);

/**
 * Hourly multimodal generation usage rollups.
 * Mirrors token_usage_stats_hourly shape for trending / usage aggregation, but
 * dimensions on usageType instead of token breakdowns.
 *
 * Dimension notes:
 * - `sessionId` uses the zero UUID when a generation has no session context.
 * - `userId` / `provider` / `model` are NOT NULL with sentinels so the unique
 *   index and ON CONFLICT upserts stay reliable (Postgres NULLs are not equal).
 * - `provider` stores the generation **adapter type** (e.g. `openai.images`),
 *   not an LLM provider id — multimodal routing has no separate provider field.
 */
export const generationUsageStatsHourly = v2.table(
  "generation_usage_stats_hourly",
  {
    bucketStartAt: timestamp("bucket_start_at", { withTimezone: true }).notNull(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    spaceId: uuid("space_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    usageType: varchar("usage_type", { length: 100 }).notNull(),
    /** Generation adapter type, e.g. `openai.images` / `ark.videoGenerations`. */
    provider: varchar("provider", { length: 100 }).notNull(),
    model: varchar("model", { length: 255 }).notNull(),
    requestCount: integer("request_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    costTotal: numeric("cost_total", { precision: 18, scale: 8 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    pk: uniqueIndex("v2_uq_generation_usage_stats_hourly_bucket_dims").on(
      table.bucketStartAt,
      table.userId,
      table.spaceId,
      table.sessionId,
      table.usageType,
      table.provider,
      table.model,
    ),
    bucketIdx: index("v2_idx_generation_usage_stats_hourly_bucket").on(table.bucketStartAt),
    userBucketIdx: index("v2_idx_generation_usage_stats_hourly_user_bucket").on(table.userId, table.bucketStartAt),
    spaceBucketIdx: index("v2_idx_generation_usage_stats_hourly_space_bucket").on(table.spaceId, table.bucketStartAt),
    sessionBucketIdx: index("v2_idx_generation_usage_stats_hourly_session_bucket").on(table.sessionId, table.bucketStartAt),
    usageTypeBucketIdx: index("v2_idx_generation_usage_stats_hourly_usage_type_bucket").on(table.usageType, table.bucketStartAt),
    providerModelBucketIdx: index("v2_idx_generation_usage_stats_hourly_provider_model_bucket").on(table.provider, table.model, table.bucketStartAt),
  }),
);

export const gatewayLogs = v2.table(
  "gateway_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    direction: varchar("direction", { length: 10 }).notNull(),
    provider: varchar("provider", { length: 50 }).notNull(),
    channelId: uuid("channel_id"),
    externalChatId: varchar("external_chat_id", { length: 255 }),
    rawPayload: jsonb("raw_payload").notNull(),
    normalizedPayload: jsonb("normalized_payload"),
    status: varchar("status", { length: 20 }).default("success"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    channelIdx: index("v2_idx_gateway_logs_channel").on(table.channelId),
    directionIdx: index("v2_idx_gateway_logs_direction").on(table.direction),
    createdIdx: index("v2_idx_gateway_logs_created").on(table.createdAt),
  }),
);

export const referralCodes = v2.table(
  "referral_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    code: varchar("code", { length: 32 }).notNull(),
    status: varchar("status", { length: 20 }).$type<ReferralCodeStatus>().notNull().default("active"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    codeUniqueIdx: uniqueIndex("v2_uq_referral_codes_code").on(table.code),
    activeUserUniqueIdx: uniqueIndex("v2_uq_referral_codes_active_user")
      .on(table.userId)
      .where(sql`${table.status} = 'active'`),
    userIdx: index("v2_idx_referral_codes_user").on(table.userId),
  }),
);

export const referrals = v2.table(
  "referrals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    referralCodeId: uuid("referral_code_id").notNull(),
    inviterUserId: varchar("inviter_user_id", { length: 255 }).notNull(),
    inviteeUserId: varchar("invitee_user_id", { length: 255 }).notNull(),
    status: varchar("status", { length: 20 }).$type<ReferralStatus>().notNull().default("pending"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    qualifiedAt: timestamp("qualified_at", { withTimezone: true }),
    rewardedAt: timestamp("rewarded_at", { withTimezone: true }),
    inviterRewardedAt: timestamp("inviter_rewarded_at", { withTimezone: true }),
    inviteeRewardedAt: timestamp("invitee_rewarded_at", { withTimezone: true }),
    inviterRewardAmountUsd: numeric("inviter_reward_amount_usd", { precision: 12, scale: 8 }).notNull(),
    inviteeRewardAmountUsd: numeric("invitee_reward_amount_usd", { precision: 12, scale: 8 }).notNull(),
    rewardError: text("reward_error"),
    rewardAttemptedAt: timestamp("reward_attempted_at", { withTimezone: true }),
    rewardLeaseToken: varchar("reward_lease_token", { length: 64 }),
    rewardLeaseExpiresAt: timestamp("reward_lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    inviteeUniqueIdx: uniqueIndex("v2_uq_referrals_invitee").on(table.inviteeUserId),
    inviterIdx: index("v2_idx_referrals_inviter").on(table.inviterUserId),
    codeIdx: index("v2_idx_referrals_code").on(table.referralCodeId),
    qualifiedRetryIdx: index("v2_idx_referrals_qualified_retry")
      .on(table.rewardAttemptedAt)
      .where(sql`${table.status} = 'qualified'`),
  }),
);

export const spaceMembers = v2.table(
  "space_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id").notNull(),
    userId: varchar("user_id", { length: 255 }).notNull(),
    role: varchar("role", { length: 20 }).$type<SpaceRole>().notNull(),
    createdBy: varchar("created_by", { length: 255 }).notNull(),
    updatedBy: varchar("updated_by", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    uniqueSpaceUserIdx: uniqueIndex("v2_uq_space_members_space_user").on(
      table.spaceId,
      table.userId,
    ),
    spaceIdx: index("v2_idx_space_members_space").on(table.spaceId),
    userIdx: index("v2_idx_space_members_user").on(table.userId),
    userSpaceIdx: index("v2_idx_space_members_user_space").on(table.userId, table.spaceId),
    spaceRoleIdx: index("v2_idx_space_members_space_role").on(table.spaceId, table.role),
  }),
);

export const accessPolicies = v2.table(
  "access_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceType: varchar("resource_type", { length: 20 }).$type<AccessPolicyResourceType>().notNull(),
    resourceId: uuid("resource_id").notNull(),
    signedInUserRole: varchar("signed_in_user_role", { length: 20 }).$type<SpaceRole | null>(),
    anonymousUserRole: varchar("anonymous_user_role", { length: 20 }).$type<SpaceRole | null>(),
    createdBy: varchar("created_by", { length: 255 }).notNull(),
    updatedBy: varchar("updated_by", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    uniqueResourceIdx: uniqueIndex("v2_uq_access_policies_resource").on(
      table.resourceType,
      table.resourceId,
    ),
    resourceIdx: index("v2_idx_access_policies_resource").on(table.resourceType, table.resourceId),
  }),
);

export const labels = v2.table(
  "labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scopeType: varchar("scope_type", { length: 30 }).notNull(),
    scopeId: text("scope_id").notNull(),
    name: varchar("name", { length: 80 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull(),
    parentId: uuid("parent_id"),
    depth: integer("depth").notNull().default(0),
    source: varchar("source", { length: 30 }).notNull().default("user"),
    systemKey: varchar("system_key", { length: 120 }),
    rank: integer("rank").notNull().default(0),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    scopeRankIdx: index("v2_idx_labels_scope_rank").on(
      table.scopeType,
      table.scopeId,
      table.rank,
    ),
    scopeParentIdx: index("v2_idx_labels_scope_parent").on(
      table.scopeType,
      table.scopeId,
      table.parentId,
    ),
    siblingNameUniqueIdx: uniqueIndex("v2_uq_labels_scope_parent_name").on(
      table.scopeType,
      table.scopeId,
      sql`coalesce(${table.parentId}::text, '')`,
      sql`lower(${table.name})`,
    ),
    systemKeyUniqueIdx: uniqueIndex("v2_uq_labels_scope_system_key").on(
      table.scopeType,
      table.scopeId,
      table.systemKey,
    ),
    depthCheck: check("v2_chk_labels_depth", sql`${table.depth} in (0, 1)`),
  }),
);

export const labelAssignments = v2.table(
  "label_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    labelId: uuid("label_id").notNull(),
    scopeType: varchar("scope_type", { length: 30 }).notNull(),
    scopeId: text("scope_id").notNull(),
    resourceType: varchar("resource_type", { length: 30 }).notNull(),
    resourceRef: text("resource_ref").notNull(),
    rank: integer("rank"),
    source: varchar("source", { length: 30 }).notNull().default("user"),
    createdBy: varchar("created_by", { length: 255 }),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    uniqueLabelResourceIdx: uniqueIndex("v2_uq_label_assignments_label_resource").on(
      table.labelId,
      table.resourceType,
      table.resourceRef,
    ),
    labelRankIdx: index("v2_idx_label_assignments_label_rank").on(
      table.labelId,
      table.rank,
    ),
    scopeResourceIdx: index("v2_idx_label_assignments_scope_resource").on(
      table.scopeType,
      table.scopeId,
      table.resourceType,
      table.resourceRef,
    ),
    scopeLabelIdx: index("v2_idx_label_assignments_scope_label").on(
      table.scopeType,
      table.scopeId,
      table.labelId,
    ),
    sessionLabelResourceIdx: index("v2_idx_label_assignments_session_label_resource").on(
      table.labelId,
      table.resourceRef,
    ).where(sql`${table.resourceType} = 'session'`),
    resourceLabelIdx: index("v2_idx_label_assignments_resource_label").on(
      table.resourceType,
      table.resourceRef,
      table.labelId,
    ),
    resourceRefSearchIdx: index("v2_idx_label_assignments_resource_ref_trgm").using("gin", table.resourceRef.op("gin_trgm_ops")),
  }),
);

export const cronJobs = v2.table(
  "cron_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userUuid: varchar("user_uuid", { length: 255 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    taskType: varchar("task_type", { length: 100 }).notNull(),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
    cronExpression: varchar("cron_expression", { length: 100 }).notNull(),
    timezone: varchar("timezone", { length: 50 }).notNull().default("Asia/Shanghai"),
    bullJobKey: varchar("bull_job_key", { length: 500 }).notNull(),
    spaceId: uuid("space_id"),
    sessionId: uuid("session_id"),
    enabled: boolean("enabled").notNull().default(true),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    userIdx: index("v2_idx_cron_jobs_user_uuid").on(table.userUuid),
    spaceIdx: index("v2_idx_cron_jobs_space_id").on(table.spaceId),
    enabledIdx: index("v2_idx_cron_jobs_enabled").on(table.enabled),
    createdAtIdx: index("v2_idx_cron_jobs_created_at").on(table.createdAt),
  }),
);

export const taskRuns = v2.table(
  "task_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: varchar("job_id", { length: 255 }).notNull(),
    cronJobId: uuid("cron_job_id"),
    taskType: varchar("task_type", { length: 100 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    payload: jsonb("payload").notNull().$type<TaskPayload>(),
    result: jsonb("result"),
    errorMessage: text("error_message"),
    attemptCount: integer("attempt_count").notNull().default(0),
    spaceId: uuid("space_id"),
    sessionId: uuid("session_id"),
    turnId: uuid("turn_id"),
    userUuid: varchar("user_uuid", { length: 255 }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    jobIdUniqueIdx: uniqueIndex("v2_uq_task_runs_job_id").on(table.jobId),
    cronJobIdx: index("v2_idx_task_runs_cron_job_id").on(table.cronJobId),
    spaceIdx: index("v2_idx_task_runs_space_id").on(table.spaceId),
    sessionIdx: index("v2_idx_task_runs_session_id").on(table.sessionId),
    turnIdx: index("v2_idx_task_runs_turn_id").on(table.turnId),
    sessionTurnIdx: index("v2_idx_task_runs_session_turn").on(table.sessionId, table.turnId),
    userIdx: index("v2_idx_task_runs_user_uuid").on(table.userUuid),
    statusIdx: index("v2_idx_task_runs_status").on(table.status),
    taskTypeIdx: index("v2_idx_task_runs_task_type").on(table.taskType),
    spaceSessionTypeStatusCreatedIdx: index("v2_idx_task_runs_space_session_type_status_created").on(
      table.spaceId,
      table.sessionId,
      table.taskType,
      table.status,
      table.createdAt,
      table.id,
    ),
    userSessionTypeStatusCreatedIdx: index("v2_idx_task_runs_user_session_type_status_created").on(
      table.userUuid,
      table.sessionId,
      table.taskType,
      table.status,
      table.createdAt,
      table.id,
    ),
    generationSpaceSessionCreatedIdx: index("v2_idx_task_runs_generation_space_session_created")
      .on(table.spaceId, table.sessionId, table.createdAt, table.id)
      .where(sql`${table.taskType} = 'generation'`),
    generationSpaceCreatedIdx: index("v2_idx_task_runs_generation_space_created")
      .on(table.spaceId, table.createdAt, table.id)
      .where(sql`${table.taskType} = 'generation'`),
    generationUserCreatedIdx: index("v2_idx_task_runs_generation_user_created")
      .on(table.userUuid, table.createdAt, table.id)
      .where(sql`${table.taskType} = 'generation'`),
    cronJobStatusCreatedIdx: index("v2_idx_task_runs_cron_job_status_created").on(
      table.cronJobId,
      table.status,
      table.createdAt,
      table.id,
    ),
    createdAtIdx: index("v2_idx_task_runs_created_at").on(table.createdAt),
    scheduledAtIdx: index("v2_idx_task_runs_scheduled_at").on(table.scheduledAt),
  }),
);

/**
 * Unified index of references between resources — the raw material behind
 * relationship stats (collaboration networks, lineage, influence, file heat).
 *
 * The table is a directed graph of edges. Each row is a distinct reference
 * observed from a source resource to a target resource. Content references
 * (mention / tool_call / file_*) are sourced at `turn` granularity for maximum
 * precision; structural references (fork / mod) are sourced at the resource
 * that owns the event. `count` records how many times the edge appeared within
 * its source; cross-source totals are derived at query time via SUM/COUNT.
 *
 * `sourceSpaceId` / `sourceSessionId` denormalize the source's ancestry so a
 * single edge can be rolled up at turn, session, or space granularity without
 * extra joins. Targets carry their space inline (file targets encode it in
 * `targetId` as `{spaceId}:{path}`), so no target ancestry columns are needed.
 *
 * Source tables (session_turns, session_forks, checkpoints, space_mods, ...)
 * remain the sole source of truth. This table is a rebuildable index: written
 * by non-blocking async double-writes at each behavior point and fully
 * reconstructable by a backfill scan at any time.
 */
export const resourceReferences = v2.table(
  "resource_references",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: varchar("kind", { length: 30 }).$type<ReferenceKind>().notNull(),
    /** Source endpoint. `turn` for content refs; the owning resource for structural refs. */
    sourceType: varchar("source_type", { length: 20 }).$type<ReferenceResourceType>().notNull(),
    sourceId: text("source_id").notNull(),
    targetType: varchar("target_type", { length: 20 }).$type<ReferenceResourceType>().notNull(),
    /** Target endpoint. File targets encode their space as `{spaceId}:{absPath}`. */
    targetId: text("target_id").notNull(),
    /** Source's owning space, for authorization and space-level rollups. */
    sourceSpaceId: uuid("source_space_id").notNull(),
    /** Source's owning session, for session-level rollups; null for space/checkpoint sources. */
    sourceSessionId: uuid("source_session_id"),
    /** Times this edge appeared within its source (usually 1). */
    count: integer("count").notNull().default(1),
    /** Denormalized context: mention label, tool name, fork anchor, raw path, etc. */
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Edge identity. Every column is non-null, so no nullsNotDistinct is needed.
    uniqueReference: unique("v2_uq_resource_references_identity").on(
      table.kind,
      table.sourceType,
      table.sourceId,
      table.targetType,
      table.targetId,
    ),
    // "Who references me" reverse lookup (influence / dependents / file heat).
    targetIdx: index("v2_idx_resource_references_target").on(
      table.targetType,
      table.targetId,
      table.kind,
    ),
    // "What does this source reference" forward lookup (turn/session/space precision).
    sourceIdx: index("v2_idx_resource_references_source").on(
      table.sourceType,
      table.sourceId,
      table.kind,
    ),
    // Space-level aggregation and time trends.
    spaceKindIdx: index("v2_idx_resource_references_space_kind").on(
      table.sourceSpaceId,
      table.kind,
      table.updatedAt,
    ),
    // Session-level rollups.
    sessionKindIdx: index("v2_idx_resource_references_session_kind").on(
      table.sourceSessionId,
      table.kind,
    ),
  }),
);
