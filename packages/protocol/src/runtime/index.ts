import { z } from "zod";
import type { ContentBlock } from "../core/content.js";
import type { Usage } from "../core/usage.js";
import { contentBlockSchema } from "../core/content-schema.js";
import { harnessArchiveSchema, type HarnessArchive } from "./archive.js";
import { nativeRuntimeEventSchema } from "./native.js";
export * from "./archive.js";
export * from "./native.js";
export {
  fingerprintProjectionTurns,
  isProjectionCompaction,
  projectNativeMessageMeta,
  projectNativeSession,
  serializeProjection,
  trimProjectionTurnsToCompaction,
  serializeProjectionRecords,
  type CanonicalProjectionMessage,
  type CanonicalProjectionTurn,
  type NativeProjection,
  type ProjectionCursor,
  type ProjectionInput,
  type ProjectionRecord,
  type ProjectionTarget,
  type ProjectionWarning,
} from "./projection.js";
export { contextToPiMessages, selectRuntimeContextMessages, type ContextProjectionOptions } from "./context.js";

export const RUNTIME_PROTOCOL_VERSION = 1 as const;
export const RUNTIME_MAX_FRAME_BYTES = 32 * 1024 * 1024;
/** One Runtime execution carries at most this many merged inputs and this many input bytes. */
export const RUNTIME_MAX_BATCH_MESSAGES = 64;
export const RUNTIME_MAX_BATCH_INPUT_BYTES = 2 * 1024 * 1024;
export const RUNTIME_RECOVERY_BATCH_SIZE = 64;
export const runtimeRegistrationKey = (spaceId: string) => `runtime:space:${spaceId}`;
export const runtimeWorkspaceKey = (spaceId: string) => `runtime:workspace:${spaceId}`;
export const runtimeWorkspaceSchema = z.object({
  runtimeId: z.string().uuid(),
  connectionId: z.string().uuid(),
  observedAt: z.iso.datetime(),
});
export function runtimeWorkspaceStatus(runtimeId: string | null | undefined, raw: string | null, now = Date.now()): { online: boolean; observedAt: string | null } {
  if (!runtimeId || !raw) return { online: false, observedAt: null };
  try {
    const parsed = runtimeWorkspaceSchema.safeParse(JSON.parse(raw));
    if (parsed.success && parsed.data.runtimeId === runtimeId) {
      const age = now - Date.parse(parsed.data.observedAt);
      return { online: age >= -5000 && age < 60_000, observedAt: parsed.data.observedAt };
    }
  } catch { /* Untrusted telemetry must fail closed. */ }
  return { online: false, observedAt: null };
}
export const harnessSchema = z.enum(["cohub", "pi", "codex"]);
export type HarnessKind = z.infer<typeof harnessSchema>;
export type LocalHarness = Exclude<HarnessKind, "cohub">;
export const isLocalHarness = (value: unknown): value is LocalHarness => value === "pi" || value === "codex";
export const resolveHarness = (meta: unknown): HarnessKind => {
  const value = meta && typeof meta === "object" ? (meta as { harness?: unknown }).harness : null;
  return isLocalHarness(value) ? value : "cohub";
};

export type RuntimeContextMessage = {
  id: string;
  turnId: string;
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  provider?: string | null;
  model?: string | null;
  usage?: Usage | null;
  stopReason?: string | null;
  errorMessage?: string | null;
  meta?: Record<string, unknown> | null;
};

export type RuntimeContext = {
  complete?: boolean;
  revision: string;
  throughTurnId: string | null;
  messages: RuntimeContextMessage[];
  archive?: HarnessArchive | null;
  resolvedTurnIds?: string[];
  settledTurnIds?: string[];
};

/** Trace identifiers carried to a local Runtime without carrying credentials. */
export type RuntimeTraceContext = {
  requestId?: string;
  traceId?: string | null;
  spanId?: string | null;
  traceparent?: string | null;
};

export const runtimeCapabilitiesSchema = z.object({
  harnesses: z.array(z.enum(["pi", "codex"])).min(1).max(2),
  models: z.array(z.object({
    harness: z.enum(["pi", "codex"]),
    provider: z.string().max(100),
    id: z.string().min(1).max(255),
    name: z.string().max(255),
  })).max(2000),
});
export type RuntimeCapabilities = z.infer<typeof runtimeCapabilitiesSchema>;
export const runtimePendingExecutionSchema = z.object({
  sessionId: z.string().uuid(),
  turnId: z.string().uuid(),
  harness: z.enum(["pi", "codex"]),
}).strict();
export type RuntimePendingExecution = z.infer<typeof runtimePendingExecutionSchema>;
export const runtimeRegistrationSchema = z.object({
  connectionId: z.string().uuid(),
  runtimeId: z.string().uuid().optional(),
  endpoint: z.url({ protocol: /^wss?$/ }),
  ownerUserId: z.string().min(1),
  capabilities: runtimeCapabilitiesSchema,
});
export type RuntimeRegistration = z.infer<typeof runtimeRegistrationSchema>;

export function parseRuntimeRegistration(raw: string): RuntimeRegistration | null {
  try { return runtimeRegistrationSchema.parse(JSON.parse(raw)); }
  catch { return null; }
}

export const runtimeReadySchema = z.object({ type: z.literal("runtime.ready"), connectionId: z.string().uuid() });

export type RuntimeExecutionIdentity = { spaceId: string; sessionId: string; turnId: string; harness: LocalHarness };

const runtimeTraceContextSchema = z.object({
  requestId: z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/).optional(),
  traceId: z.string().regex(/^[0-9a-f]{32}$/i).nullable().optional(),
  spanId: z.string().regex(/^[0-9a-f]{16}$/i).nullable().optional(),
  traceparent: z.string().regex(/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i).nullable().optional(),
}).strict();

export type RuntimeRecoveryState = { state: "executing" | "attention" | "confirmed_stopped"; ownerUserId?: string | null; resolvedBy?: string; resolvedAt?: string; reason?: string; detectedAt?: string };
export const fileWatcherStatusSchema = z.object({
  backend: z.enum(["fsevents", "fsnotify", "scan", "none"]),
  state: z.enum(["running", "degraded", "unavailable"]),
  reason: z.enum(["polling", "watch_error", "start_failed", "coverage_incomplete", "root_changed"]).optional(),
  observedAt: z.iso.datetime(),
});
export type RuntimeStatus = {
  kind: "cloud" | "local"; online: boolean; runtimeId?: string | null; capabilities: RuntimeCapabilities | null;
  fileWatcher: z.infer<typeof fileWatcherStatusSchema> | null;
  /** Authoritative file-bridge lease; absent on older servers. */
  workspace?: { online: boolean; observedAt: string | null };
  observedAt?: string;
};
export type RuntimeSessionRecoveryStatus = {
  pending: boolean;
  revision: string;
  turnId: string | null;
  harness: LocalHarness | null;
  canManage: boolean;
};
export const runtimeStopConfirmationSchema = z.object({ expectedTurnId: z.string().uuid(), revision: z.string().min(1), confirmed: z.literal(true) }).strict();
export type RuntimeStopConfirmation = z.infer<typeof runtimeStopConfirmationSchema>;

export type RuntimeTurnUserMessage = {
  turnId: string;
  userMessageId: string;
  userId: string | null;
  content: ContentBlock[];
};

export type RuntimeTurnInput = {
  spaceId: string;
  sessionId: string;
  turnId: string;
  userMessageId: string;
  harness: LocalHarness;
  /** Ordered claim inputs. The final message owns execution, streaming and archival. */
  messages: RuntimeTurnUserMessage[];
  context: RuntimeContext;
  provider?: string | null;
  model?: string | null;
  thinkingLevel?: string | null;
  requestId?: string | null;
  traceContext?: RuntimeTraceContext;
  accessMode: "read_only" | "full_access";
};

export type RuntimeMessage = {
  ordinal: number;
  content: ContentBlock[];
  provider?: string | null;
  model?: string | null;
  usage?: Usage | null;
  stopReason?: string | null;
  errorMessage?: string | null;
};

export type RuntimeExecutionEvent =
  | { type: "message.start"; ordinal: number }
  | { type: "text.delta"; ordinal: number; index: number; kind: "text" | "thinking"; delta: string }
  | { type: "content.replace"; ordinal: number; content: ContentBlock[] }
  | { type: "message.commit"; message: RuntimeMessage }
  | { type: "turn.end"; message: RuntimeMessage; archive?: HarnessArchive | null; resume: "native" | "restored" | "handoff" | "new" }
  | { type: "context.required"; pendingTurnIds?: string[] }
  | { type: "turn.acknowledged" }
  | { type: "turn.error"; message: string; uncertain?: boolean };

const id = z.string().uuid();
const ordinal = z.number().int().min(0).max(100_000);
const content = z.array(contentBlockSchema).max(100_000);
const count = z.number().finite().nonnegative().optional();
const usageSchema = z.object({ input: count, output: count, cacheRead: count, cacheWrite: count, totalTokens: count,
  cost: z.object({ input: count, output: count, cacheRead: count, cacheWrite: count, total: count }).nullable().optional(),
});
const runtimeMessageSchema = z.object({
  ordinal,
  content,
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  usage: usageSchema.nullable().optional(),
  stopReason: z.string().max(64).nullable().optional(),
  errorMessage: z.string().max(16_384).nullable().optional(),
});
export const runtimeEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message.start"), ordinal }),
  z.object({ type: z.literal("text.delta"), ordinal, index: ordinal, kind: z.enum(["text", "thinking"]), delta: z.string() }),
  z.object({ type: z.literal("content.replace"), ordinal, content }),
  z.object({ type: z.literal("message.commit"), message: runtimeMessageSchema }),
  z.object({ type: z.literal("turn.end"), message: runtimeMessageSchema, archive: harnessArchiveSchema.nullable().optional(), resume: z.enum(["native", "restored", "handoff", "new"]) }),
  z.object({ type: z.literal("context.required"), pendingTurnIds: z.array(id).max(2).optional() }),
  z.object({ type: z.literal("turn.acknowledged") }),
  z.object({ type: z.literal("turn.error"), message: z.string().max(16_384), uncertain: z.boolean().optional() }),
]);
export const runtimeClientFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("runtime.hello"), version: z.literal(RUNTIME_PROTOCOL_VERSION), spaceId: id, token: z.string().min(1).max(16_384), capabilities: runtimeCapabilitiesSchema }).strict(),
  z.object({ type: z.literal("runtime.recovery"), executions: z.array(runtimePendingExecutionSchema).min(1).max(RUNTIME_RECOVERY_BATCH_SIZE) }).strict(),
  z.object({ type: z.literal("runtime.heartbeat") }),
  z.object({ type: z.literal("runtime.auth"), token: z.string().min(1).max(16_384) }),
  z.object({ type: z.literal("runtime.event"), requestId: id, event: runtimeEventSchema }),
  z.object({ type: z.literal("runtime.native"), requestId: id, event: nativeRuntimeEventSchema }),
]);
export type RuntimeClientFrame = z.infer<typeof runtimeClientFrameSchema>;
export const runtimeNativeResultSchema = z.object({ type: z.literal("runtime.native.result"), requestId: id, result: z.unknown(), error: z.string().optional() }).strict();

const runtimeContextSchema = z.object({ complete: z.boolean().optional(), revision: z.string(), throughTurnId: id.nullable(), messages: z.array(z.object({
  id: z.string(), turnId: id, role: z.enum(["user", "assistant", "system"]), content,
  provider: z.string().nullable().optional(), model: z.string().nullable().optional(), usage: usageSchema.nullable().optional(),
  stopReason: z.string().nullable().optional(), errorMessage: z.string().nullable().optional(), meta: z.record(z.string(), z.unknown()).nullable().optional(),
})), archive: harnessArchiveSchema.nullable().optional(), resolvedTurnIds: z.array(id).max(2).optional(), settledTurnIds: z.array(id).max(2).optional() });

export const runtimeCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn.recover"), requestId: id, execution: z.object({ spaceId: id, sessionId: id, turnId: id, harness: z.enum(["pi", "codex"]) }), traceContext: runtimeTraceContextSchema.optional() }),
  z.object({ type: z.literal("turn.start"), requestId: id, resumeOnly: z.boolean().optional(), input: z.object({
    spaceId: id, sessionId: id, turnId: id, userMessageId: id, harness: z.enum(["pi", "codex"]),
    messages: z.array(z.object({ turnId: id, userMessageId: id, userId: z.string().nullable(), content })).min(1).max(RUNTIME_MAX_BATCH_MESSAGES),
    context: runtimeContextSchema,
    provider: z.string().nullable().optional(), model: z.string().nullable().optional(), thinkingLevel: z.string().nullable().optional(),
    requestId: z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/).nullable().optional(),
    traceContext: runtimeTraceContextSchema.optional(),
    accessMode: z.enum(["read_only", "full_access"]),
  }).refine((input) => {
    const owner = input.messages.at(-1);
    return owner?.turnId === input.turnId && owner.userMessageId === input.userMessageId
      && new Set(input.messages.map((message) => message.turnId)).size === input.messages.length
      && new Set(input.messages.map((message) => message.userMessageId)).size === input.messages.length;
  }, "Runtime batch owner or message identity mismatch") }),
  z.object({ type: z.literal("session.context"), requestId: id, context: runtimeContextSchema }),
  z.object({ type: z.literal("turn.abort"), requestId: id }),
  z.object({ type: z.literal("turn.ack"), requestId: id, revision: z.string(), turnId: id }),
]);
export type RuntimeCommand = z.infer<typeof runtimeCommandSchema>;
