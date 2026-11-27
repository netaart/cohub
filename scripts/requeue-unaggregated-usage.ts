import "dotenv/config";
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: "apps/api/.env", override: false });

import { sessionMessages, sessionTurns, spaceSessions } from "@cohub/db";
import { isLlmUsageMessage } from "@cohub/protocol";
import { SETTLED_TURN_STATUSES } from "@cohub/protocol/model";
import { and, eq, gte, inArray, isNull, lt, not, or, sql } from "drizzle-orm";

// Re-enqueue LLM messages whose usage was never aggregated (the job is idempotent).
// Cloud messages before --since predate usage_aggregated_at and would be billed again; local ones are never billed.
// pnpm tsx scripts/requeue-unaggregated-usage.ts --since ISO [--write]

const SETTLE_MS = 10 * 60_000;

function parseArgs(argv: string[]) {
  let since: Date | null = null;
  let write = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") write = true;
    else if (arg === "--since") since = new Date(argv[++index] ?? "");
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!since || !Number.isFinite(since.getTime())) throw new Error("--since must be an ISO 8601 time");
  return { since, write };
}

async function main() {
  const { since, write } = parseArgs(process.argv.slice(2).filter((arg) => arg !== "--"));
  // Loaded after dotenv: these modules read env at import.
  const { db } = await import("../apps/api/src/db/index.js");
  const enqueue = write ? (await import("../apps/api/src/session-message-postprocess-queue.js")).enqueueSessionMessagePostprocess : null;
  console.log(`[requeue-unaggregated-usage] ${write ? "WRITE" : "DRY RUN"} sessions active since ${since.toISOString()}`);

  const sessions = await db
    .select({ id: spaceSessions.id })
    .from(spaceSessions)
    .where(or(gte(spaceSessions.updatedAt, since), gte(spaceSessions.lastMessageAt, since)));
  const settledBefore = new Date(Date.now() - SETTLE_MS);
  const local = sql`coalesce(${sessionMessages.meta}->>'runtime' = 'local', false)`;
  let found = 0;
  for (const session of sessions) {
    const messages = await db
      .select({ id: sessionMessages.id, role: sessionMessages.role, meta: sessionMessages.meta })
      .from(sessionMessages)
      .leftJoin(sessionTurns, eq(sessionTurns.id, sessionMessages.turnId))
      .where(and(
        eq(sessionMessages.sessionId, session.id),
        isNull(sessionMessages.usageAggregatedAt),
        lt(sessionMessages.createdAt, settledBefore),
        or(gte(sessionMessages.createdAt, since), local),
        or(not(local), isNull(sessionMessages.turnId), inArray(sessionTurns.status, [...SETTLED_TURN_STATUSES])),
      ));
    for (const message of messages.filter(isLlmUsageMessage)) {
      found += 1;
      if (enqueue) await enqueue({ sessionId: session.id, message });
      else console.log(`  would enqueue session=${session.id} message=${message.id}`);
    }
  }
  console.log(`[requeue-unaggregated-usage] sessions=${sessions.length} messages=${found}${write ? " enqueued" : ""}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
