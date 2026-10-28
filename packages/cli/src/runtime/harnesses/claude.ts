import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ContentBlock, NativeProjection } from "@neta-art/cohub";
import { JsonRpcProcess, record, type JsonRecord } from "../json-rpc.js";
import { copyNativeArchive } from "../native/archive.js";
import { projectChainedSession, projectionMeta, projectionToolId, rebindSessionId } from "./chained-projection.js";
import { chainedSessionHeader, projectDirectory, projectTranscript } from "./chained-transcript.js";
import { CLAUDE_REPLY_ENDED, readClaudeTranscript } from "./claude-transcript.js";
import { array, harnessCommand, text } from "./process.js";
import { DEFAULT_MODEL, runStreamJson, streamJsonHelp, streamJsonModel, type StreamJsonProfile } from "./stream-json.js";
import type { HarnessModel, LocalHarnessAdapter } from "./types.js";

const MAX_PROJECT_NAME = 200;
const INITIALIZE_TIMEOUT_MS = 30_000;
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
const projectsRoot = () => join(dataRoot(), "projects");
/** Every subdirectory's project name starts with this; a hashed long name keeps its first 200 units. */
const projectPrefix = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-").slice(0, MAX_PROJECT_NAME);

const profile: StreamJsonProfile = {
  harness: "claude",
  label: "Claude Code",
  binary: "claude",
  provider: "anthropic",
  dataRoot,
  projectDirectory: claudeProjectDirectory,
  effortLevels: ["low", "medium", "high", "xhigh", "max"],
  promptUuid: true,
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

/** Claude Code's own `/model` list (what the SDK's `supportedModels()` reads), gateway-discovered models included. */
async function claudeInitialize(executable: string, cwd: string): Promise<JsonRecord> {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--strict-mcp-config"];
  const host = new JsonRpcProcess(...harnessCommand(executable, args, cwd), cwd, "stream");
  const requestId = randomUUID();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<JsonRecord>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Claude Code initialize timed out")), INITIALIZE_TIMEOUT_MS);
      host.onFailure(reject);
      host.onEvent((event) => {
        const response = record(event.response);
        if (event.type !== "control_response" || response.request_id !== requestId) return;
        if (response.subtype === "success") resolve(record(response.response));
        else reject(new Error(text(response.error) || "Claude Code initialize failed"));
      });
      host.write({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } });
    });
  } finally {
    clearTimeout(timer);
    await host.close();
  }
}

/** Gateway models are served by `ANTHROPIC_BASE_URL`, so they carry its host as provider. */
function claudeModelCatalog(entries: unknown[], baseUrl?: string): HarnessModel[] {
  let gateway = "gateway";
  try { if (baseUrl) gateway = new URL(baseUrl).hostname.slice(0, 100) || gateway; } catch { /* Keep the generic name. */ }
  const seen = new Set<string>();
  return entries.flatMap((value) => {
    const model = record(value);
    const id = text(model.value);
    if (!id || id.length > 255 || seen.has(id)) return [];
    seen.add(id);
    const effortLevels = model.supportsEffort === true ? array(model.supportedEffortLevels).filter((level): level is string => typeof level === "string") : [];
    return [streamJsonModel(profile, id, (text(model.displayName) || id).slice(0, 255), {
      reasoning: effortLevels.length > 0, effortLevels, isDefault: id === DEFAULT_MODEL,
      provider: text(model.description).startsWith("From gateway") ? gateway : profile.provider,
    })];
  });
}

export const claudeHarness: LocalHarnessAdapter = {
  id: "claude",
  binary: profile.binary,
  async models(executable, cwd, options) {
    await streamJsonHelp(profile, executable, cwd);
    try {
      const models = claudeModelCatalog(array((await claudeInitialize(executable, cwd)).models), process.env.ANTHROPIC_BASE_URL);
      if (models.some((model) => model.isDefault)) return models;
      if (options?.strict) throw new Error("Claude Code initialize lists no default model");
    } catch (error) {
      // A CLI without the initialize model list keeps the account aliases.
      if (options?.strict) throw error;
    }
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
  transcript: {
    roots: () => [projectsRoot()],
    acceptsDirectory: (path, root, cwd) => projectDirectory(path, root, projectPrefix(cwd)),
    acceptsTranscript: (path, cwd) => projectTranscript(path, projectsRoot(), projectPrefix(cwd)),
    header: (path, signal) => chainedSessionHeader(path, "claude", signal),
    read: (path, signal) => readClaudeTranscript(path, basename(path, ".jsonl"), signal),
    boundaries: ['"promptSource"', '"subtype":"turn_duration"', '"interruptedMessageId"', '"isApiErrorMessage":true', ...CLAUDE_REPLY_ENDED.map((reason) => `"stop_reason":"${reason}"`)],
    turnEndRecorded: false,
    replyEnded: (turn) => CLAUDE_REPLY_ENDED.includes(turn.messages.at(-1)?.stopReason ?? ""),
    userFinalMarked: false,
    globalTurnKeys: false,
    marksCohubTurns: true,
  },
};
