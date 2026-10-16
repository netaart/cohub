import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { spaceSessions } from "@cohub/db";

export async function lockPromptSession(
  tx: Pick<PostgresJsDatabase<Record<string, unknown>>, "select">,
  input: { spaceId: string; sessionId: string },
) {
  const [session] = await tx
    .select({ meta: spaceSessions.meta, spaceId: spaceSessions.spaceId })
    .from(spaceSessions)
    .where(and(eq(spaceSessions.id, input.sessionId), eq(spaceSessions.spaceId, input.spaceId)))
    .for("update")
    .limit(1);
  if (!session) throw new Error("session not found");
  return session;
}
