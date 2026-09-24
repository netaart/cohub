import {
  mergeRequestSourceIntoMeta,
  parseRequestSourceFromHeaders,
  REQUEST_SOURCE_VIA_MAX_LENGTH,
  resolveRequestSourceChannel,
  stripControlChars,
  type RequestSource,
} from "@cohub/protocol/provenance";
import type { Context, MiddlewareHandler } from "hono";
import { readRuntimeRecovery } from "@cohub/core/sessions";
import { getSessionRuntimeTurn } from "../runtime.js";

export const getRequestSource = (c: Context): RequestSource | null =>
  (c.get("requestSource") as RequestSource | null | undefined) ?? parseRequestSourceFromHeaders((name) => c.req.header(name));

/**
 * A long-lived local harness (a terminal Pi, a shared Codex server) runs many Turns in one process,
 * so its tools can name their Session but not the Turn.
 */
export const resolveRequestSourceTurn: MiddlewareHandler = async (c, next) => {
  const source = parseRequestSourceFromHeaders((name) => c.req.header(name));
  const principal = c.get("principal") as { type: string; user?: { uuid: string } } | null | undefined;
  if (source?.spaceId && source.sessionId && !source.turnId && principal?.type === "user" && principal.user) {
    const turn = await getSessionRuntimeTurn(source.spaceId, source.sessionId).catch(() => null);
    const owner = turn ? readRuntimeRecovery(turn.meta)?.ownerUserId ?? turn.userUuid : null;
    if (turn && owner === principal.user.uuid) c.set("requestSource", { ...source, turnId: turn.id });
  }
  await next();
};

/** body.source > header via > fallback. Display-only, not auth. */
export const resolveSessionSourceFromRequest = (
  c: Context,
  bodySource?: string | null,
  fallback = "public_api",
): string => {
  const explicit =
    typeof bodySource === "string" ? stripControlChars(bodySource).trim() : "";
  if (explicit) return explicit.slice(0, REQUEST_SOURCE_VIA_MAX_LENGTH);
  return resolveRequestSourceChannel(getRequestSource(c), fallback);
};

/** Stamp header identity onto meta.source; drop body source. */
export const applyRequestSourceToMeta = (
  c: Context,
  meta: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null =>
  mergeRequestSourceIntoMeta(meta, getRequestSource(c));
