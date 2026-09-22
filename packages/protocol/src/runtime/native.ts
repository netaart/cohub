import { z } from "zod";
import { contentBlockSchema } from "../core/content-schema.js";

const id = z.uuid();
const content = z.array(contentBlockSchema).max(10_000);
const count = z.number().finite().nonnegative().optional();
const usage = z.object({
  input: count, output: count, cacheRead: count, cacheWrite: count, totalTokens: count,
  cost: z.object({ input: count, output: count, cacheRead: count, cacheWrite: count, total: count }).nullable().optional(),
});

/** One native execution maps to one Cohub Turn. No message-level fork anchors. */
export const nativeTurnStartSchema = z.object({
  turnId: id,
  sessionId: id.nullable(),
  parentTurnId: id.nullable(),
  branchSessionId: id,
  harness: z.enum(["pi", "codex"]),
  nativeSessionId: z.string().min(1).max(255),
  userContent: content,
  startedAt: z.iso.datetime(),
}).strict().refine((value) => value.sessionId !== null || value.parentTurnId === null, "A parent Turn requires a Session");
export type NativeTurnStart = z.infer<typeof nativeTurnStartSchema>;
export type NativeTurnBinding = { sessionId: string; turnId: string; forked: boolean };

export const nativeTurnMessageSchema = z.object({
  content,
  provider: z.string().max(100).nullable().optional(),
  model: z.string().max(255).nullable().optional(),
  usage: usage.nullable().optional(),
  stopReason: z.string().max(64).nullable().optional(),
  errorMessage: z.string().max(16_384).nullable().optional(),
}).strict();
export type NativeTurnMessage = z.infer<typeof nativeTurnMessageSchema>;

/** Ephemeral display snapshot within a Turn; never a fork or persistence boundary. */
export const nativeTurnProgressSchema = z.object({
  revision: z.number().int().safe().positive(),
  messages: z.array(nativeTurnMessageSchema).max(10_000),
}).strict();
export type NativeTurnProgress = z.infer<typeof nativeTurnProgressSchema>;

/** Final, immutable Turn receipt. Native bytes are archived separately, without lossy normalization. */
export const nativeTurnCompleteSchema = z.object({
  messages: z.array(nativeTurnMessageSchema).max(10_000),
  status: z.enum(["completed", "failed", "interrupted"]),
  completedAt: z.iso.datetime(),
}).strict();
export type NativeTurnComplete = z.infer<typeof nativeTurnCompleteSchema>;

export const nativeRuntimeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), input: nativeTurnStartSchema }).strict(),
  z.object({ type: z.literal("progress"), sessionId: id, turnId: id, progress: nativeTurnProgressSchema }).strict(),
  z.object({ type: z.literal("complete"), sessionId: id, turnId: id, result: nativeTurnCompleteSchema }).strict(),
  z.object({ type: z.literal("heartbeat"), sessionId: id, turnId: id }).strict(),
]);
export type NativeRuntimeEvent = z.infer<typeof nativeRuntimeEventSchema>;

export const NATIVE_SYNC_SOURCE = "native_client" as const;
export const isNativeClientTurn = (meta: unknown): boolean => {
  if (!meta || typeof meta !== "object") return false;
  const value = meta as { source?: unknown; nativeSync?: { version?: unknown; requestDigest?: unknown } };
  return value.source === NATIVE_SYNC_SOURCE && value.nativeSync?.version === 1
    && typeof value.nativeSync.requestDigest === "string" && /^[a-f0-9]{64}$/.test(value.nativeSync.requestDigest);
};
