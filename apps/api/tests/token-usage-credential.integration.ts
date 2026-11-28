import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readSessionModel, recordTokenUsage, tokenUsageIncrements } from "@cohub/core/sessions";
import * as schema from "@cohub/db";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { publicUsageLabel } from "../src/usage-aggregation.js";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../drizzle/v2");
const client = new PGlite({ extensions: { pg_trgm } });
const db = drizzle(client, { schema });
const usage = schema.tokenUsageStatsHourly;
const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
const migrate = async (tags: string[]) => {
  for (const tag of tags) await client.exec(readFileSync(join(migrations, `${tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
};

const tags = journal.entries.map((entry) => entry.tag);
const credentialMigration = tags.indexOf("0090_token_usage_credential");
await migrate(tags.slice(0, credentialMigration));
const space = "00000000-0000-4000-8000-000000000001";
const sessions = ["00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-00000000000b"];
await client.exec(`INSERT INTO v2.token_usage_stats_hourly (bucket_start_at, user_id, space_id, session_id, harness, provider, model, total_tokens)
  VALUES ('2026-11-27T10:00:00Z', 'u', '${space}', '${sessions[0]}', 'cohub', 'cohub', 'chat', 1),
         ('2026-11-27T10:00:00Z', 'u', '${space}', '${sessions[0]}', 'claude', 'local', 'opus', 2)`);
await migrate(tags.slice(credentialMigration));

const record = (sessionId: string, provider: string, meta: Record<string, unknown>, totalTokens: number) => Promise.all(
  tokenUsageIncrements(
    { sessionId, role: "assistant", provider, model: "chat", usage: { totalTokens }, meta, errorMessage: null, stopReason: "stop", createdAt: new Date("2026-11-28T10:20:00Z") },
    { spaceId: space, userId: "u" },
  ).map((increment) => recordTokenUsage(db, increment)),
);

test("existing local Harness usage is migrated to user credentials", async () => {
  const rows = await db.select({ harness: usage.harness, credential: usage.credential }).from(usage).orderBy(asc(usage.harness));
  assert.deepEqual(rows, [{ harness: "claude", credential: "user" }, { harness: "cohub", credential: "platform" }]);
});

test("usage keeps platform and user credentials apart and masks user labels for the public", async () => {
  await record(sessions[0], "anthropic", {}, 10);
  await record(sessions[0], "anthropic", {}, 5);
  await record(sessions[0], "anthropic", { credential: "user", host: "gateway.example.com" }, 7);
  await record(sessions[1], "anthropic", { credential: "user", host: "other.example.com" }, 3);
  await record(sessions[1], "openai", { runtime: "local", harness: "codex", host: "gw.example.com" }, 4);

  const provider = publicUsageLabel(usage.provider);
  const host = publicUsageLabel(usage.host);
  const rows = await db
    .select({
      harness: usage.harness,
      credential: usage.credential,
      provider,
      host,
      totalTokens: sql<number>`sum(${usage.totalTokens})::int`,
      sessions: sql<number>`count(distinct ${usage.sessionId})::int`,
    })
    .from(usage)
    .where(eq(usage.bucketStartAt, new Date("2026-11-28T10:00:00Z")))
    .groupBy(usage.harness, usage.credential, provider, host)
    .orderBy(asc(usage.harness), asc(usage.credential), asc(host));

  assert.deepEqual(rows, [
    { harness: "codex", credential: "user", provider: "o***", host: "gw***om", totalTokens: 4, sessions: 1 },
    { harness: "cohub", credential: "platform", provider: "anthropic", host: null, totalTokens: 15, sessions: 1 },
    { harness: "cohub", credential: "user", provider: "an***ic", host: "ga***om", totalTokens: 7, sessions: 1 },
    { harness: "cohub", credential: "user", provider: "an***ic", host: "ot***om", totalTokens: 3, sessions: 1 },
  ]);
});

test("the Session's current model follows used and running models only", async () => {
  await client.exec(`INSERT INTO v2.session_turns (session_id, space_id, sequence, intent, provider, model, meta, user_content) VALUES
    ('${sessions[1]}', '${space}', 1, 'followup', 'mine', 'own', '{}', '[]'),
    ('${sessions[1]}', '${space}', 2, 'compact', 'cohub', 'summarizer', '{}', '[]'),
    ('${sessions[1]}', '${space}', 3, 'followup', 'gw.example.com', 'opus', '{"harness": "claude"}', '[]'),
    ('${sessions[1]}', '${space}', 4, 'followup', null, null, '{"model": null}', '[]')`);
  await client.exec(`INSERT INTO v2.session_turns (session_id, space_id, sequence, intent, status, meta, user_content) VALUES
    ('${sessions[1]}', '${space}', 5, 'followup', 'cancelled', '{"provider": "cohub", "model": "never-ran"}', '[]'),
    ('${sessions[1]}', '${space}', 6, 'followup', 'queued', '{"provider": "cohub", "model": "may-merge"}', '[]')`);
  assert.deepEqual(await readSessionModel(db, sessions[1]), { provider: "mine", model: "own" });
  await client.exec(`INSERT INTO v2.session_turns (session_id, space_id, sequence, intent, status, meta, user_content) VALUES
    ('${sessions[1]}', '${space}', 7, 'followup', 'running', '{"provider": "cohub", "model": "chat"}', '[]')`);
  assert.deepEqual(await readSessionModel(db, sessions[1]), { provider: "cohub", model: "chat" });
  assert.equal(await readSessionModel(db, sessions[0]), null);
});
