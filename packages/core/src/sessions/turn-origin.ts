import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sessionTurns, spaceSessions } from "@cohub/db";
import { normalizeRequestSource, type RequestSource } from "@cohub/protocol/provenance";
import { readSessionTurnOrigin, type SessionTurnOrigin, type SessionTurnOriginKind } from "@cohub/protocol/model";

export type OriginTurn = { sessionId: string; spaceId: string; meta: unknown };
type CanViewOrigin = (scope: Pick<OriginTurn, "spaceId" | "sessionId">) => Promise<boolean>;

/** One indexed lookup for agent calls; ordinary user prompts do not query the DB. */
export async function resolveTurnOrigin(
  findTurn: (turnId: string) => Promise<OriginTurn | null>,
  requestSource: RequestSource | null | undefined,
  kind: SessionTurnOriginKind,
  canViewOrigin?: CanViewOrigin,
): Promise<SessionTurnOrigin | null> {
  const source = normalizeRequestSource(requestSource);
  if (!source?.turnId) return null;
  const parent = await findTurn(source.turnId);
  if (!parent || (source.sessionId && source.sessionId !== parent.sessionId) || (source.spaceId && source.spaceId !== parent.spaceId)) return null;
  if (canViewOrigin && !(await canViewOrigin({ spaceId: parent.spaceId, sessionId: parent.sessionId }))) return null;
  const ancestor = readSessionTurnOrigin(parent.meta, parent.spaceId);
  return {
    kind,
    spaceId: parent.spaceId,
    sessionId: parent.sessionId,
    turnId: source.turnId,
    ...(source.toolCallId ? { toolCallId: source.toolCallId } : {}),
    ...(!ancestor ? { depth: 1 } : ancestor.depth != null && ancestor.depth < Number.MAX_SAFE_INTEGER ? { depth: ancestor.depth + 1 } : {}),
  };
}

export const resolveSessionTurnOrigin = (
  db: PostgresJsDatabase<Record<string, unknown>>,
  requestSource: RequestSource | null | undefined,
  kind: SessionTurnOriginKind,
  canViewOrigin?: CanViewOrigin,
): Promise<SessionTurnOrigin | null> => resolveTurnOrigin(async (turnId) => {
  const [parent] = await db.select({ sessionId: sessionTurns.sessionId, spaceId: spaceSessions.spaceId, meta: sessionTurns.meta })
    .from(sessionTurns)
    .innerJoin(spaceSessions, eq(spaceSessions.id, sessionTurns.sessionId))
    .where(eq(sessionTurns.id, turnId))
    .limit(1);
  return parent ?? null;
}, requestSource, kind, canViewOrigin);
