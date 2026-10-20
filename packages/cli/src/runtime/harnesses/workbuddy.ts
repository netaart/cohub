import { homedir } from "node:os";
import { join } from "node:path";
import { copyNativeArchive } from "../native/archive.js";
import { projectChainedSession, projectionMeta, projectionToolId, rebindSessionId, toolResultText } from "./chained-projection.js";
import { DEFAULT_MODEL, runStreamJson, streamJsonHelp, streamJsonModel, type StreamJsonProfile } from "./stream-json.js";
import type { LocalHarnessAdapter } from "./types.js";

/** WorkBuddy's CLI is CodeBuddy Code; both share its data root. */
const dataRoot = () => process.env.CODEBUDDY_CONFIG_DIR?.trim() || join(homedir(), ".codebuddy");
const MAX_NAME_BYTES = 255;
const TRUNCATED_NAME_BYTES = 180;

/** Mirrors CodeBuddy's project naming, including its truncation hash for long paths. */
export function workbuddyProjectName(cwd: string) {
  const base = cwd.replace(/[/\\:]/g, "-").replace(/^-+/, "").replace(/-+$/, "").replace(/-+/g, "-");
  if (Buffer.byteLength(base, "utf8") <= MAX_NAME_BYTES) return base;
  let prefix = "", bytes = 0;
  for (const character of base) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > TRUNCATED_NAME_BYTES) break;
    bytes += size; prefix += character;
  }
  let hash = 5381;
  for (const byte of Buffer.from(base, "utf8")) hash = 33 * hash ^ byte;
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}
const projectDirectory = (cwd: string) => join(dataRoot(), "projects", workbuddyProjectName(cwd));

const profile: StreamJsonProfile = {
  harness: "workbuddy",
  label: "WorkBuddy",
  binary: "codebuddy",
  provider: "codebuddy",
  dataRoot,
  projectDirectory,
  effortLevels: ["minimal", "low", "medium", "high", "xhigh", "max"],
};

/** The CLI lists selectable models (built-in and `models.json`) in its `--model` help. */
export function workbuddyModels(help: string) {
  const list = /--model <model>[\s\S]*?Currently supported:\s*\(([^)]*)\)/.exec(help)?.[1] ?? "";
  const ids = [...new Set(list.split(",").map((id) => id.trim()).filter((id) => /^[\w.:/@-]{1,255}$/.test(id) && id !== DEFAULT_MODEL))];
  if (!ids.length) throw new Error("WorkBuddy lists no models; sign in to WorkBuddy or configure a model");
  // The CLI ignores an effort level a model does not support.
  return [streamJsonModel(profile, DEFAULT_MODEL, "Default", { reasoning: true, isDefault: true }), ...ids.map((id) => streamJsonModel(profile, id, id, { reasoning: true }))];
}

export const workbuddyHarness: LocalHarnessAdapter = {
  id: "workbuddy",
  binary: profile.binary,
  models: async (executable, cwd) => workbuddyModels(await streamJsonHelp(profile, executable, cwd)),
  run: (executor, turn) => runStreamJson(profile, executor, turn),
  session: {
    path: (nativeSessionId, cwd) => join(projectDirectory(cwd), `${nativeSessionId}.jsonl`),
    startsWithoutFile: true,
    // CodeBuddy stores Responses-style items: one record per message, call or result.
    project: (input) => {
      const names = new Map<string, string>();
      return projectChainedSession(input, "workbuddy", { id: "id", parent: "parentId" }, (segment) => {
        const base = { timestamp: Date.parse(segment.message.createdAt) || 0, sessionId: input.nativeSessionId, cwd: input.cwd, cohub: projectionMeta(input, segment.message) };
        if (segment.role === "user") {
          if (segment.blocks.some((block) => block.type === "tool_result")) {
            return segment.blocks.flatMap((block) => block.type === "tool_result"
              ? [{ ...base, type: "function_call_result", callId: projectionToolId(block.tool_use_id), name: names.get(block.tool_use_id) ?? "tool", status: "completed", output: { type: "text", text: toolResultText(block) } }]
              : []);
          }
          const content = segment.blocks.flatMap((block): Record<string, string>[] => block.type === "text" ? [{ type: "input_text", text: block.text }]
            : block.type === "image" && block.source.type === "base64" ? [{ type: "input_image", image: `data:${block.source.media_type};base64,${block.source.data}` }]
            : []);
          return content.length ? [{ ...base, type: "message", role: "user", content, providerData: { startsNewUserRequest: true } }] : [];
        }
        const records: Record<string, unknown>[] = [];
        for (const block of segment.blocks) {
          if (block.type === "text") {
            const previous = records.at(-1);
            if (previous?.type === "message") (previous.content as unknown[]).push({ type: "output_text", text: block.text });
            else records.push({ ...base, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: block.text }] });
          } else if (block.type === "tool_use") {
            names.set(block.id, block.name);
            records.push({ ...base, type: "function_call", callId: projectionToolId(block.id), name: block.name, arguments: JSON.stringify(block.input) });
          }
        }
        return records;
      });
    },
    rebind: rebindSessionId,
    archive: {
      // The copy takes a fresh id: the archived one may already exist here, and is never replaced.
      target: ({ id, cwd }) => join(projectDirectory(cwd), `${id}.jsonl`),
      async import(input) {
        const { checksum } = await copyNativeArchive({ ...input, sessionId: input.id });
        return { checksum, nativeSessionId: input.id };
      },
    },
  },
  nativeSync: false,
};
