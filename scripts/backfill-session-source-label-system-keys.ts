import "dotenv/config";
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: "apps/api/.env", override: false });

import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@cohub/db";
import {
  resolveKnownSessionSourceLabelSystemKey,
  SESSION_SOURCE_ROOT_LABEL_SYSTEM_KEY,
} from "@cohub/core/labels/session-attribution";

const connectionString = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/cohub";
const dbClient = postgres(connectionString, { prepare: false });
const db = drizzle(dbClient, { schema });

type Args = {
  write: boolean;
  spaceId: string | null;
};

function parseArgs(rawArgv: string[]): Args {
  const argv = rawArgv.filter((arg) => arg !== "--");
  const readValue = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    write: argv.includes("--write"),
    spaceId: readValue("--space-id") ?? null,
  };
}

async function hasSystemKey(spaceId: string, systemKey: string) {
  const [row] = await db
    .select({ id: schema.labels.id })
    .from(schema.labels)
    .where(and(
      eq(schema.labels.scopeType, "space"),
      eq(schema.labels.scopeId, spaceId),
      eq(schema.labels.systemKey, systemKey),
    ))
    .limit(1);
  return Boolean(row);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    console.log("Usage: tsx scripts/backfill-session-source-label-system-keys.ts [--write] [--space-id <id>]");
    return;
  }
  const args = parseArgs(rawArgs);
  const rootFilters = [
    eq(schema.labels.scopeType, "space"),
    eq(schema.labels.source, "system"),
    isNull(schema.labels.parentId),
    sql`lower(${schema.labels.name}) = 'source'`,
  ];
  if (args.spaceId) rootFilters.push(eq(schema.labels.scopeId, args.spaceId));
  const sourceRoots = await db
    .select()
    .from(schema.labels)
    .where(and(...rootFilters));

  let rootsUpdated = 0;
  let childrenScanned = 0;
  let childrenUpdated = 0;
  let skippedUnknown = 0;
  let skippedExistingSystemKey = 0;

  for (const root of sourceRoots) {
    if (!root.systemKey && !(await hasSystemKey(root.scopeId, SESSION_SOURCE_ROOT_LABEL_SYSTEM_KEY))) {
      if (args.write) {
        const result = await db
          .update(schema.labels)
          .set({ systemKey: SESSION_SOURCE_ROOT_LABEL_SYSTEM_KEY })
          .where(and(eq(schema.labels.id, root.id), isNull(schema.labels.systemKey)))
          .returning({ id: schema.labels.id });
        rootsUpdated += result.length;
      } else {
        rootsUpdated += 1;
      }
    } else if (!root.systemKey) {
      skippedExistingSystemKey += 1;
    }

    const children = await db
      .select()
      .from(schema.labels)
      .where(and(
        eq(schema.labels.scopeType, "space"),
        eq(schema.labels.scopeId, root.scopeId),
        eq(schema.labels.source, "system"),
        eq(schema.labels.parentId, root.id),
        isNull(schema.labels.systemKey),
      ));

    for (const label of children) {
      childrenScanned += 1;
      const systemKey = resolveKnownSessionSourceLabelSystemKey(`Source/${label.name}`);
      if (!systemKey) {
        skippedUnknown += 1;
        continue;
      }
      if (await hasSystemKey(root.scopeId, systemKey)) {
        skippedExistingSystemKey += 1;
        continue;
      }
      if (!args.write) {
        childrenUpdated += 1;
        continue;
      }
      const result = await db
        .update(schema.labels)
        .set({ systemKey })
        .where(and(
          eq(schema.labels.id, label.id),
          isNull(schema.labels.systemKey),
        ))
        .returning({ id: schema.labels.id });
      childrenUpdated += result.length;
    }
  }

  console.log(JSON.stringify({
    mode: args.write ? "write" : "dry-run",
    spaceId: args.spaceId,
    sourceRoots: sourceRoots.length,
    rootsUpdated,
    childrenScanned,
    childrenUpdated,
    skippedUnknown,
    skippedExistingSystemKey,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await dbClient.end({ timeout: 5 }).catch(() => undefined);
  });
