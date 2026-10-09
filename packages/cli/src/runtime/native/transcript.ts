import { createReadStream, createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createZstdDecompress } from "node:zlib";
import { pipeline } from "node:stream/promises";
import type { ContentBlock, NativeTurnComplete, NativeTurnMessage } from "@neta-art/cohub";
import { identifiable, piContent } from "../harness.js";
import { codexTokenTotals, codexUsage } from "../codex-usage.js";
import { record, type JsonRecord } from "../json-rpc.js";

export type NativeTranscriptTurn = {
  key: string;
  parentKey: string | null;
  cloudTurnId?: string;
  userContent: ContentBlock[];
  /**
   * Codex records a prompt in several steps and the final form last; until this is set the user
   * content may still change.
   */
  userFinal?: boolean;
  messages: NativeTurnMessage[];
  startedAt: string;
  startBytes: number;
  endBytes: number;
  contentEndBytes: number;
  boundaries: Record<number, string>;
  sha256: string;
  result: NativeTurnComplete | null;
  path?: string;
  rolloutId?: string;
  sequence?: number;
};
export type NativeTranscript = {
  nativeSessionId: string;
  cwd: string;
  cloudSessionId?: string;
  turns: NativeTranscriptTurn[];
  prefixes: ReadonlyMap<number, string>;
  lineagePaths?: string[];
  lineageRolloutIds?: string[];
};
type Line = { value: JsonRecord; startBytes: number; endBytes: number; sha256: string };
const text = (value: unknown) => typeof value === "string" ? value : "";
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const iso = (value: unknown) => {
  const date = new Date(typeof value === "number" || typeof value === "string" ? value : 0);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid native timestamp");
  return date.toISOString();
};
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
export const NATIVE_MAX_RECORD_BYTES = 256 * 1024 * 1024;
export const NATIVE_MAX_TRANSCRIPT_BYTES = 1024 * 1024 * 1024;
const NATIVE_HEADER_MAX_BYTES = 1024 * 1024;
const CODEX_HISTORY_MAX_DEPTH = 64;
const CODEX_ROLLOUT_INDEX_TTL_MS = 2_000;
const CODEX_ROLLOUT_NAME = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})(?:_([0-9a-f-]{36}))?\.(?:jsonl|jsonl\.zst)$/;

const codexHomeDirectory = () => process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
export const codexSessionsDirectory = () => join(codexHomeDirectory(), "sessions");
export const codexArchivedSessionsDirectory = () => join(codexHomeDirectory(), "archived_sessions");

/** Ordinary rollout names encode one id; reverted threads append `_rollout-id`. */
export function codexRolloutIdOf(fileName: string): string | null {
  const match = CODEX_ROLLOUT_NAME.exec(fileName);
  return match ? match[2] ?? match[1] ?? null : null;
}

export type CodexHistoryBase = { rolloutId: string; endOrdinal: number; endBytes: number };
export type NativeTranscriptHeader = { nativeSessionId: string; cwd: string; rolloutId?: string; historyBase?: CodexHistoryBase };

function parseCodexHistoryBase(value: unknown): CodexHistoryBase | undefined {
  if (value == null) return undefined;
  const base = record(value);
  const rolloutId = text(base.thread_id);
  const endOrdinal = base.end_ordinal_exclusive, endBytes = base.end_byte_offset;
  if (!rolloutId || typeof endOrdinal !== "number" || !Number.isSafeInteger(endOrdinal) || endOrdinal < 1
    || typeof endBytes !== "number" || !Number.isSafeInteger(endBytes) || endBytes < 1) throw new Error("Codex history reference is invalid; retain the original files");
  return { rolloutId, endOrdinal, endBytes };
}


/** Read exactly the first JSONL line of a stream without re-concatenating per chunk. */
async function readFirstLine(stream: AsyncIterable<Buffer>): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let buffered = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bytes); buffered += bytes.length;
    const newline = bytes.indexOf(10);
    if (newline >= 0) {
      const buffer = Buffer.concat(chunks, buffered);
      // The newline position is chunk-relative; offset it into the concatenated line.
      const line = buffer.subarray(0, buffered - bytes.length + newline);
      return record(JSON.parse(line.toString("utf8")));
    }
    if (buffered > NATIVE_HEADER_MAX_BYTES) throw new Error("Native session header is too large");
  }
  throw new Error("Native transcript is empty");
}

async function readCodexHeader(path: string, signal?: AbortSignal): Promise<{ threadId: string; cwd: string; historyBase?: CodexHistoryBase }> {
  const value = await readFirstLine(codexRolloutBytes(path, null, signal));
  const payload = record(value.payload);
  const threadId = text(payload.id), cwd = text(payload.cwd);
  if (value.type !== "session_meta" || !threadId || !cwd) throw new Error("Invalid native session header");
  const historyBase = parseCodexHistoryBase(payload.history_base);
  return { threadId, cwd, ...(historyBase ? { historyBase } : {}) };
}

/** Read only the session header before deciding whether a global Codex file belongs to this project. */
export async function readNativeTranscriptHeader(path: string, harness: "pi" | "codex", signal?: AbortSignal): Promise<NativeTranscriptHeader> {
  if (harness === "pi") {
    const value = await readFirstLine(createReadStream(path, { signal }));
    if (value.type !== "session" || !text(value.id) || !text(value.cwd)) throw new Error("Invalid native session header");
    return { nativeSessionId: text(value.id), cwd: text(value.cwd) };
  }
  const header = await readCodexHeader(path, signal);
  const rolloutId = codexRolloutIdOf(basename(path)) ?? undefined;
  return { nativeSessionId: header.threadId, cwd: header.cwd, ...(rolloutId ? { rolloutId } : {}), ...(header.historyBase ? { historyBase: header.historyBase } : {}) };
}

let codexRolloutIndexCache: { at: number; home: string; index: Map<string, string> } | null = null;

/** Locate rollout files by id across active and archived storage; plain files win over `.zst`. */
async function scanCodexRollouts(signal?: AbortSignal): Promise<Map<string, string>> {
  const home = codexHomeDirectory();
  const cached = codexRolloutIndexCache;
  if (cached && cached.home === home && Date.now() - cached.at < CODEX_ROLLOUT_INDEX_TTL_MS) return cached.index;
  const index = new Map<string, string>();
  for (const root of [codexSessionsDirectory(), codexArchivedSessionsDirectory()]) {
    const pending = [root];
    while (pending.length) {
      signal?.throwIfAborted();
      const directory = pending.pop();
      if (!directory) continue;
      const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
        if (missing(error)) return [];
        throw error;
      });
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile()) {
          const id = codexRolloutIdOf(entry.name);
          if (!id) continue;
          const existing = index.get(id);
          if (!existing || (existing.endsWith(".zst") && !path.endsWith(".zst"))) index.set(id, path);
        }
      }
    }
  }
  codexRolloutIndexCache = { at: Date.now(), home, index };
  return index;
}

/** Raw JSONL bytes of a rollout, transparently decompressing `.zst` and honoring a lineage cutoff. */
export async function* codexRolloutBytes(path: string, endBytes: number | null, signal?: AbortSignal): AsyncGenerator<Buffer> {
  // compose (not pipe) so a source error propagates and early exit destroys both streams.
  const stream = path.endsWith(".zst")
    ? createReadStream(path, { signal }).compose(createZstdDecompress())
    : createReadStream(path, endBytes != null ? { end: endBytes - 1, signal } : { signal });
  let total = 0, last = -1;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let cut = bytes;
    if (endBytes != null && total + bytes.length > endBytes) cut = bytes.subarray(0, endBytes - total);
    if (cut.length) { total += cut.length; last = cut.at(-1) ?? last; yield cut; }
    if (endBytes != null && total >= endBytes) break;
  }
  if (endBytes != null) {
    if (total < endBytes) throw new Error("Codex history prefix is past the end of its source rollout; retain the original files");
    if (last !== 10) throw new Error("Codex history prefix does not end at a record boundary; retain the original files");
  }
}

/** Cache location for a rollout's decompressed copy; shared by capture and archival. */
export function codexRolloutCachePath(source: string, cacheDirectory: string) {
  return join(cacheDirectory, `${createHash("sha256").update(source).digest("hex")}.jsonl`);
}

/** Archives need plain JSONL bytes; decompress a cold `.zst` rollout into a cache once. */
export async function ensurePlainCodexRollout(path: string, cacheDirectory: string, signal?: AbortSignal, maxBytes: number = NATIVE_MAX_TRANSCRIPT_BYTES): Promise<string> {
  if (!path.endsWith(".zst")) return path;
  const target = codexRolloutCachePath(path, cacheDirectory);
  const exists = async () => await stat(target).then(() => true, (error) => { if (missing(error)) return false; throw error; });
  if (await exists()) return target;
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    // Bound decompression: a corrupt or hostile archive must not fill the disk.
    let written = 0;
    const bounded = new Transform({
      transform(chunk, _encoding, push) {
        written += chunk.length;
        if (written > maxBytes) { push(new Error("Decompressed rollout exceeds the local limit")); return; }
        push(null, chunk);
      },
    });
    await pipeline(createReadStream(path, { signal }), createZstdDecompress(), bounded, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    await link(temporary, target).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    return target;
  } finally { await rm(temporary, { force: true }); }
}

type TranscriptLines = { lines: Line[]; prefixes: Map<number, string> };

/** Newline framing with exact byte offsets and rolling checksums; a partial tail stays unparsed. */
async function readTranscriptLines(stream: AsyncIterable<Buffer>): Promise<TranscriptLines> {
  const lines: Line[] = [];
  const prefixes = new Map<number, string>();
  let fragments: Buffer[] = [], pendingBytes = 0, offset = 0;
  const checksum = createHash("sha256");
  const append = (bytes: Buffer) => {
    if (!bytes.length) return;
    fragments.push(bytes); pendingBytes += bytes.length; checksum.update(bytes);
    if (pendingBytes > NATIVE_MAX_RECORD_BYTES) throw new Error("Native record exceeds the 256 MiB local parse limit; original retained");
    if (offset + pendingBytes > NATIVE_MAX_TRANSCRIPT_BYTES) throw new Error("Native transcript exceeds the 1 GiB local parse limit; original retained");
  };
  for await (const chunk of stream) {
    let start = 0;
    for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
      append(chunk.subarray(start, end + 1));
      // Concatenate once per record, not once per read chunk (large base64 images stay linear).
      const bytes = fragments.length === 1 ? fragments[0] as Buffer : Buffer.concat(fragments, pendingBytes);
      const line = bytes.subarray(0, bytes.length - 1);
      const startBytes = offset;
      offset += pendingBytes; fragments = []; pendingBytes = 0;
      const sha256 = checksum.copy().digest("hex");
      prefixes.set(offset, sha256);
      if (line.length) {
        let value: JsonRecord;
        try { value = record(JSON.parse(line.toString("utf8"))); }
        catch { throw new Error("Invalid native JSON record; original retained"); }
        lines.push({ value, startBytes, endBytes: offset, sha256 });
      }
      start = end + 1;
    }
    append(chunk.subarray(start));
  }
  return { lines, prefixes };
}

/** Partial trailing records are retried, never parsed or acknowledged as complete. */
export async function readNativeTranscript(path: string, harness: "pi" | "codex", options: { settled?: boolean; leafId?: string | null; signal?: AbortSignal } = {}): Promise<NativeTranscript> {
  if (harness === "pi") {
    const read = await readTranscriptLines(createReadStream(path, { signal: options.signal }));
    if (!read.lines.length) throw new Error("Native transcript is empty");
    return { ...parsePiTranscript(read.lines, options), prefixes: read.prefixes };
  }
  return await readCodexTranscript(path, options);
}

function parsePiTranscript(lines: Line[], options: { settled?: boolean; leafId?: string | null }): Omit<NativeTranscript, "prefixes"> {
  const header = lines[0]?.value ?? {};
  if (header.type !== "session" || !text(header.id)) throw new Error("Invalid Pi session");
  const entries = new Map(lines.slice(1).filter((line) => text(line.value.id)).map((line) => [text(line.value.id), line]));
  const branch: Line[] = [];
  let leaf = options.leafId ?? (lines.length > 1 ? text(lines.at(-1)?.value.id) : "");
  const visited = new Set<string>();
  while (leaf) {
    if (visited.has(leaf)) throw new Error("Cyclic Pi history");
    visited.add(leaf);
    const entry = entries.get(leaf);
    if (!entry) throw new Error("Pi parent history is missing");
    branch.push(entry); leaf = text(entry.value.parentId);
  }
  branch.reverse();
  const turns: NativeTranscriptTurn[] = [];
  let cloudSessionId = text(record(header.cohub).sessionId) || text(record(header.affinity).sessionId);
  let current: NativeTranscriptTurn | null = null;
  let messages: NativeTurnMessage[] = [];
  const calls = new Map<string, NativeTurnMessage>(); // tool call id → owning message
  let pendingMarker: string | null = null;
  let completedAt = iso(header.timestamp);
  const finish = (settled: boolean) => {
    if (!current) return;
    const last = messages.at(-1);
    if (settled) current.result = { messages, completedAt, status: !last || ["aborted", "pending", "toolUse"].includes(last.stopReason ?? "") ? "interrupted" : last?.errorMessage || last?.stopReason === "error" ? "failed" : "completed" };
    turns.push(current);
  };
  for (const line of branch) {
    const entry = line.value;
    if (entry.type !== "message") {
      // Cohub writes a marker entry immediately before a user message it sends, so a Turn it
      // started can be matched to the cloud Turn without guessing at byte offsets.
      if (entry.type === "custom" && text(entry.customType) === "cohub.turn") pendingMarker = text(record(entry.data).turnId) || null;
      if (current) { current.endBytes = line.endBytes; current.sha256 = line.sha256; current.boundaries[line.endBytes] = line.sha256; }
      continue;
    }
    const message = record(entry.message);
    if (!["user", "assistant", "toolResult"].includes(text(message.role))) {
      // Native-only UI / shell records remain in raw archives; they do not rewrite a settled agent Turn.
      if (current) { current.endBytes = line.endBytes; current.sha256 = line.sha256; current.boundaries[line.endBytes] = line.sha256; }
      continue;
    }
    const timestamp = iso(entry.timestamp ?? message.timestamp);
    if (message.role === "user") {
      finish(true);
      completedAt = timestamp;
      const metaTurnId = text(record(message.meta).turnId);
      const cloudTurnId = metaTurnId || pendingMarker || "";
      pendingMarker = null;
      if (cloudTurnId && !text(record(header.cohub).sessionId) && !text(record(header.affinity).sessionId)) cloudSessionId = text(record(message.meta).sourceSessionId) || cloudSessionId;
      current = { key: text(entry.id), parentKey: turns.at(-1)?.key ?? null, ...(cloudTurnId ? { cloudTurnId } : {}), userContent: typeof message.content === "string" ? [{ type: "text", text: message.content }] : piContent(message.content), messages: [], startedAt: completedAt, startBytes: line.startBytes, endBytes: line.endBytes, contentEndBytes: line.endBytes, boundaries: {}, sha256: line.sha256, result: null };
      messages = current.messages; calls.clear();
    } else if (current && message.role === "assistant") {
      const assistant: NativeTurnMessage = { content: piContent(message.content), provider: text(message.provider) || null, model: text(message.model) || null,
        usage: record(message.usage), stopReason: text(message.stopReason) || null, errorMessage: text(message.errorMessage) || null };
      messages.push(assistant);
      for (const block of assistant.content) if (block.type === "tool_use") calls.set(block.id, assistant);
    } else if (current && message.role === "toolResult") {
      const id = text(message.toolCallId);
      calls.get(id)?.content.push({ type: "tool_result", tool_use_id: id, content: typeof message.content === "string" ? message.content : piContent(message.content), is_error: Boolean(message.isError) });
    }
    if (current) { current.endBytes = line.endBytes; current.contentEndBytes = line.endBytes; current.sha256 = line.sha256; current.boundaries[line.endBytes] = line.sha256; }
    completedAt = timestamp;
  }
  finish(Boolean(options.settled));
  return { nativeSessionId: text(header.id), cwd: text(header.cwd), cloudSessionId: cloudSessionId || undefined, turns };
}

function codexContent(value: unknown): ContentBlock[] {
  return list(value).flatMap((item): ContentBlock[] => {
    const block = record(item);
    if (["input_text", "output_text", "text"].includes(text(block.type))) return [{ type: "text", text: text(block.text) }];
    if (block.type === "input_image" && text(block.image_url)) {
      const data = /^data:([^;]+);base64,(.*)$/s.exec(text(block.image_url));
      return [{ type: "image", source: data ? { type: "base64", media_type: data[1] ?? "image/png", data: data[2] ?? "" } : { type: "url", url: text(block.image_url) } }];
    }
    return [];
  });
}

type CodexLineageSegment = { path: string; rolloutId: string; threadId: string; cwd: string; endBytes: number | null; endOrdinal: number | null };

/** Follow `history_base` pointers from a live rollout to its immutable ancestors, oldest first. */
async function resolveCodexLineage(leafPath: string, signal?: AbortSignal): Promise<CodexLineageSegment[]> {
  const segments: CodexLineageSegment[] = [];
  const visited = new Set<string>();
  let path = leafPath, endBytes: number | null = null, endOrdinal: number | null = null;
  let leafCwd: string | null = null;
  for (;;) {
    if (segments.length >= CODEX_HISTORY_MAX_DEPTH) throw new Error("Codex history chain is too deep; retain the original files");
    const header = await readCodexHeader(path, signal);
    // Every segment of one conversation must belong to the same project: a cross-project reference
    // would import another workspace's history into this one.
    if (header.cwd && leafCwd != null && header.cwd !== leafCwd) throw new Error("Codex lineage crosses projects; retain the original files");
    leafCwd ??= header.cwd;
    if (!header.historyBase) {
      // No reference: this file is the whole conversation. Non-canonical names stay readable.
      segments.push({ path, rolloutId: codexRolloutIdOf(basename(path)) ?? "", threadId: header.threadId, cwd: header.cwd, endBytes, endOrdinal });
      break;
    }
    const rolloutId = codexRolloutIdOf(basename(path));
    if (!rolloutId) throw new Error("Codex rollout file name is not canonical; retain the original file");
    if (visited.has(rolloutId)) throw new Error("Codex history chain is cyclic; retain the original files");
    visited.add(rolloutId);
    segments.push({ path, rolloutId, threadId: header.threadId, cwd: header.cwd, endBytes, endOrdinal });
    const ancestor = (await scanCodexRollouts(signal)).get(header.historyBase.rolloutId);
    if (!ancestor) throw new Error(`Codex history source ${header.historyBase.rolloutId} is missing; retain the original files`);
    path = ancestor;
    endBytes = header.historyBase.endBytes;
    endOrdinal = header.historyBase.endOrdinal;
  }
  return segments.reverse();
}

function parseCodexLines(lines: Line[], segment: CodexLineageSegment): { turns: NativeTranscriptTurn[]; cloudSessionId?: string; settled: boolean } {
  const header = lines[0]?.value ?? {};
  const metadata = record(header.payload);
  if (header.type !== "session_meta" || !text(metadata.id)) throw new Error("Invalid Codex session");
  if (metadata.fork_source != null) throw new Error("Legacy Codex fork source is unsupported; retain the original files");
  const turns: NativeTranscriptTurn[] = [];
  let current: NativeTranscriptTurn | null = null;
  let messages: NativeTurnMessage[] = [];
  const calls = new Map<string, NativeTurnMessage>(); // tool call id → owning message
  let model: string | null = null;
  let cloudSessionId = text(record(metadata.cohub).sessionId);
  let provider: string | null = text(metadata.model_provider) || null;
  let userFromResponse = false;
  const usageByTurn = new Map<string, NativeTurnMessage["usage"]>();
  const assistant = () => {
    let last = messages.at(-1);
    if (!last) { last = { content: [], model, provider }; messages.push(last); }
    return last;
  };
  for (const line of lines.slice(1)) {
    const entry = line.value, payload = record(entry.payload);
    if (entry.type === "turn_context") { model = text(payload.model) || model; provider = text(payload.model_provider) || provider; }
    if (entry.type === "event_msg" && ["turn_started", "task_started"].includes(text(payload.type))) {
      if (current) turns.push(current);
      current = { key: text(payload.turn_id), parentKey: turns.at(-1)?.key ?? null, userContent: [], messages: [], startedAt: iso(entry.timestamp), startBytes: line.startBytes, endBytes: line.endBytes, contentEndBytes: line.endBytes, boundaries: {}, sha256: line.sha256, result: null, path: segment.path, rolloutId: segment.rolloutId };
      if (!current.key) throw new Error("Codex Turn identity is missing");
      messages = current.messages; userFromResponse = false; calls.clear();
    }
    if (entry.type === "token_usage_record") {
      const usage = record(payload.turn_token_usage);
      if (typeof usage.total_tokens === "number") usageByTurn.set(text(payload.turn_id), codexUsage(codexTokenTotals({ inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cachedInputTokens: usage.cached_input_tokens, cacheWriteInputTokens: usage.cache_write_input_tokens, totalTokens: usage.total_tokens })));
    }
    if (!current) {
      const previous = turns.at(-1);
      if (previous) { previous.endBytes = line.endBytes; previous.sha256 = line.sha256; previous.boundaries[line.endBytes] = line.sha256; }
      continue;
    }
    current.endBytes = line.endBytes;
    current.sha256 = line.sha256;
    current.boundaries[line.endBytes] = line.sha256;
    current.contentEndBytes = line.endBytes;
    if (entry.type === "response_item") {
      const cohub = record(record(entry.metadata).cohub);
      if (typeof cohub.turnId === "string") {
        current.cloudTurnId = cohub.turnId;
        if (!text(record(metadata.cohub).sessionId)) cloudSessionId = text(cohub.sessionId) || cloudSessionId;
      }
      if (payload.type === "message" && payload.role === "user") {
        if (!userFromResponse) current.userContent = [];
        current.userContent.push(...codexContent(payload.content)); userFromResponse = true;
      } else if (payload.type === "message" && payload.role === "assistant") {
        const content = codexContent(payload.content);
        if (!messages.length || messages.at(-1)?.content.length) messages.push({ content, model, provider });
        else assistant().content.push(...content);
      } else if (payload.type === "reasoning") {
        const thinking = list(payload.summary).map((item) => text(record(item).text)).join("\n");
        if (thinking) assistant().content.push({ type: "thinking", thinking });
      } else if (["function_call", "custom_tool_call"].includes(text(payload.type))) {
        let input: Record<string, unknown>;
        try { input = payload.type === "custom_tool_call" ? { input: payload.input } : record(JSON.parse(text(payload.arguments))); }
        catch { input = { raw: payload.arguments }; }
        if (identifiable(payload.call_id) && identifiable(payload.name)) {
          const owner = assistant();
          owner.content.push({ type: "tool_use", id: payload.call_id, name: payload.name, input });
          calls.set(payload.call_id, owner);
        }
      } else if (["function_call_output", "custom_tool_call_output"].includes(text(payload.type))) {
        const id = text(payload.call_id);
        calls.get(id)?.content.push({ type: "tool_result", tool_use_id: id, content: typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? null) });
      }
    }
    if (entry.type === "event_msg" && payload.type === "item_completed") {
      // Cohub tags a Turn it starts with its own cloud Turn id, so the file itself records which
      // Turns already belong to a cloud Turn (and must not be ingested twice).
      const item = record(payload.item);
      if (item.type === "UserMessage") {
        const clientId = text(item.client_id);
        if (clientId) current.cloudTurnId = clientId;
        // The typed input, without the environment context Codex injects as a user item.
        const typed = codexContent(item.content);
        if (typed.length) { current.userContent = typed; userFromResponse = true; }
        current.userFinal = true;
      }
    }
    if (entry.type === "event_msg" && payload.type === "user_message") {
      if (!userFromResponse) current.userContent = [{ type: "text", text: text(payload.message) }];
      userFromResponse = true;
      current.userFinal = true;
    }
    if (entry.type === "event_msg" && ["turn_complete", "task_complete", "turn_aborted"].includes(text(payload.type))) {
      if (payload.turn_id && payload.turn_id !== current.key) throw new Error("Codex Turn boundary mismatch");
      if (!messages.length && text(payload.last_agent_message)) messages.push({ content: [{ type: "text", text: text(payload.last_agent_message) }], model, provider });
      const errorMessage = text(record(payload.error).message);
      const status = payload.type === "turn_aborted" ? "interrupted" : errorMessage ? "failed" : "completed";
      const final = assistant();
      final.stopReason = status === "interrupted" ? "aborted" : status === "failed" ? "error" : "stop";
      if (errorMessage) final.errorMessage = errorMessage;
      current.result = { messages, completedAt: iso(entry.timestamp), status };
      turns.push(current); current = null; messages = [];
    }
  }
  const settled = current === null;
  if (current && userFromResponse) turns.push(current);
  for (const turn of turns) {
    const last = turn.result?.messages.at(-1);
    if (last && usageByTurn.has(turn.key)) last.usage = usageByTurn.get(turn.key);
  }
  return { turns, ...(cloudSessionId ? { cloudSessionId } : {}), settled };
}

const codexSegmentMemo = new Map<string, { turns: NativeTranscriptTurn[]; prefixes: Map<number, string>; cloudSessionId?: string; settled: boolean; bytes: number }>();
// Ancestor prefixes are immutable, so the cache is a pure win; parsed objects inflate in memory
// several-fold over raw bytes, hence a conservative budget.
const CODEX_MEMO_MAX_BYTES = 128 * 1024 * 1024;

/** Ancestors are immutable; only their bounded prefixes are worth caching, bounded by bytes. */
async function parseCodexSegment(segment: CodexLineageSegment, signal?: AbortSignal) {
  const cacheable = segment.endBytes != null;
  const info = cacheable ? await stat(segment.path) : null;
  const key = `${segment.path}|${segment.endBytes ?? "-"}|${segment.endOrdinal ?? "-"}|${info?.size ?? ""}|${info?.mtimeMs ?? ""}`;
  const cached = codexSegmentMemo.get(key);
  if (cached) {
    // Refresh recency: eviction below must spare the segments still in use.
    codexSegmentMemo.delete(key); codexSegmentMemo.set(key, cached);
    return cached;
  }
  const read = await readTranscriptLines(codexRolloutBytes(segment.path, segment.endBytes, signal));
  if (!read.lines.length) throw new Error("Native transcript is empty");
  const parsed = parseCodexLines(read.lines, segment);
  // A paginated ancestor stamps every record with its ordinal; the referenced prefix must end
  // exactly at the ordinal bound.
  if (segment.endBytes != null && segment.endOrdinal != null) {
    const ordinal = read.lines.at(-1)?.value.ordinal;
    if (typeof ordinal !== "number" || ordinal !== segment.endOrdinal - 1) throw new Error("Codex history ordinal bound does not match the prefix; retain the original files");
  }
  const value = { turns: parsed.turns, prefixes: read.prefixes, ...(parsed.cloudSessionId ? { cloudSessionId: parsed.cloudSessionId } : {}), settled: parsed.settled, bytes: segment.endBytes ?? 0 };
  if (cacheable) {
    // Evict oldest entries first until the cached bytes stay bounded.
    let total = [...codexSegmentMemo.values()].reduce((sum, entry) => sum + entry.bytes, 0) + value.bytes;
    for (const [existing, entry] of codexSegmentMemo) {
      if (total <= CODEX_MEMO_MAX_BYTES) break;
      total -= entry.bytes; codexSegmentMemo.delete(existing);
    }
    codexSegmentMemo.set(key, value);
  }
  return value;
}

async function readCodexTranscript(path: string, options: { signal?: AbortSignal }): Promise<NativeTranscript> {
  const segments = await resolveCodexLineage(path, options.signal);
  const files: Array<{ segment: CodexLineageSegment; parsed: Awaited<ReturnType<typeof parseCodexSegment>> }> = [];
  let prefixes: ReadonlyMap<number, string> = new Map();
  for (const [index, segment] of segments.entries()) {
    const parsed = await parseCodexSegment(segment, options.signal);
    // An ancestor contributes exactly its referenced prefix; an in-flight tail would corrupt the boundary.
    if (index < segments.length - 1 && !parsed.settled) throw new Error("Codex history boundary is not at a completed Turn; retain the original files");
    files.push({ segment, parsed });
    if (index === segments.length - 1) prefixes = parsed.prefixes;
  }
  const leaf = files.at(-1);
  if (!leaf) throw new Error("Native transcript is empty");
  const turns: NativeTranscriptTurn[] = [];
  for (const file of files) for (const turn of file.parsed.turns) turns.push({ ...turn, parentKey: turns.at(-1)?.key ?? null, sequence: turns.length });
  // The leaf's own cloud binding wins; ancestors only matter when the leaf has none (a native
  // continuation of a previously managed conversation).
  const cloudSessionId = files.at(-1)?.parsed.cloudSessionId ?? files.map((file) => file.parsed.cloudSessionId).find(Boolean);
  return { nativeSessionId: leaf.segment.threadId, cwd: leaf.segment.cwd, ...(cloudSessionId ? { cloudSessionId } : {}), turns, prefixes,
    lineagePaths: files.map((file) => file.segment.path), lineageRolloutIds: files.map((file) => file.segment.rolloutId) };
}
