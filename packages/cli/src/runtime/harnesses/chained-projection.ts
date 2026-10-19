import { createHash } from "node:crypto";
import {
  fingerprintProjectionTurns, isProjectionCompaction, isProjectionPendingGeneration, projectNativeMessageMeta, trimProjectionTurnsToCompaction,
  type CanonicalProjectionMessage, type ContentBlock, type LocalHarness, type NativeProjection, type ProjectionInput, type ProjectionRecord, type ProjectionWarning,
} from "@neta-art/cohub";

type ToolResult = Extract<ContentBlock, { type: "tool_result" }>;
type Segment = { role: "user" | "assistant"; blocks: ContentBlock[] };

/** Deterministic, UUID-shaped record ids keep re-projection stable without local state. */
export function projectionUuid(key: string) {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Provider APIs restrict tool ids; hashing keeps call/result pairs linked. */
export function projectionToolId(id: string) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : `call_${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

const nonEmpty = (block: ContentBlock) => block.type !== "text" || block.text.length > 0;

/**
 * Splits Cohub messages into alternating native records. A tool call is kept only with its result,
 * because provider APIs reject unpaired calls; dropped content is reported as a projection warning.
 */
function segments(message: CanonicalProjectionMessage, warnings: ProjectionWarning[]): Segment[] {
  const warn = (reason: string) => warnings.push({ sourceMessageId: message.id, sourceTurnId: message.turnId, reason });
  if (message.content.some((block) => block.type === "image" && block.source.type === "url")) warn("external image URL omitted from native projection");
  const visible = message.content.filter((block) => nonEmpty(block) && !(block.type === "image" && block.source.type === "url"));
  if (message.role === "user") {
    const blocks = visible.filter((block) => block.type === "text" || block.type === "image");
    return blocks.length ? [{ role: "user", blocks }] : [];
  }
  const raw: Segment[] = [];
  for (const block of visible) {
    const role = block.type === "tool_result" ? "user" : "assistant";
    if (role === "assistant" && !["text", "tool_use"].includes(block.type)) continue;
    const last = raw.at(-1);
    if (last?.role === role) last.blocks.push(block);
    else raw.push({ role, blocks: [block] });
  }
  const paired: Segment[] = [];
  raw.forEach((segment, index) => {
    if (segment.role === "assistant") {
      const results = new Set(raw[index + 1]?.role === "user" ? raw[index + 1]?.blocks.flatMap((block) => block.type === "tool_result" ? [block.tool_use_id] : []) : []);
      const blocks = segment.blocks.filter((block) => block.type !== "tool_use" || results.has(block.id));
      if (blocks.length !== segment.blocks.length) warn("tool call without a result omitted from native projection");
      if (blocks.length) paired.push({ role: "assistant", blocks });
    } else {
      const calls = new Set(raw[index - 1]?.role === "assistant" ? raw[index - 1]?.blocks.flatMap((block) => block.type === "tool_use" ? [block.id] : []) : []);
      const blocks = segment.blocks.filter((block) => block.type === "tool_result" && calls.has(block.tool_use_id));
      if (blocks.length !== segment.blocks.length) warn("tool result without a call omitted from native projection");
      if (blocks.length) paired.push({ role: "user", blocks });
    }
  });
  return paired;
}

const compactionText = (message: CanonicalProjectionMessage) => message.content.flatMap((block) => block.type === "system_note" ? [block.text] : []).join("\n");

export type ProjectedSegment = {
  role: "user" | "assistant";
  blocks: ContentBlock[];
  message: CanonicalProjectionMessage;
  compactSummary: boolean;
};

/**
 * Shared walk for transcript formats whose records form a parent-linked chain. `write` maps one
 * user/assistant segment to native records; ids and parent links are assigned here.
 */
export function projectChainedSession(
  input: ProjectionInput,
  target: LocalHarness,
  fields: { id: string; parent: string },
  write: (segment: ProjectedSegment) => Record<string, unknown>[],
): NativeProjection {
  const warnings: ProjectionWarning[] = [];
  const records: ProjectionRecord[] = [];
  let parentId: string | null = null;
  for (const turn of trimProjectionTurnsToCompaction(input.turns)) {
    for (const message of turn.messages) {
      if (isProjectionPendingGeneration(message)) continue;
      const parts: Array<Omit<ProjectedSegment, "message">> = isProjectionCompaction(message)
        ? compactionText(message) ? [{ role: "user", blocks: [{ type: "text", text: compactionText(message) }], compactSummary: true }] : []
        : message.role === "system" ? [] : segments(message, warnings).map((segment) => ({ ...segment, compactSummary: false }));
      let ordinal = 0;
      for (const part of parts) {
        for (const native of write({ ...part, message })) {
          const key = `${message.id}:${message.turnId}:${ordinal++}`;
          const id = projectionUuid(`${input.sessionId}:${key}`);
          records.push({ key, sourceTurnId: message.turnId, sourceMessageId: message.id, record: { [fields.parent]: parentId, [fields.id]: id, ...native } });
          parentId = id;
        }
      }
    }
  }
  const last = input.turns.at(-1);
  return { target, records, cursor: { sourceSequence: last?.sequence ?? null, sourceTurnId: last?.sourceTurnId ?? null, sourceFingerprint: fingerprintProjectionTurns(input.turns) }, warnings };
}

export const projectionMeta = (input: ProjectionInput, message: CanonicalProjectionMessage) => ({
  schema: "cohub.projection.v2", spaceId: input.spaceId, sessionId: input.sessionId, ...projectNativeMessageMeta(message),
});

export const toolResultText = (block: ToolResult) => typeof block.content === "string"
  ? block.content
  : block.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");

/** Session id is stored on every record of these formats. */
export const rebindSessionId = (records: ProjectionRecord[], nativeSessionId: string) =>
  records.map((entry) => ({ ...entry, record: { ...entry.record, sessionId: nativeSessionId } }));
