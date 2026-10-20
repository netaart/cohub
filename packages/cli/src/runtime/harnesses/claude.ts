import { homedir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, NativeProjection } from "@neta-art/cohub";
import { copyNativeArchive } from "../native/archive.js";
import { projectChainedSession, projectionMeta, projectionToolId, rebindSessionId } from "./chained-projection.js";
import { DEFAULT_MODEL, runStreamJson, streamJsonHelp, streamJsonModel, type StreamJsonProfile } from "./stream-json.js";
import type { LocalHarnessAdapter } from "./types.js";

const MAX_PROJECT_NAME = 200;
const dataRoot = () => process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");

/**
 * Claude Code names a project directory by replacing every non-alphanumeric UTF-16 unit; a longer
 * name keeps its first 200 units and appends the base-36 Java string hash of the path.
 */
export function claudeProjectName(cwd: string) {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= MAX_PROJECT_NAME) return name;
  let hash = 0;
  for (let index = 0; index < cwd.length; index++) hash = (hash * 31 + cwd.charCodeAt(index)) | 0;
  return `${name.slice(0, MAX_PROJECT_NAME)}-${Math.abs(hash).toString(36)}`;
}
export const claudeProjectDirectory = (cwd: string) => join(dataRoot(), "projects", claudeProjectName(cwd));

const profile: StreamJsonProfile = {
  harness: "claude",
  label: "Claude Code",
  binary: "claude",
  provider: "anthropic",
  dataRoot,
  projectDirectory: claudeProjectDirectory,
  effortLevels: ["low", "medium", "high", "xhigh", "max"],
};

function anthropicBlock(block: ContentBlock): Record<string, unknown> | null {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "image" && block.source.type === "base64") return { type: "image", source: { type: "base64", media_type: block.source.media_type, data: block.source.data } };
  if (block.type === "tool_use") return { type: "tool_use", id: projectionToolId(block.id), name: block.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128) || "tool", input: block.input };
  if (block.type === "tool_result") {
    const content = typeof block.content === "string" ? block.content : block.content.map(anthropicBlock).filter((item) => item !== null);
    return { type: "tool_result", tool_use_id: projectionToolId(block.tool_use_id), content, is_error: block.is_error ?? false };
  }
  return null;
}

/** Claude Code merges consecutive assistant records sharing a message id; each projected call gets its own. */
function withAssistantIds(projection: NativeProjection): NativeProjection {
  return { ...projection, records: projection.records.map((entry) => entry.record.type !== "assistant" ? entry : {
    ...entry, record: { ...entry.record, message: { id: `msg_${String(entry.record.uuid).replaceAll("-", "")}`, ...(entry.record.message as Record<string, unknown>) } },
  }) };
}

export const claudeHarness: LocalHarnessAdapter = {
  id: "claude",
  binary: profile.binary,
  async models(executable, cwd) {
    await streamJsonHelp(profile, executable, cwd);
    // Aliases follow the signed-in account; Haiku takes no effort level.
    return [
      streamJsonModel(profile, DEFAULT_MODEL, "Default", { reasoning: true, isDefault: true }),
      streamJsonModel(profile, "opus", "Claude Opus", { reasoning: true }),
      streamJsonModel(profile, "sonnet", "Claude Sonnet", { reasoning: true }),
      streamJsonModel(profile, "haiku", "Claude Haiku", { reasoning: false }),
    ];
  },
  run: (executor, turn) => runStreamJson(profile, executor, turn),
  session: {
    path: (nativeSessionId, cwd) => join(claudeProjectDirectory(cwd), `${nativeSessionId}.jsonl`),
    startsWithoutFile: true,
    project: (input) => withAssistantIds(projectChainedSession(input, "claude", { id: "uuid", parent: "parentUuid" }, (segment) => {
      const content = segment.blocks.map(anthropicBlock).filter((block) => block !== null);
      return [{
        isSidechain: false, userType: "external", cwd: input.cwd, sessionId: input.nativeSessionId, version: "cohub",
        type: segment.role, timestamp: segment.message.createdAt || input.timestamp || new Date(0).toISOString(),
        ...(segment.compactSummary ? { isCompactSummary: true } : {}),
        message: segment.role === "user"
          ? { role: "user", content }
          : {
            type: "message", role: "assistant", model: segment.message.model || "cohub", content,
            stop_reason: segment.blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        cohub: projectionMeta(input, segment.message),
      }];
    })),
    rebind: rebindSessionId,
    archive: {
      // The copy takes a fresh id: the archived one may already exist here, and is never replaced.
      target: ({ id, cwd }) => join(claudeProjectDirectory(cwd), `${id}.jsonl`),
      async import(input) {
        const { checksum } = await copyNativeArchive({ ...input, sessionId: input.id });
        return { checksum, nativeSessionId: input.id };
      },
    },
  },
  nativeSync: false,
};
