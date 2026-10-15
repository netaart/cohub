import { createReadStream } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ContentBlock, NativeTurnMessage } from "@neta-art/cohub";
import { readTranscriptLines, type Line, type NativeTranscript, type NativeTranscriptTurn } from "./transcript.js";

type Row = Record<string, unknown>;
export type WorkBuddyOrigin = { nativeSessionId: string; cloudSessionId: string; turnId: string; prefixBytes: number; prefixSha256: string };
export function parseWorkBuddyOrigin(value: unknown): WorkBuddyOrigin {
  const row = object(value);
  for (const field of ["nativeSessionId", "cloudSessionId", "turnId"] as const) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(required(row[field], `origin ${field}`))) throw new Error("Invalid WorkBuddy origin identity");
  }
  if (Object.keys(row).some((key) => !["nativeSessionId", "cloudSessionId", "turnId", "prefixBytes", "prefixSha256"].includes(key)) || !Number.isSafeInteger(row.prefixBytes) || (row.prefixBytes as number) < 0 || !/^[a-f0-9]{64}$/.test(String(row.prefixSha256))) throw new Error("Invalid WorkBuddy origin prefix");
  return row as WorkBuddyOrigin;
}
const object = (value: unknown): Row => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid WorkBuddy object");
  return value as Row;
};
const string = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new Error(`Invalid WorkBuddy ${field}`);
  return value;
};
const required = (value: unknown, field: string) => {
  const result = string(value, field);
  if (!result) throw new Error(`Missing WorkBuddy ${field}`);
  return result;
};
const present = <T>(value: T | undefined, field: string): T => {
  if (value === undefined) throw new Error(`Missing WorkBuddy ${field}`);
  return value;
};
const timestamp = (value: unknown) => {
  if (typeof value !== "string" && typeof value !== "number") throw new Error("Invalid WorkBuddy timestamp");
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) throw new Error("Invalid WorkBuddy timestamp");
  return time.toISOString();
};
export const workbuddyHomeDirectory = () => process.env.WORKBUDDY_HOME?.trim() || join(homedir(), ".workbuddy");
export const workbuddySessionDirectoryName = (cwd: string) => cwd.replace(/[/\\:]/g, "-").replace(/^-+/, "").replace(/-+$/, "").replace(/-+/g, "-");
export function workbuddySessionPath(home: string, cwd: string, id: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) || !isAbsolute(cwd) || !isAbsolute(home)) throw new Error("Invalid WorkBuddy session location");
  return join(home, "projects", workbuddySessionDirectoryName(cwd), `${id}.jsonl`);
}
export function workbuddyHeader(value: Row) {
  const nativeSessionId = required(value.sessionId, "session identity"), cwd = required(value.cwd, "project directory");
  if (!isAbsolute(cwd)) throw new Error("Invalid WorkBuddy project directory");
  return { nativeSessionId, cwd };
}

const MIME_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/bmp": "bmp", "image/tiff": "tiff" };
const MAX_BLOB_BYTES = 32 * 1024 * 1024;
const inside = (root: string, path: string) => { const rel = relative(root, path); return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

/** Resolve only content-addressed WorkBuddy attachments; a bad reference is never dropped. */
async function imageContent(block: Row, signal?: AbortSignal): Promise<ContentBlock> {
  const id = required(block.blob_id, "blob id"), path = required(block.blob_path, "blob path"), mime = required(block.mime, "blob MIME type");
  const extension = MIME_EXTENSIONS[mime];
  if (!/^[a-f0-9]{64}$/.test(id) || !extension || !isAbsolute(path)) throw new Error("Invalid WorkBuddy image attachment");
  if (!Number.isSafeInteger(block.size) || (block.size as number) < 1 || (block.size as number) > MAX_BLOB_BYTES) throw new Error("Invalid WorkBuddy attachment size");
  const root = await realpath(join(workbuddyHomeDirectory(), "blobs"));
  const canonical = join(root, id.slice(0, 2), `${id}.${extension}`);
  const resolved = await realpath(path);
  if (!inside(root, resolved) || resolved !== canonical) throw new Error("WorkBuddy attachment escapes its blob root or has an invalid content address");
  const file = await open(resolved, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== block.size) throw new Error("WorkBuddy attachment size mismatch");
    const bytes = await file.readFile({ signal });
    if (bytes.length !== block.size || createHash("sha256").update(bytes).digest("hex") !== id) throw new Error("WorkBuddy attachment checksum mismatch");
    return { type: "image", source: { type: "base64", media_type: mime, data: bytes.toString("base64") } };
  } finally { await file.close(); }
}

async function content(value: unknown, signal?: AbortSignal): Promise<ContentBlock[]> {
  if (!Array.isArray(value)) throw new Error("Invalid WorkBuddy message content");
  return await Promise.all(value.map(async (item): Promise<ContentBlock> => {
    const block = object(item);
    if (["input_text", "output_text", "text"].includes(String(block.type))) return { type: "text", text: string(block.text, "text") };
    if (block.type === "reasoning_text") return { type: "thinking", thinking: string(block.text, "reasoning") };
    if (block.type === "image_blob_ref") return imageContent(block, signal);
    if (block.type === "input_image") {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(required(block.image, "inline image"));
      if (!match) throw new Error("Invalid WorkBuddy inline image");
      const mime = required(match[1], "inline image MIME type"), data = required(match[2], "inline image data");
      if (!MIME_EXTENSIONS[mime] || data.length % 4 !== 0 || Buffer.byteLength(data, "base64") > MAX_BLOB_BYTES || Buffer.from(data, "base64").toString("base64") !== data) throw new Error("Invalid WorkBuddy inline image");
      return { type: "image", source: { type: "base64", media_type: mime, data } };
    }
    throw new Error(`Unsupported WorkBuddy content type: ${String(block.type)}`);
  }));
}

function usage(value: unknown): NativeTurnMessage["usage"] {
  if (value == null) return undefined;
  const raw = object(value);
  const result: NonNullable<NativeTurnMessage["usage"]> = {};
  for (const [from, to] of [["input_tokens", "input"], ["output_tokens", "output"], ["total_tokens", "totalTokens"], ["cache_read_input_tokens", "cacheRead"], ["cache_creation_input_tokens", "cacheWrite"]] as const) {
    if (raw[from] == null) continue;
    const count = raw[from];
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) throw new Error("Invalid WorkBuddy usage");
    result[to] = count;
  }
  return result;
}

const META_TYPES = new Set(["ai-title", "file-history-snapshot"]);
const MESSAGE_TYPES = new Set(["message", "reasoning", "function_call", "function_call_result"]);

export async function readWorkBuddyTranscript(path: string, options: { settled?: boolean; signal?: AbortSignal; workbuddyOrigin?: WorkBuddyOrigin } = {}): Promise<NativeTranscript> {
  const read = await readTranscriptLines(createReadStream(path, { signal: options.signal }));
  const finalLine = read.lines.at(-1);
  if (!finalLine) throw new Error("WorkBuddy transcript is empty");
  const first = read.lines.find((line) => MESSAGE_TYPES.has(String(line.value.type)));
  if (!first) throw new Error("WorkBuddy transcript has no session identity");
  const header = workbuddyHeader(first.value);
  const origin = options.workbuddyOrigin && parseWorkBuddyOrigin(options.workbuddyOrigin);
  if (origin && (origin.nativeSessionId !== header.nativeSessionId || (origin.prefixBytes === 0 ? createHash("sha256").digest("hex") : read.prefixes.get(origin.prefixBytes)) !== origin.prefixSha256)) throw new Error("WorkBuddy origin prefix or identity mismatch");
  const entries = new Map<string, Line>();
  const nativeParents = new Map<string, unknown>();
  for (const line of read.lines) {
    const row = line.value;
    if (META_TYPES.has(String(row.type))) continue;
    if (!MESSAGE_TYPES.has(String(row.type))) throw new Error(`Unsupported WorkBuddy record: ${String(row.type)}`);
    const identity = workbuddyHeader(row);
    if (identity.nativeSessionId !== header.nativeSessionId || identity.cwd !== header.cwd) throw new Error("WorkBuddy transcript crosses session identities or projects");
    const id = required(row.id, "message identity");
    if (row.parentId != null && typeof row.parentId !== "string") throw new Error("Invalid WorkBuddy parent identity");
    if (nativeParents.has(id) && nativeParents.get(id) !== row.parentId) throw new Error("WorkBuddy message update changes its parent identity");
    nativeParents.set(id, row.parentId);
    // One model response can persist text and several calls with the same native id. Only an
    // update of that same event replaces content; sibling calls must retain their own results.
    const callId = row.type === "function_call" || row.type === "function_call_result" ? required(row.callId, "tool call identity") : null;
    const eventKey = JSON.stringify([row.type, id, callId]);
    const previous = entries.get(eventKey);
    if (previous && previous.value.role !== row.role) throw new Error("WorkBuddy message update changes its role identity");
    entries.set(eventKey, previous ? { ...line, startBytes: previous.startBytes } : line);
  }
  const turns: NativeTranscriptTurn[] = [], owner = new Map<string, NativeTranscriptTurn | undefined>();
  const calls = new Map<NativeTranscriptTurn, Map<string, NativeTurnMessage>>();
  const pending = new Map<NativeTranscriptTurn, Set<string>>();
  const completed = new Map<NativeTranscriptTurn, string>();
  let cloudSessionId: string | undefined;
  let prelude: ContentBlock[] = [];
  for (const line of entries.values()) {
    options.signal?.throwIfAborted();
    const row = line.value, id = required(row.id, "message identity"), at = timestamp(row.timestamp);
    const parent = row.parentId ? owner.get(String(row.parentId)) : undefined;
    if (row.parentId && !owner.has(String(row.parentId))) throw new Error("WorkBuddy parent history is missing or cyclic");
    if (row.type === "message" && row.role === "system") {
      const blocks = await content(row.content, options.signal);
      const notes: ContentBlock[] = blocks.map((block) => block.type === "text" ? { type: "system_note", note_type: "compacted", text: block.text } : block);
      if (parent) parent.messages.push({ content: notes }); else prelude.push(...notes);
      owner.set(id, parent);
      continue;
    }
    let turn = parent;
    if (row.type === "message" && row.role === "user") {
      turn = { key: id, parentKey: parent?.key ?? null, userFinal: true, userContent: [...prelude, ...await content(row.content, options.signal)], messages: [], startedAt: at, startBytes: line.startBytes, endBytes: line.endBytes, contentEndBytes: line.endBytes, boundaries: {}, sha256: line.sha256, result: null };
      prelude = [];
      turns.push(turn); calls.set(turn, new Map()); pending.set(turn, new Set());
      if (row.cohub != null) {
        const meta = object(row.cohub);
        turn.cloudTurnId = required(meta.turnId, "cloud Turn identity");
        const session = required(meta.sessionId, "cloud Session identity");
        if (cloudSessionId && cloudSessionId !== session) throw new Error("WorkBuddy projection crosses cloud Sessions");
        cloudSessionId = session;
      }
    } else {
      if (!turn) throw new Error("WorkBuddy assistant history has no user Turn");
      const turnCalls = present(calls.get(turn), "Turn tool calls"), turnPending = present(pending.get(turn), "Turn pending calls");
      if (row.type === "function_call_result") {
        const callId = required(row.callId, "tool call identity"), message = turnCalls.get(callId);
        if (!message) throw new Error("WorkBuddy tool result has no matching call");
        const output = typeof row.output === "string" ? row.output : await content(Array.isArray(row.output) ? row.output : [row.output], options.signal);
        const status = row.status;
        if (status != null && !["completed", "failed", "incomplete"].includes(String(status))) throw new Error("Unsupported WorkBuddy tool status");
        message.content.push({ type: "tool_result", tool_use_id: callId, content: output, ...(["failed", "incomplete"].includes(String(status)) ? { is_error: true } : {}) });
        turnPending.delete(callId);
      } else {
        const message: NativeTurnMessage = { content: [], provider: "workbuddy" };
        if (row.message != null) message.usage = usage(object(row.message).usage);
        if (row.type === "message") {
          if (row.role !== "assistant") throw new Error("Unsupported WorkBuddy message role");
          message.content = await content(row.content, options.signal);
          if (!["completed", "incomplete", "failed"].includes(String(row.status))) throw new Error("Missing or unsupported WorkBuddy assistant status");
          message.stopReason = row.status === "failed" ? "error" : row.status === "incomplete" ? "pending" : "stop";
        } else if (row.type === "reasoning") {
          message.content = await content(row.rawContent ?? row.content, options.signal);
        } else {
          const callId = required(row.callId, "tool call identity");
          const args = typeof row.arguments === "string" ? JSON.parse(row.arguments) : row.arguments;
          message.content = [{ type: "tool_use", id: callId, name: required(row.name, "tool name"), input: object(args) }];
          if (turnCalls.has(callId)) throw new Error("Duplicate WorkBuddy tool call identity");
          turnCalls.set(callId, message); turnPending.add(callId);
          message.stopReason = "toolUse";
        }
        turn.messages.push(message);
      }
    }
    owner.set(id, turn);
    if (line.endBytes >= turn.endBytes) { turn.endBytes = line.endBytes; turn.contentEndBytes = line.endBytes; turn.sha256 = line.sha256; }
    completed.set(turn, at);
  }
  if (prelude.length && !origin) throw new Error("WorkBuddy system history has no user Turn");
  let metadataOwner: NativeTranscriptTurn | undefined;
  for (const line of read.lines) {
    if (MESSAGE_TYPES.has(String(line.value.type))) metadataOwner = owner.get(String(line.value.id));
    else if (metadataOwner && line.endBytes > metadataOwner.endBytes) {
      metadataOwner.endBytes = line.endBytes; metadataOwner.sha256 = line.sha256;
    }
  }
  // Include metadata and overwritten records in byte receipts without pretending they are messages.
  const boundaries = [...read.prefixes];
  for (const [i, turn] of turns.entries()) {
    const nextStart = turns[i + 1]?.startBytes ?? finalLine.endBytes;
    let low = 0, high = boundaries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const [end] = present(boundaries[middle], "transcript byte boundary");
      if (end <= turn.startBytes) low = middle + 1; else high = middle;
    }
    for (let boundary = low; boundary < boundaries.length; boundary++) {
      const [end, hash] = present(boundaries[boundary], "transcript byte boundary");
      if (end > Math.max(nextStart, turn.endBytes)) break;
      turn.boundaries[end] = hash;
    }
    const last = turn.messages.at(-1);
    if (i < turns.length - 1 || options.settled) {
      const turnPending = present(pending.get(turn), "Turn pending calls");
      const completedAt = present(completed.get(turn), "Turn completion timestamp");
      const status = last?.stopReason === "error" ? "failed" : !last || turnPending.size > 0 || last.stopReason !== "stop" ? "interrupted" : "completed";
      turn.result = { messages: turn.messages, status, completedAt };
    }
  }
  if (origin) {
    const imported = turns.filter((turn) => turn.startBytes >= origin.prefixBytes);
    if (imported[0]) { imported[0].cloudTurnId = origin.turnId; imported[0].parentKey = null; }
    return { ...header, cloudSessionId: origin.cloudSessionId, turns: imported, prefixes: read.prefixes };
  }
  return { ...header, ...(cloudSessionId ? { cloudSessionId } : {}), turns, prefixes: read.prefixes };
}
