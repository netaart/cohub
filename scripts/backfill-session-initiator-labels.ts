import "dotenv/config";
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: "apps/api/.env", override: false });

import { and, asc, eq, gt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@cohub/db";
import {
  getSessionSourceLabelSystemKey,
  resolveSessionInitiatorLabelId,
  SESSION_INITIATOR_LABEL_SYSTEM_KEY_PREFIX,
} from "@cohub/core/labels/session-attribution";
import { readSessionInitiator, SESSION_SOURCE_NAMES, type SessionInitiator } from "@cohub/protocol/model";

/** Adds missing Initiator labels and renames "Web App" to "Web". Idempotent; dry-run unless --write. */

const connectionString = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/cohub";
const dbClient = postgres(connectionString, { prepare: false });
const db = drizzle(dbClient, { schema });

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 5_000;

type Args = {
  write: boolean;
  spaceId: string | null;
  sessionId: string | null;
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
    "--batch-size": isPositive,
    "--max-sessions": isPositive,
  };
  const values = new Map<string, string>();
  let write = false;
  const argv = rawArgv.filter((arg) => arg !== "--");
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    if (flag === "--write") {
      write = true;
      continue;
    }
    const valid = valueFlags[flag];
    if (!valid) throw new Error(`unknown argument: ${flag}`);
    const value = argv[++index];
    if (!value || !valid(value)) throw new Error(`invalid ${flag}: ${value ?? "(missing)"}`);
    values.set(flag, value);
  }
  const number = (flag: string) => (values.has(flag) ? Number(values.get(flag)) : null);
  return {
    write,
    spaceId: values.get("--space-id") ?? null,
    sessionId: values.get("--session-id") ?? null,
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
        'fork', ${spaceSessions.meta}->'fork'
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const labelIds = new Map<string, string>();
  const labelIdFor = async (spaceId: string, initiator: SessionInitiator) => {
    const key = `${spaceId}:${initiator}`;
    let id = labelIds.get(key);
    if (!id) {
      id = await resolveSessionInitiatorLabelId(db, spaceId, initiator);
      labelIds.set(key, id);
    }
    return id;
  };

  const counts: Record<SessionInitiator, number> = { human: 0, agent: 0, automation: 0 };
  let scanned = 0;
  let alreadyLabeled = 0;
  let failures = 0;
  let cursor: string | null = null;

  while (args.maxSessions === null || scanned < args.maxSessions) {
    const limit = args.maxSessions === null ? args.batchSize : Math.min(args.batchSize, args.maxSessions - scanned);
    const rows = await loadBatch(args, cursor, limit);
    if (rows.length === 0) break;
    cursor = rows.at(-1)?.id ?? null;
    scanned += rows.length;

    const values: Array<typeof labelAssignments.$inferInsert> = [];
    for (const row of rows) {
      if (row.labeled) {
        alreadyLabeled += 1;
        continue;
      }
      const initiator = readSessionInitiator(row) ?? "human";
      counts[initiator] += 1;
      if (!args.write) continue;
      try {
        values.push({
          labelId: await labelIdFor(row.spaceId, initiator),
          scopeType: "space",
          scopeId: row.spaceId,
          resourceType: "session",
          resourceRef: row.id,
          rank: null,
          source: "system",
          createdBy: null,
        });
      } catch (error) {
        failures += 1;
        console.warn("[backfill-session-initiator-labels] failed to resolve label", { sessionId: row.id, spaceId: row.spaceId, error });
      }
    }
    if (values.length > 0) await db.insert(labelAssignments).values(values).onConflictDoNothing();
    if (rows.length < limit) break;
  }

  const partial = args.sessionId !== null || args.maxSessions !== null;
  const renamedWebSourceLabels = partial ? 0 : await renameLegacyWebSourceLabels(args);

  console.log(JSON.stringify({
    mode: args.write ? "write" : "dry-run",
    batchSize: args.batchSize,
    maxSessions: args.maxSessions,
    scanned,
    alreadyLabeled,
    labeled: counts,
    renamedWebSourceLabels,
    failures,
  }, null, 2));
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await dbClient.end({ timeout: 5 }).catch(() => undefined);
  });
