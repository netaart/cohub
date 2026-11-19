import "dotenv/config";
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: "apps/api/.env", override: false });

import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@cohub/db";
import {
  getSessionInitiatorLabelSystemKey,
  getSessionSourceLabelSystemKey,
  SESSION_INITIATOR_LABEL_SYSTEM_KEY_PREFIX,
  SESSION_INITIATOR_ROOT_LABEL_SYSTEM_KEY,
} from "@cohub/core/labels/session-attribution";
import { getOrCreateSpaceSystemLabel, SystemLabelNameConflictError } from "@cohub/core/labels/system-label";
import { readSessionInitiator, SESSION_SOURCE_NAMES, type SessionInitiator } from "@cohub/protocol/model";

/** Adds missing Initiator labels and renames "Web App" to "Web". Idempotent; dry-run unless --write. */

const connectionString = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/cohub";
const dbClient = postgres(connectionString, { max: 1, prepare: false });
const db = drizzle(dbClient, { schema });

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 5_000;

type Args = {
  write: boolean;
  spaceId: string | null;
  sessionId: string | null;
  afterSessionId: string | null;
  skipWebRename: boolean;
  batchSize: number;
  maxSessions: number | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(rawArgv: string[]): Args {
  const isUuid = (value: string) => UUID_RE.test(value);
  const isPositive = (value: string) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
  const valueFlags: Record<string, (value: string) => boolean> = {
    "--space-id": isUuid,
    "--session-id": isUuid,
    "--after-session-id": isUuid,
    "--batch-size": isPositive,
    "--max-sessions": isPositive,
  };
  const values = new Map<string, string>();
  let write = false;
  let skipWebRename = false;
  const argv = rawArgv.filter((arg) => arg !== "--");
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    if (flag === "--write") {
      write = true;
      continue;
    }
    if (flag === "--skip-web-rename") {
      skipWebRename = true;
      continue;
    }
    const valid = valueFlags[flag];
    if (!valid) throw new Error(`unknown argument: ${flag}`);
    const value = argv[++index];
    if (!value || !valid(value)) throw new Error(`invalid ${flag}: ${value ?? "(missing)"}`);
    values.set(flag, value);
  }
  if (values.has("--session-id") && values.has("--after-session-id")) {
    throw new Error("--session-id cannot be combined with --after-session-id");
  }
  const number = (flag: string) => (values.has(flag) ? Number(values.get(flag)) : null);
  return {
    write,
    spaceId: values.get("--space-id") ?? null,
    sessionId: values.get("--session-id") ?? null,
    afterSessionId: values.get("--after-session-id") ?? null,
    skipWebRename,
    batchSize: Math.min(number("--batch-size") ?? DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE),
    maxSessions: number("--max-sessions"),
  };
}

const { spaceSessions, labelAssignments, labels } = schema;

const hasInitiatorLabel = sql`exists (
  select 1 from ${labelAssignments}
  inner join ${labels} on ${labels.id} = ${labelAssignments.labelId}
  where ${labelAssignments.scopeType} = 'space'
    and ${labelAssignments.scopeId} = ${spaceSessions.spaceId}::text
    and ${labelAssignments.resourceType} = 'session'
    and ${labelAssignments.resourceRef} = ${spaceSessions.id}::text
    and ${labels.systemKey} like ${`${SESSION_INITIATOR_LABEL_SYSTEM_KEY_PREFIX}%`}
)`;

async function loadBatch(args: Args, cursor: string | null, limit: number) {
  return db
    .select({
      id: spaceSessions.id,
      spaceId: spaceSessions.spaceId,
      source: spaceSessions.source,
      meta: sql<Record<string, unknown>>`jsonb_build_object(
        'origin', ${spaceSessions.meta}->'origin',
        'requestSource', ${spaceSessions.meta}->'requestSource',
        'createdBy', ${spaceSessions.meta}->'createdBy',
        'fork', ${spaceSessions.meta}->'fork',
        'initiator', ${spaceSessions.meta}->'initiator',
        'context', jsonb_build_object('kind', ${spaceSessions.meta}#>'{context,kind}')
      )`,
      labeled: sql<boolean>`${hasInitiatorLabel}`,
    })
    .from(spaceSessions)
    .where(and(
      args.spaceId ? eq(spaceSessions.spaceId, args.spaceId) : undefined,
      args.sessionId ? eq(spaceSessions.id, args.sessionId) : undefined,
      cursor ? gt(spaceSessions.id, cursor) : undefined,
    ))
    .orderBy(asc(spaceSessions.id))
    .limit(limit);
}

async function renameLegacyWebSourceLabels(args: Args) {
  const name = SESSION_SOURCE_NAMES.web;
  const filters = sql`${labels.systemKey} = ${getSessionSourceLabelSystemKey("web")}
    and ${labels.source} = 'system'
    and ${labels.name} = 'Web App'
    ${args.spaceId ? sql`and ${labels.scopeId} = ${args.spaceId}` : sql``}
    and not exists (
      select 1 from ${labels} sibling
      where sibling.scope_type = ${labels.scopeType}
        and sibling.scope_id = ${labels.scopeId}
        and sibling.parent_id is not distinct from ${labels.parentId}
        and lower(sibling.name) = lower(${name})
    )`;
  if (!args.write) {
    const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(labels).where(filters);
    return row?.count ?? 0;
  }
  const renamed = await db.update(labels)
    .set({ name, slug: name.toLowerCase(), updatedAt: new Date() })
    .where(filters)
    .returning({ id: labels.id });
  return renamed.length;
}

type LabelRequest = Parameters<typeof getOrCreateSpaceSystemLabel>[1];

const INITIATOR_LABEL_NAMES: Record<SessionInitiator, string> = {
  human: "Human",
  agent: "Agent",
  automation: "Automation",
};
const labelKey = (spaceId: string, systemKey: string) => `${spaceId}:${systemKey}`;
const siblingKey = (spaceId: string, parentId: string | null) => `${spaceId}:${parentId ?? ""}`;

async function ensureLabels(requests: LabelRequest[], ids: Map<string, string>, conflicts: Set<string>) {
  const pending = new Map<string, LabelRequest>();
  for (const request of requests) {
    const key = labelKey(request.spaceId, request.systemKey);
    if (!ids.has(key) && !conflicts.has(key)) pending.set(key, request);
  }
  if (pending.size === 0) return;

  const scopeIds = [...new Set([...pending.values()].map(({ spaceId }) => spaceId))];
  const systemKeys = [...new Set([...pending.values()].map(({ systemKey }) => systemKey))];
  const existing = await db.select({ id: labels.id, scopeId: labels.scopeId, systemKey: labels.systemKey })
    .from(labels)
    .where(and(eq(labels.scopeType, "space"), inArray(labels.scopeId, scopeIds), inArray(labels.systemKey, systemKeys)));
  for (const row of existing) {
    if (row.systemKey === null) continue;
    const key = labelKey(row.scopeId, row.systemKey);
    ids.set(key, row.id);
    pending.delete(key);
  }
  if (pending.size === 0) return;

  const missing = [...pending.values()];
  const missingScopes = [...new Set(missing.map(({ spaceId }) => spaceId))];
  const parents = [...new Set(missing.flatMap(({ parentId }) => parentId === null ? [] : [parentId]))];
  const siblings = await db.select({
    scopeId: labels.scopeId,
    parentId: labels.parentId,
    name: sql<string>`lower(${labels.name})`,
    rank: labels.rank,
  }).from(labels).where(and(
    eq(labels.scopeType, "space"),
    inArray(labels.scopeId, missingScopes),
    parents.length === 0 ? isNull(labels.parentId) : inArray(labels.parentId, parents),
  ));
  const ranks = new Map<string, number>();
  const names = new Set<string>();
  for (const sibling of siblings) {
    const key = siblingKey(sibling.scopeId, sibling.parentId);
    ranks.set(key, Math.max(ranks.get(key) ?? sibling.rank, sibling.rank));
    names.add(`${key}:${sibling.name}`);
  }

  const values: Array<typeof labels.$inferInsert> = [];
  for (const request of missing) {
    const { spaceId, name, parentId, depth, systemKey } = request;
    const key = siblingKey(spaceId, parentId);
    const slug = name.toLowerCase();
    if (names.has(`${key}:${slug}`)) continue;
    const rank = (ranks.get(key) ?? 0) + 10;
    ranks.set(key, rank);
    values.push({ scopeType: "space", scopeId: spaceId, name, slug, parentId, depth, source: "system", systemKey, rank });
  }
  if (values.length > 0) {
    const created = await db.insert(labels).values(values).onConflictDoNothing()
      .returning({ id: labels.id, scopeId: labels.scopeId, systemKey: labels.systemKey });
    for (const row of created) {
      if (row.systemKey === null) continue;
      const key = labelKey(row.scopeId, row.systemKey);
      ids.set(key, row.id);
      pending.delete(key);
    }
  }

  for (const [key, request] of pending) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const id = await db.transaction(async (tx) => {
          const label = await getOrCreateSpaceSystemLabel(tx, request);
          if (label.systemKey !== request.systemKey) {
            throw new SystemLabelNameConflictError(`Expected ${request.systemKey}, got ${label.systemKey ?? "no system key"}`);
          }
          return label.id;
        });
        ids.set(key, id);
        break;
      } catch (error) {
        const cause = error instanceof Error ? error.cause ?? error : error;
        const nameRace = cause instanceof postgres.PostgresError
          && cause.code === "23505" && cause.constraint_name === "v2_uq_labels_scope_parent_name";
        if (nameRace && attempt < 3) continue;
        const conflict = nameRace ? cause : error instanceof SystemLabelNameConflictError ? error : null;
        if (!conflict) throw error;
        conflicts.add(key);
        console.error("[backfill-session-initiator-labels] label conflict; retry this space after resolving it", {
          spaceId: request.spaceId, systemKey: request.systemKey, message: conflict.message,
        });
        break;
      }
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: tsx scripts/backfill-session-initiator-labels.ts [--write] [--skip-web-rename] [--space-id <uuid>] [--session-id <uuid> | --after-session-id <uuid>] [--max-sessions <n>] [--batch-size <n>]");
    return;
  }
  const args = parseArgs(argv);
  const labelIds = new Map<string, string>();
  const conflicts = new Set<string>();
  const counts: Record<SessionInitiator, number> = { human: 0, agent: 0, automation: 0 };
  let scanned = 0;
  let alreadyLabeled = 0;
  let inserted = 0;
  let failures = 0;
  let cursor = args.afterSessionId;
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  const progress = () => ({ scanned, inserted, failures, lastSessionId: cursor, elapsedSeconds: (Date.now() - startedAt) / 1000 });

  try {
    while (args.maxSessions === null || scanned < args.maxSessions) {
      const limit = args.maxSessions === null ? args.batchSize : Math.min(args.batchSize, args.maxSessions - scanned);
      const rows = await loadBatch(args, cursor, limit);
      const lastRow = rows.at(-1);
      if (!lastRow) break;

      const missing = [];
      for (const row of rows) {
        if (row.labeled) {
          alreadyLabeled += 1;
          continue;
        }
        const initiator = readSessionInitiator(row) ?? "human";
        counts[initiator] += 1;
        if (args.write) missing.push({ id: row.id, spaceId: row.spaceId, initiator });
      }
      if (missing.length > 0) {
        await ensureLabels(missing.map(({ spaceId }) => ({
          spaceId, name: "Initiator", parentId: null, depth: 0, systemKey: SESSION_INITIATOR_ROOT_LABEL_SYSTEM_KEY,
        })), labelIds, conflicts);
        const children = missing.flatMap(({ spaceId, initiator }): LabelRequest[] => {
          const rootKey = labelKey(spaceId, SESSION_INITIATOR_ROOT_LABEL_SYSTEM_KEY);
          if (conflicts.has(rootKey)) return [];
          const parentId = labelIds.get(rootKey);
          if (!parentId) throw new Error(`Missing Initiator root in space ${spaceId}`);
          return [{ spaceId, name: INITIATOR_LABEL_NAMES[initiator], parentId, depth: 1, systemKey: getSessionInitiatorLabelSystemKey(initiator) }];
        });
        await ensureLabels(children, labelIds, conflicts);
        const values = missing.flatMap(({ id, spaceId, initiator }): Array<typeof labelAssignments.$inferInsert> => {
          const key = labelKey(spaceId, getSessionInitiatorLabelSystemKey(initiator));
          if (conflicts.has(key) || conflicts.has(labelKey(spaceId, SESSION_INITIATOR_ROOT_LABEL_SYSTEM_KEY))) {
            failures += 1;
            return [];
          }
          const labelId = labelIds.get(key);
          if (!labelId) throw new Error(`Missing ${initiator} label in space ${spaceId}`);
          return [{ labelId, scopeType: "space", scopeId: spaceId, resourceType: "session", resourceRef: id, source: "system" }];
        });
        if (values.length > 0) {
          const result = await db.insert(labelAssignments).values(values).onConflictDoNothing();
          inserted += result.count;
        }
      }
      scanned += rows.length;
      cursor = lastRow.id;
      if (Date.now() - lastProgressAt >= 5000) {
        console.error("[backfill-session-initiator-labels] progress", JSON.stringify(progress()));
        lastProgressAt = Date.now();
      }
      if (rows.length < limit) break;
    }

    const partial = args.sessionId !== null || args.afterSessionId !== null || args.maxSessions !== null;
    const skippedWebRename = partial || args.skipWebRename;
    const renamedWebSourceLabels = skippedWebRename ? 0 : await renameLegacyWebSourceLabels(args);
    console.log(JSON.stringify({
      mode: args.write ? "write" : "dry-run",
      batchSize: args.batchSize,
      maxSessions: args.maxSessions,
      ...progress(),
      alreadyLabeled,
      labeled: counts,
      skippedWebRename,
      renamedWebSourceLabels,
    }, null, 2));
    if (failures > 0) process.exitCode = 1;
  } catch (error) {
    console.error("[backfill-session-initiator-labels] stopped", JSON.stringify(progress()));
    throw error;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await dbClient.end({ timeout: 5 }).catch(() => undefined);
  });
