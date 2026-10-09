import { z } from "zod";
import { contentBlockSchema } from "../core/content-schema.js";

const id = z.uuid();
const content = z.array(contentBlockSchema).max(10_000);
const count = z.number().finite().nonnegative().optional();
const usage = z.object({
  input: count, output: count, cacheRead: count, cacheWrite: count, totalTokens: count,
  cost: z.object({ input: count, output: count, cacheRead: count, cacheWrite: count, total: count }).nullable().optional(),
});
const nativeOrigin = z.enum(["local_import"]);

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
  sessionStartedAt: z.iso.datetime().optional(),
  origin: nativeOrigin.optional(),
  controllable: z.boolean().optional(),
}).strict().refine((value) => value.sessionId !== null || value.parentTurnId === null, "A parent Turn requires a Session");
export type NativeTurnStart = z.infer<typeof nativeTurnStartSchema>;
export type NativeTurnBinding = { sessionId: string; turnId: string; forked: boolean };
export type NativeOrigin = z.infer<typeof nativeOrigin>;

export const nativeTurnMessageSchema = z.object({
  content,
  provider: z.string().max(100).nullable().optional(),
  model: z.string().max(255).nullable().optional(),
  usage: usage.nullable().optional(),
  stopReason: z.string().max(64).nullable().optional(),
  errorMessage: z.string().max(16_384).nullable().optional(),
}).strict();
export type NativeTurnMessage = z.infer<typeof nativeTurnMessageSchema>;

/** Ephemeral display state within a Turn; never a fork or persistence boundary. */
export const nativeTurnProgressSchema = z.object({
  revision: z.number().int().safe().positive(),
  from: z.number().int().nonnegative().max(10_000).optional(),
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

/** Durable ingest of one transcript's Turns. */
export const nativeIngestTurnSchema = z.object({
  turnId: id,
  parentTurnId: id.nullable(),
  userContent: content,
  startedAt: z.iso.datetime(),
  origin: nativeOrigin.optional(),
  result: nativeTurnCompleteSchema.nullable(),
  controllable: z.boolean().optional(),
}).strict();
export type NativeIngestTurn = z.infer<typeof nativeIngestTurnSchema>;

/** Turn states that end a Turn; a native Turn in one of them is settled on both sides. */
export const SETTLED_TURN_STATUSES = ["completed", "failed", "interrupted", "cancelled", "merged"] as const;

/** How many Turns one ingest may carry; a larger backlog is sent as consecutive batches. */
export const NATIVE_INGEST_MAX_TURNS = 500;

const nativeIngestSchema = z.object({
  harness: z.enum(["pi", "codex"]),
  nativeSessionId: z.string().min(1).max(255),
  turns: z.array(nativeIngestTurnSchema).min(1).max(NATIVE_INGEST_MAX_TURNS),
}).strict();

/** Which of these Turns the Space already recorded; lets a restart resume without local receipts. */
const nativeKnownSchema = z.object({ turnIds: z.array(id).min(1).max(NATIVE_INGEST_MAX_TURNS) }).strict();

export const nativeRuntimeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ingest"), input: nativeIngestSchema }).strict(),
  z.object({ type: z.literal("known"), input: nativeKnownSchema }).strict(),
  z.object({ type: z.literal("progress"), sessionId: id, turnId: id, progress: nativeTurnProgressSchema }).strict(),
  z.object({ type: z.literal("status"), sessionId: id, turnId: id, controllable: z.boolean().optional() }).strict(),
]);
export type NativeRuntimeEvent = z.infer<typeof nativeRuntimeEventSchema>;
export type NativeIngest = z.infer<typeof nativeIngestSchema>;

/** Per-Turn outcome of an ingest batch. Unknown Turn ids are absent, never guessed. */
export type NativeIngestResult = { turns: Array<{ turnId: string; sessionId: string; forked: boolean; settled: boolean; created: boolean; changed: boolean }> };
export type NativeKnownResult = { turns: Array<{ turnId: string; sessionId: string; settled: boolean }> };

/** Every Turn stop request is published here. */
export const AGENT_TURN_ABORT_CHANNEL = "pubsub:agent:turn_abort";
/** Pushed to the Runtime: stop a running native Turn, as the web's stop button asks. */
export const runtimeNativeStopSchema = z.object({ type: z.literal("runtime.native.stop"), spaceId: id, sessionId: id, turnId: id }).strict();
export type RuntimeNativeStop = z.infer<typeof runtimeNativeStopSchema>;

export const NATIVE_SYNC_SOURCE = "native_client" as const;
export const isNativeClientTurn = (meta: unknown): boolean => {
  if (!meta || typeof meta !== "object") return false;
  const value = meta as { source?: unknown; nativeSync?: { version?: unknown; requestDigest?: unknown } };
  return value.source === NATIVE_SYNC_SOURCE && value.nativeSync?.version === 1
    && typeof value.nativeSync.requestDigest === "string" && /^[a-f0-9]{64}$/.test(value.nativeSync.requestDigest);
};
