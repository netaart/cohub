import * as z from "zod";
import { contentBlockSchema } from "../core/content-schema.js";
import { localHarnessSchema } from "./harnesses.js";

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
  harness: localHarnessSchema,
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

const messageOrdinal = z.number().int().nonnegative().max(10_000);

/**
 * Final, immutable Turn receipt. Native bytes are archived separately, without lossy normalization.
 * `messages` start at ordinal `from`; earlier ones were staged with `messages` events.
 */
export const nativeTurnCompleteSchema = z.object({
  messages: z.array(nativeTurnMessageSchema).max(10_000),
  from: messageOrdinal.optional(),
  status: z.enum(["completed", "failed", "interrupted"]),
  completedAt: z.iso.datetime(),
}).strict();
export type NativeTurnComplete = z.infer<typeof nativeTurnCompleteSchema>;

/** Stages a registered Turn's messages from ordinal `from`, so no frame has to carry a whole Turn. */
export const nativeTurnMessagesSchema = z.object({
  from: messageOrdinal,
  messages: z.array(nativeTurnMessageSchema).max(10_000),
}).strict();
export type NativeTurnMessages = z.infer<typeof nativeTurnMessagesSchema>;
/** How many messages the Turn holds; a `from` beyond it stages nothing. */
export type NativeTurnMessagesResult = { count: number };

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
  harness: localHarnessSchema,
  nativeSessionId: z.string().min(1).max(255),
  turns: z.array(nativeIngestTurnSchema).min(1).max(NATIVE_INGEST_MAX_TURNS),
}).strict();

/** Which of these Turns the Space already recorded; lets a restart resume without local receipts. */
const nativeKnownSchema = z.object({ turnIds: z.array(id).min(1).max(NATIVE_INGEST_MAX_TURNS) }).strict();

export const APPROVAL_DECISIONS = ["accept", "accept_for_session", "decline"] as const;
export const approvalDecisionSchema = z.enum(APPROVAL_DECISIONS);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

/** What a local Harness asks before acting; shown as a card until decided, withdrawn or expired. */
export const runtimeApprovalSchema = z.object({
  id,
  kind: z.enum(["command", "file_change"]),
  command: z.string().max(16_384).optional(),
  cwd: z.string().max(4096).optional(),
  reason: z.string().max(4096).optional(),
  paths: z.array(z.string().max(4096)).max(100).optional(),
  decisions: z.array(approvalDecisionSchema).min(1).max(APPROVAL_DECISIONS.length),
  requestedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
}).strict();
export type RuntimeApproval = z.infer<typeof runtimeApprovalSchema>;
export type SessionApproval = RuntimeApproval & { turnId: string };

export const nativeRuntimeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ingest"), input: nativeIngestSchema }).strict(),
  z.object({ type: z.literal("known"), input: nativeKnownSchema }).strict(),
  z.object({ type: z.literal("progress"), sessionId: id, turnId: id, progress: nativeTurnProgressSchema }).strict(),
  z.object({ type: z.literal("messages"), sessionId: id, turnId: id, input: nativeTurnMessagesSchema }).strict(),
  z.object({ type: z.literal("status"), sessionId: id, turnId: id, controllable: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("approval"), sessionId: id, turnId: id, approval: runtimeApprovalSchema }).strict(),
  /** The Runtime stopped waiting: decided, timed out, or the Turn ended. */
  z.object({ type: z.literal("approval.closed"), sessionId: id, turnId: id, approvalId: id }).strict(),
]);
export type NativeRuntimeEvent = z.infer<typeof nativeRuntimeEventSchema>;
export type NativeIngest = z.infer<typeof nativeIngestSchema>;

/** Per-Turn outcome of an ingest batch. Unknown Turn ids are absent, never guessed. */
export type NativeIngestResult = { turns: Array<{ turnId: string; sessionId: string; forked: boolean; settled: boolean; created: boolean; changed: boolean }> };
export type NativeKnownResult = { turns: Array<{ turnId: string; sessionId: string; settled: boolean }> };

/** Pushed to the Runtime: stop a running native Turn, as the web's stop button asks. */
export const runtimeNativeStopSchema = z.object({ type: z.literal("runtime.native.stop"), spaceId: id, sessionId: id, turnId: id }).strict();
export type RuntimeNativeStop = z.infer<typeof runtimeNativeStopSchema>;

/** Pushed to the Runtime: a person's answer to an approval card. */
export const runtimeApprovalDecisionSchema = z.object({
  type: z.literal("runtime.approval.decision"), spaceId: id, sessionId: id, turnId: id, approvalId: id, decision: approvalDecisionSchema,
}).strict();
export type RuntimeApprovalDecision = z.infer<typeof runtimeApprovalDecisionSchema>;
/** Every Gateway listens; the one holding the Space's Runtime forwards the decision. */
export const RUNTIME_APPROVAL_CHANNEL = "pubsub:runtime:approval_decision";
export const runtimeApprovalsKey = (spaceId: string, sessionId: string) => `runtime:approvals:${spaceId}:${sessionId}`;

export const NATIVE_SYNC_SOURCE = "native_client" as const;
export const isNativeClientTurn = (meta: unknown): boolean => {
  if (!meta || typeof meta !== "object") return false;
  const value = meta as { source?: unknown; nativeSync?: { version?: unknown; requestDigest?: unknown } };
  return value.source === NATIVE_SYNC_SOURCE && value.nativeSync?.version === 1
    && typeof value.nativeSync.requestDigest === "string" && /^[a-f0-9]{64}$/.test(value.nativeSync.requestDigest);
};
