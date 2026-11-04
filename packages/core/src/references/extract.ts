import type { ContentBlock } from "@cohub/protocol/core";
import { isUuidLike } from "@cohub/protocol/identifiers";
import { parseMentions } from "./mentions.js";
import { fileTargetId, normalizeFilePath } from "./paths.js";
import type { ReferenceInput, ReferenceKind } from "./types.js";

/** A turn's worth of content needed to extract references from it. */
export type TurnReferenceSource = {
  spaceId: string;
  sessionId: string;
  turnId: string;
  /** User-authored content (carries @mentions). */
  userContent?: ContentBlock[] | null;
  /** Plain text fallback when structured content is unavailable. */
  userText?: string | null;
  /** Assistant content (carries tool calls). */
  assistantContent?: ContentBlock[] | null;
};

const collectText = (content: ContentBlock[] | null | undefined): string => {
  if (!content) return "";
  return content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/**
 * Read the space/session a tool acted on. Cross-resource tools carry these as
 * explicit UUID fields (camelCase from the SDK, snake_case from raw tool
 * params), so we resolve targets structurally rather than by parsing text.
 */
const readToolTarget = (
  input: Record<string, unknown>,
): { spaceId?: string; sessionId?: string } => {
  const spaceRaw = input.spaceId ?? input.space_id;
  const sessionRaw = input.sessionId ?? input.session_id;
  return {
    spaceId: isUuidLike(spaceRaw) ? (spaceRaw as string) : undefined,
    sessionId: isUuidLike(sessionRaw) ? (sessionRaw as string) : undefined,
  };
};

/** Map a filesystem tool name to its `agent_tool_file_*` reference kind. */
const FILE_TOOL_KINDS: Record<string, ReferenceKind> = {
  read: "agent_tool_file_read",
  write: "agent_tool_file_write",
  edit: "agent_tool_file_edit",
  ls: "agent_tool_file_ls",
  find: "agent_tool_file_find",
  grep: "agent_tool_file_grep",
};

/**
 * Directory-scanning tools treat a missing path as the current working
 * directory, so a bare `ls` still records a workspace-root touch. Content tools
 * (read/write/edit) always carry an explicit path, so a missing one is skipped.
 */
const DIR_TOOL_KINDS = new Set<ReferenceKind>([
  "agent_tool_file_ls",
  "agent_tool_file_find",
  "agent_tool_file_grep",
]);

/**
 * Extract every reference edge carried by a single turn: @mentions in user
 * content, cross-resource tool calls, and filesystem access from path-bearing
 * tools. All edges are sourced at the turn for maximum precision; session/space
 * rollups come from the denormalized ancestry columns.
 *
 * Pure and deterministic: identical input always yields identical output, so it
 * powers both the live double-write and the backfill scan. Turn authorship is
 * not indexed here — that lives on `session_turns.user_uuid`.
 */
export const extractTurnReferences = (turn: TurnReferenceSource): ReferenceInput[] => {
  const references: ReferenceInput[] = [];
  const { spaceId, sessionId, turnId } = turn;

  const source = {
    sourceType: "turn" as const,
    sourceId: turnId,
    sourceSpaceId: spaceId,
    sourceSessionId: sessionId,
  };

  // Mentions: @space / @session links authored in the user's message. Recorded
  // in full, including self-references; consumers filter self-loops if needed.
  const mentionText = collectText(turn.userContent) || turn.userText || "";
  const seenMentions = new Map<string, ReferenceInput>();
  for (const mention of parseMentions(mentionText)) {
    const targetType = mention.type === "app"
      ? ("app" as const)
      : mention.sessionId
        ? ("session" as const)
        : ("space" as const);
    const targetId = mention.type === "app"
      ? `${mention.username}/${mention.spaceSlug}/${mention.appSlug}`
      : mention.sessionId ?? mention.spaceId;
    const key = `${targetType}:${targetId}`;
    const existing = seenMentions.get(key);
    if (existing) {
      existing.count = (existing.count ?? 1) + 1;
      continue;
    }
    const reference: ReferenceInput = {
      ...source,
      kind: "mention",
      targetType,
      targetId,
      count: 1,
      meta: {
        label: mention.label,
        ...(mention.type === "app"
          ? { username: mention.username, spaceSlug: mention.spaceSlug, appSlug: mention.appSlug }
          : mention.sessionId
            ? { targetSpaceId: mention.spaceId }
            : {}),
      },
    };
    seenMentions.set(key, reference);
    references.push(reference);
  }

  // Tool activity: cross-resource actions (target space/session) and filesystem
  // access (target file). Both recorded in full; self-loops are ordinary edges.
  const seenEdges = new Map<string, ReferenceInput>();
  const bump = (key: string, build: () => ReferenceInput) => {
    const existing = seenEdges.get(key);
    if (existing) {
      existing.count = (existing.count ?? 1) + 1;
      return;
    }
    const reference = build();
    seenEdges.set(key, reference);
    references.push(reference);
  };

  for (const block of turn.assistantContent ?? []) {
    if (block.type !== "tool_use") continue;
    const input = block.input as Record<string, unknown>;

    // Filesystem access: path-bearing tools point at a workspace/absolute path.
    const fileKind = FILE_TOOL_KINDS[block.name];
    if (fileKind) {
      const targetSpaceId = readToolTarget(input).spaceId ?? spaceId;
      const rawPath = asString(input.path);
      // Directory tools default a missing path to the working directory.
      const path = normalizeFilePath(rawPath ?? (DIR_TOOL_KINDS.has(fileKind) ? "." : undefined));
      if (path) {
        const targetId = fileTargetId(targetSpaceId, path);
        bump(`${fileKind}|${targetId}`, () => ({
          ...source,
          kind: fileKind,
          targetType: "file",
          targetId,
          count: 1,
          meta: {
            ...(rawPath && rawPath !== path ? { raw: rawPath } : {}),
            ...(targetSpaceId !== spaceId ? { targetSpaceId } : {}),
          },
        }));
      }
      continue;
    }

    // Cross-resource tool calls: prefer a session target, else a space target.
    const { spaceId: toolSpaceId, sessionId: toolSessionId } = readToolTarget(input);
    const targetType = toolSessionId ? ("session" as const) : toolSpaceId ? ("space" as const) : null;
    if (!targetType) continue;
    const targetId = (toolSessionId ?? toolSpaceId) as string;
    bump(`tool_call|${targetType}:${targetId}`, () => ({
      ...source,
      kind: "tool_call",
      targetType,
      targetId,
      count: 1,
      meta: {
        tool: block.name,
        ...(toolSessionId && toolSpaceId ? { targetSpaceId: toolSpaceId } : {}),
      },
    }));
  }

  return references;
};
