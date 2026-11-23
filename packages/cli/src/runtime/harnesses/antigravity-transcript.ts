import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ContentBlock, NativeTurnMessage } from "@neta-art/cohub";
import { record, type JsonRecord } from "../json-rpc.js";
import { iso, type NativeTranscript, type NativeTranscriptTurn } from "../native/transcript.js";
import { extendTurn, readChainedLines } from "./chained-transcript.js";
import { array, text } from "./process.js";
import type { SessionHeader } from "./types.js";

const SYSTEM_GENERATED = ".system_generated";
const LOGS_DIR = "logs";
const TRANSCRIPT_FILE = "transcript.jsonl";
const FULL_TRANSCRIPT_FILE = "transcript_full.jsonl";
const SUMMARIES_DB = "conversation_summaries.db";
/** The CLI's own data, then the desktop app's; both keep conversations under `brain/`. */
const APP_DATA_DIRS = ["antigravity-cli", "antigravity"] as const;
/** Wraps Cohub history handed to a new conversation inside its first prompt. */
export const HANDOFF_TAG = "cohub_session_history";
const USER_REQUEST = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/;
const METADATA_BLOCKS = /<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>/g;
const HANDOFF_BLOCK = new RegExp(`^<${HANDOFF_TAG}>[\\s\\S]*?</${HANDOFF_TAG}>\\s*`);
const HYDRATED_FIELDS = new Set(["content", "thinking", "tool_calls"]);
const STEP_INDEX_PREFIX = /^\s*\{\s*"step_index"\s*:\s*(\d+)(?=\s*[,}])/;

/** `~/.gemini/antigravity-cli`: the CLI's settings and conversations. */
export const antigravityCliDir = () => join(homedir(), ".gemini", APP_DATA_DIRS[0]);

export const antigravityRoots = (): string[] => APP_DATA_DIRS.map((dir) => join(homedir(), ".gemini", dir, "brain"));

export const antigravityTranscriptPath = (nativeSessionId: string): string =>
  join(antigravityCliDir(), "brain", nativeSessionId, SYSTEM_GENERATED, LOGS_DIR, TRANSCRIPT_FILE);

/** Path relative to a brain root, split by OS separator; returns null when outside `root`. */
function brainParts(path: string, root: string): string[] | null {
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..")) return null;
  return rel.split(sep);
}

/**
 * Layout: `<geminiDir>/<appDataDir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`.
 * Only traverse into `<conversationId>`, `.system_generated`, and `logs`.
 */
export function acceptsAntigravityDirectory(path: string, root: string, _cwd: string): boolean {
  const parts = brainParts(path, root);
  if (!parts || parts.length > 3) return false;
  if (parts.length === 1) return Boolean(parts[0]) && !parts[0]?.startsWith(".");
  if (parts.length === 2) return parts[1] === SYSTEM_GENERATED;
  return parts[1] === SYSTEM_GENERATED && parts[2] === LOGS_DIR;
}

export function acceptsAntigravityTranscript(path: string, _cwd: string): boolean {
  const parsed = parseAntigravityTranscriptPath(path);
  return Boolean(parsed) && antigravityRoots().includes(join(parsed?.appDataRoot ?? "", "brain"));
}

/** Extract conversation id and app data root from `<appDataRoot>/brain/<id>/.system_generated/logs/transcript.jsonl`. */
export function parseAntigravityTranscriptPath(path: string): { nativeSessionId: string; appDataRoot: string } | null {
  if (basename(path) !== TRANSCRIPT_FILE) return null;
  const logsDir = dirname(path);
  if (basename(logsDir) !== LOGS_DIR) return null;
  const sysDir = dirname(logsDir);
  if (basename(sysDir) !== SYSTEM_GENERATED) return null;
  const sessionDir = dirname(sysDir);
  const nativeSessionId = basename(sessionDir);
  const brainDir = dirname(sessionDir);
  if (!nativeSessionId || basename(brainDir) !== "brain") return null;
  return { nativeSessionId, appDataRoot: dirname(brainDir) };
}

/** Only a local file URL or absolute path names a project here; a remote workspace never matches one. */
function uriToPath(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith("file:")) {
    try { return fileURLToPath(trimmed); } catch { return null; }
  }
  return isAbsolute(trimmed) ? trimmed : null;
}

/** The primary workspace: the first entry of `workspace_uris` (a JSON array, or one bare URI). */
function primaryWorkspace(rawUris: unknown): string | null {
  if (typeof rawUris !== "string" || !rawUris.trim()) return null;
  let first: unknown = rawUris;
  try {
    const parsed: unknown = JSON.parse(rawUris);
    first = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch { /* A bare URI. */ }
  return typeof first === "string" ? uriToPath(first) : null;
}

/** Antigravity writes the summaries in WAL mode; a reader is refused only briefly, so it waits without blocking. */
const BUSY_RETRIES = 20;
const BUSY_DELAY_MS = 50;
const busy = (error: unknown) => /SQLITE_BUSY|database is locked/i.test(String((error as { code?: unknown })?.code ?? "") + String((error as Error)?.message ?? ""));

type SummaryRow = {
  workspace_uris?: unknown;
  parent_conversation_id?: unknown;
  nesting_depth?: unknown;
};

/**
 * A conversation's workspace and nesting live only in `conversation_summaries.db`; its primary workspace owns
 * it, and a remote one owns nothing here. Reads never block the Runtime: a database still busy after the
 * retries throws, so the caller retries or fails instead of taking the conversation as unattributed.
 * `node:sqlite` loads only when an Antigravity transcript is read.
 */
export async function antigravitySessionHeader(path: string): Promise<SessionHeader | null> {
  const parsed = parseAntigravityTranscriptPath(path);
  if (!parsed) return null;
  const dbPath = join(parsed.appDataRoot, SUMMARIES_DB);
  if (!existsSync(dbPath)) return null;
  const { DatabaseSync } = await import("node:sqlite");
  for (let attempt = 0; ; attempt++) {
    let row: SummaryRow | undefined;
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 0 });
      try {
        row = db.prepare("SELECT workspace_uris, parent_conversation_id, nesting_depth FROM conversation_summaries WHERE conversation_id = ?")
          .get(parsed.nativeSessionId) as SummaryRow | undefined;
      } finally { db.close(); }
    } catch (error) {
      if (!busy(error) || attempt >= BUSY_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, BUSY_DELAY_MS));
      continue;
    }
    const cwd = row && primaryWorkspace(row.workspace_uris);
    if (!row || !cwd) return null;
    const nested = Boolean(text(row.parent_conversation_id).trim()) || (typeof row.nesting_depth === "number" && row.nesting_depth > 0);
    return { harness: "antigravity", nativeSessionId: parsed.nativeSessionId, cwd, thread: nested ? "spawned" : "user" };
  }
}

/** The prompt as typed: `<USER_REQUEST>` without injected metadata or the history Cohub handed over. */
export function extractAntigravityUserText(raw: string): string {
  const matched = USER_REQUEST.exec(raw);
  const prompt = matched?.[1] !== undefined ? matched[1] : raw.replace(METADATA_BLOCKS, "");
  return prompt.trim().replace(HANDOFF_BLOCK, "").trim();
}

/** Antigravity sometimes stores tool argument values as JSON-encoded strings (e.g. `"\"echo hi\""`). */
function normalizeToolArgs(value: unknown): Record<string, unknown> {
  const raw = record(value);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof entry === "string") {
      try { out[key] = JSON.parse(entry); } catch { out[key] = entry; }
    } else {
      out[key] = entry;
    }
  }
  return out;
}

/** Antigravity reports cached input apart from `input_tokens` (which can be far smaller), and leaves it out of its total. */
export function antigravityUsage(value: unknown): NativeTurnMessage["usage"] {
  const usage = record(value);
  const count = (key: string) => typeof usage[key] === "number" ? usage[key] as number : 0;
  const cacheRead = count("cache_read_tokens");
  const input = count("input_tokens");
  const output = count("output_tokens");
  if (!input && !output && !cacheRead) return undefined;
  return { input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead };
}

/** Only hydrate `transcript_full.jsonl` when a step's truncated fields include data this parser consumes. */
function needsHydration(value: JsonRecord): boolean {
  if (typeof value.step_index !== "number" || !Array.isArray(value.truncated_fields) || !value.truncated_fields.length) {
    return false;
  }
  const type = text(value.type);
  if (type === "PLANNER_RESPONSE") {
    return value.truncated_fields.some((field) => typeof field === "string" && HYDRATED_FIELDS.has(field));
  }
  if (type === "GENERIC" || (type === "USER_INPUT" && text(value.source) !== "SYSTEM")) {
    return value.truncated_fields.includes("content");
  }
  return false;
}

/** Stream `transcript_full.jsonl` and parse/retain only the `step_index` entries needed for hydration. */
async function loadFullRecords(
  transcriptPath: string,
  neededSteps: ReadonlySet<number>,
  signal?: AbortSignal,
): Promise<Map<number, JsonRecord>> {
  const byStep = new Map<number, JsonRecord>();
  if (!neededSteps.size) return byStep;
  signal?.throwIfAborted();
  const fullPath = join(dirname(transcriptPath), FULL_TRANSCRIPT_FILE);
  const stream = createReadStream(fullPath, { encoding: "utf8", signal });
  const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      const prefixMatch = STEP_INDEX_PREFIX.exec(line);
      if (prefixMatch) {
        if (!neededSteps.has(Number(prefixMatch[1]))) continue;
      } else if (!line.includes('"step_index"')) {
        continue;
      }
      try {
        const obj = record(JSON.parse(line));
        if (typeof obj.step_index === "number" && neededSteps.has(obj.step_index)) {
          byStep.set(obj.step_index, obj);
        }
      } catch { /* skip incomplete trailing line */ }
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // Ignore transient/missing full transcript errors and fall back to compact lines.
  } finally {
    rl.close();
    stream.destroy();
  }
  return byStep;
}

/**
 * Parse Antigravity's `transcript.jsonl` into Cohub Turns.
 * Each `USER_INPUT` (from `USER_EXPLICIT` or non-system source) starts a Turn, keyed by the file's
 * running checksum through that line. `PLANNER_RESPONSE` lines form assistant messages (with optional
 * `thinking`, `content`, and `tool_calls`), and subsequent `GENERIC` lines attach `tool_result` blocks.
 */
export async function readAntigravityTranscript(path: string, signal?: AbortSignal): Promise<NativeTranscript> {
  const read = await readChainedLines(path, signal);
  const modified = (await stat(path)).mtime.toISOString();
  const header = await antigravitySessionHeader(path);
  const neededSteps = new Set<number>();
  for (const line of read.lines) {
    if (needsHydration(line.value) && typeof line.value.step_index === "number") {
      neededSteps.add(line.value.step_index);
    }
  }
  const fullRecords = await loadFullRecords(path, neededSteps, signal);
  const turns: NativeTranscriptTurn[] = [];
  let current: NativeTranscriptTurn | null = null;
  let pendingToolIds: string[] = [];

  for (const line of read.lines) {
    const value = (typeof line.value.step_index === "number" && fullRecords.get(line.value.step_index)) || line.value;

    const type = text(value.type);
    const source = text(value.source);
    const timestamp: string = text(value.created_at) ? iso(value.created_at) : current?.startedAt ?? modified;

    if (type === "USER_INPUT" && source !== "SYSTEM") {
      const prompt = extractAntigravityUserText(text(value.content));
      if (!prompt) continue;
      pendingToolIds = [];
      current = {
        key: line.sha256,
        parentKey: turns.at(-1)?.key ?? null,
        userContent: [{ type: "text", text: prompt }],
        messages: [],
        startedAt: timestamp,
        startBytes: line.startBytes,
        endBytes: line.endBytes,
        contentEndBytes: line.endBytes,
        boundaries: {},
        sha256: line.sha256,
        result: null,
      };
      turns.push(current);
      continue;
    }

    if (!current) continue;

    if (type === "ERROR_MESSAGE") {
      pendingToolIds = [];
      current.result = null;
      extendTurn(current, line, false);
      continue;
    }

    if (type === "SYSTEM_MESSAGE" || (type === "USER_INPUT" && source === "SYSTEM")) {
      current.result = null;
      extendTurn(current, line, false);
      continue;
    }

    if (type === "PLANNER_RESPONSE") {
      const content: ContentBlock[] = [];
      const thinking = text(value.thinking);
      if (thinking) content.push({ type: "thinking", thinking });
      const reply = text(value.content);
      if (reply) content.push({ type: "text", text: reply });
      const toolCalls = array(value.tool_calls);
      const stepIndex = typeof value.step_index === "number" ? value.step_index : current.messages.length;
      const newPending: string[] = [];
      for (const [position, rawCall] of toolCalls.entries()) {
        const call = record(rawCall);
        const name = text(call.name) || "tool";
        const id = `agy_${line.sha256.slice(0, 16)}_${stepIndex}_${position}`;
        content.push({ type: "tool_use", id, name, input: normalizeToolArgs(call.args) });
        newPending.push(id);
      }
      pendingToolIds = newPending;
      const status = text(value.status);
      const isError = status === "ERROR";
      const isDone = status === "DONE";
      const hasTools = newPending.length > 0;
      const message: NativeTurnMessage = {
        content,
        provider: "antigravity",
        model: text(value.model) || null,
        stopReason: isError ? "error" : hasTools ? "tool_use" : isDone ? "stop" : null,
        errorMessage: isError ? text(value.error) || "Turn failed" : null,
        usage: antigravityUsage(value),
      };
      if (content.length || isError) current.messages.push(message);
      extendTurn(current, line, true);
      if (!hasTools && (isDone || isError)) {
        current.result = {
          messages: current.messages,
          completedAt: timestamp,
          status: isError ? "failed" : "completed",
        };
      } else {
        current.result = null;
      }
      continue;
    }

    if (type === "GENERIC" && pendingToolIds.length) {
      const toolUseId = pendingToolIds.shift();
      const owner = current.messages.at(-1);
      if (toolUseId && owner) {
        const isError = text(value.status) === "ERROR";
        const output = text(value.error) || text(value.content);
        owner.content.push({ type: "tool_result", tool_use_id: toolUseId, content: output, is_error: isError });
        extendTurn(current, line, true);
      }
      continue;
    }

    extendTurn(current, line, false);
  }

  return {
    nativeSessionId: parseAntigravityTranscriptPath(path)?.nativeSessionId ?? "",
    cwd: header?.cwd ?? "",
    turns,
    prefixes: read.prefixes,
  };
}

/** Where the `USER_INPUT` step a run reported begins; Cohub's own Turn is the one starting there. */
export async function antigravityStepStart(path: string, stepIndex: number): Promise<number | null> {
  const read = await readChainedLines(path).catch(() => null);
  const line = read?.lines.find((entry) => entry.value.step_index === stepIndex && text(entry.value.type) === "USER_INPUT");
  return line ? line.startBytes : null;
}
