import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ContentBlock, NativeProjection } from "@neta-art/cohub";
import { copyNativeArchive } from "../native/archive.js";
import { projectChainedSession, projectionMeta, projectionToolId, rebindSessionId } from "./chained-projection.js";
import { harnessCommand, missing } from "./process.js";
import { runStreamJson, type StreamJsonProfile } from "./stream-json.js";
import type { LocalHarnessAdapter } from "./types.js";

const MAX_PROJECT_NAME = 200;
const dataRoot = () => process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");

/** Claude Code names a project directory by replacing every non-alphanumeric character. */
export function claudeProjectDirectory(cwd: string) {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const projects = join(dataRoot(), "projects");
  if (name.length <= MAX_PROJECT_NAME) return join(projects, name);
  // Longer names end with a runtime-specific hash; reuse the directory Claude Code already created.
  const prefix = `${name.slice(0, MAX_PROJECT_NAME)}-`;
  let matches: string[] = [];
  try { matches = readdirSync(projects).filter((entry) => entry.startsWith(prefix)); }
  catch (error) { if (!missing(error)) throw error; }
  if (matches.length !== 1) throw new Error("Cannot locate the Claude Code project directory for this long path; run claude here once first");
  return join(projects, matches[0] as string);
}

const profile: StreamJsonProfile = {
  harness: "claude",
  label: "Claude Code",
  binary: "claude",
  provider: "anthropic",
  dataRoot,
  projectDirectory: claudeProjectDirectory,
  effort: (level) => level === "off" ? null : level === "minimal" ? "low" : level,
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
    await promisify(execFile)(...harnessCommand(executable, ["--version"], cwd), { cwd, encoding: "utf8", timeout: 15_000, windowsHide: true });
    // Aliases follow the signed-in account.
    return ["opus", "sonnet", "haiku"].map((id) => ({ harness: "claude" as const, provider: "anthropic", id, name: `Claude ${id[0]?.toUpperCase()}${id.slice(1)}` }));
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
