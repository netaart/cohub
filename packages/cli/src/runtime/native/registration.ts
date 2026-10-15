import { createHash } from "node:crypto";
import { nativeIngestTurnSchema, NATIVE_SYNC_SOURCE, type ContentBlock, type NativeIngestTurn } from "@neta-art/cohub";
import type { SessionTurnProjectionClient } from "../turn-projection.js";
import { nativeStableId } from "./identity.js";

export type NativeRegistration = { turn: unknown; parent: unknown | null };
export type RegistrationDiagnostic = { turnId: string; sessionId: string; requestDigest: string; localSha256: string; registeredSha256: string; localBytes: number; registeredBytes: number };
type ExpectedRegistration = { spaceId: string; sessionId: string; harness: "pi" | "codex"; nativeSessionId: string } & Pick<NativeIngestTurn, "turnId" | "parentTurnId" | "startedAt" | "userContent" | "origin">;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Native registration identity mismatch: invalid record");
  return value as Record<string, unknown>;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const owningSession = (turn: Record<string, unknown>) => turn.sourceSessionId ?? turn.sessionId;
const sourceTurn = (turn: Record<string, unknown>) => turn.sourceTurnId ?? turn.id;

/** Read the registered Turn and its actual parent, with the same scoped SDK used for projection. */
export async function readRegistration(source: SessionTurnProjectionClient, sessionId: string, turnId: string, options?: { signal?: AbortSignal }): Promise<NativeRegistration> {
  const deadline = AbortSignal.timeout(30_000);
  const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const request = { signal };
  signal.throwIfAborted();
  const { turn } = await source.session(sessionId).turns.get(turnId, request);
  const receipt = record(record(turn.meta).nativeSync);
  if (receipt.parentTurnId !== null && typeof receipt.parentTurnId !== "string") throw new Error("Native registration identity mismatch: invalid parent");
  signal.throwIfAborted();
  const parent = receipt.parentTurnId === null ? null : (await source.session(sessionId).turns.get(receipt.parentTurnId as string, request)).turn;
  signal.throwIfAborted();
  return { turn, parent };
}

/** A changed parser may recover a registered prompt, never another Turn or a changed identity. */
export function restoreRegistration(snapshot: NativeRegistration, expected: ExpectedRegistration): { userContent: ContentBlock[]; diagnostic: RegistrationDiagnostic | null } {
  const turn = record(snapshot.turn), meta = record(turn.meta), receipt = record(meta.nativeSync);
  const startedAt = receipt.originalStartedAt === undefined ? turn.startedAt : receipt.originalStartedAt;
  if (sourceTurn(turn) !== expected.turnId || owningSession(turn) !== expected.sessionId || meta.source !== NATIVE_SYNC_SOURCE || meta.harness !== expected.harness
    || receipt.version !== 1 || receipt.spaceId !== expected.spaceId || receipt.nativeSessionId !== expected.nativeSessionId
    || receipt.parentTurnId !== expected.parentTurnId || startedAt !== expected.startedAt || receipt.origin !== expected.origin) {
    throw new Error("Native registration identity mismatch: registered fields differ");
  }
  let parentSessionId: string | null = null;
  if (expected.parentTurnId !== null) {
    const parent = record(snapshot.parent);
    const parentSession = owningSession(parent);
    if (sourceTurn(parent) !== expected.parentTurnId || typeof parentSession !== "string" || !parentSession) throw new Error("Native registration identity mismatch: parent differs");
    parentSessionId = parentSession;
  } else if (snapshot.parent !== null) throw new Error("Native registration identity mismatch: unexpected parent");
  const canonical = (userContent: unknown) => nativeIngestTurnSchema.parse({ turnId: expected.turnId, parentTurnId: expected.parentTurnId, userContent, startedAt, ...(expected.origin ? { origin: expected.origin } : {}), result: null }).userContent;
  const local = canonical(expected.userContent), registered = canonical(turn.userContent);
  const requestDigest = (userContent: ContentBlock[]) => digest({
    turnId: expected.turnId, sessionId: parentSessionId, parentTurnId: expected.parentTurnId,
    branchSessionId: nativeStableId(JSON.stringify([expected.turnId, "branch"])), harness: expected.harness,
    nativeSessionId: expected.nativeSessionId, userContent, startedAt,
    ...(expected.origin ? { origin: expected.origin } : {}),
  });
  // Storage sanitizes text and reorders arbitrary JSON keys after hashing the request.
  // Prefer the original local bytes; schema normalization only restores fixed field order.
  if (requestDigest(local) === receipt.requestDigest) return { userContent: local, diagnostic: null };
  if (typeof receipt.requestDigest !== "string" || requestDigest(registered) !== receipt.requestDigest) throw new Error("Native registration digest mismatch: neither prompt matches the receipt");
  return { userContent: registered, diagnostic: {
    turnId: expected.turnId, sessionId: expected.sessionId, requestDigest: receipt.requestDigest, localSha256: digest(local), registeredSha256: digest(registered),
    localBytes: Buffer.byteLength(JSON.stringify(local)), registeredBytes: Buffer.byteLength(JSON.stringify(registered)),
  } };
}
