import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { sessionTurns } from "@cohub/db";
import type { RequestMetric } from "@cohub/protocol/model";
import { db } from "./db.js";
import { logger } from "./logger.js";

/** Namespaced, idempotent receipts: retries and replies share no accounting identity.
 * This is observational only; an unavailable metrics write never fails execution. */
export async function persistRequestMetric(turnId: string | undefined, request: RequestMetric) {
  if (!turnId) return;
  try {
    await db.update(sessionTurns).set({
      meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || jsonb_build_object('metrics',
        coalesce(${sessionTurns.meta}->'metrics', '{}'::jsonb) || jsonb_build_object('version', 1, 'requests',
          coalesce(${sessionTurns.meta}->'metrics'->'requests', '{}'::jsonb) || jsonb_build_object(${request.id}::text, ${JSON.stringify(request)}::jsonb)))`,
    }).where(eq(sessionTurns.id, turnId));
  } catch (error) {
    logger.warn("[Metrics] failed to persist request receipt", { turnId, requestId: request.id, error });
  }
}

export function createRequestMetric(provider: string, model: string): RequestMetric {
  return { id: randomUUID(), provider, model, startedAt: Date.now(), status: "running" };
}

export async function recordRetryWait(turnId: string | undefined, durationMs: number) {
  if (!turnId) return;
  try {
    await db.update(sessionTurns).set({
      meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || jsonb_build_object('metrics',
        coalesce(${sessionTurns.meta}->'metrics', '{}'::jsonb) || jsonb_build_object('version', 1,
          'retryCount', coalesce((${sessionTurns.meta}->'metrics'->>'retryCount')::int, 0) + 1,
          'retryWaitMs', coalesce((${sessionTurns.meta}->'metrics'->>'retryWaitMs')::double precision, 0) + ${durationMs}))`,
    }).where(eq(sessionTurns.id, turnId));
  } catch (error) {
    logger.warn("[Metrics] failed to persist retry wait", { turnId, error });
  }
}
