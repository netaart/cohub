import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import type { ContentBlock, NativeTurnComplete, NativeTurnMessage } from "@neta-art/cohub";
import { piContent } from "./harness.js";
import { codexTokenTotals, codexUsage } from "./codex-usage.js";
import { record, type JsonRecord } from "./json-rpc.js";

export type NativeTranscriptTurn = {
  key: string;
  parentKey: string | null;
  cloudTurnId?: string;
  userContent: ContentBlock[];
  messages: NativeTurnMessage[];
  startedAt: string;
  startBytes: number;
  endBytes: number;
  contentEndBytes: number;
  boundaries: Record<number, string>;
  sha256: string;
  result: NativeTurnComplete | null;
};
export type NativeTranscript = {
  nativeSessionId: string;
  cwd: string;
  cloudSessionId?: string;
  turns: NativeTranscriptTurn[];
  prefixes: ReadonlyMap<number, string>;
};
type Line = { value: JsonRecord; startBytes: number; endBytes: number; sha256: string };
const text = (value: unknown) => typeof value === "string" ? value : "";
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const iso = (value: unknown) => {
  const date = new Date(typeof value === "number" || typeof value === "string" ? value : 0);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid native timestamp / 原生时间无效");
  return date.toISOString();
};

/** Partial trailing records are retried, never parsed or acknowledged as complete. */
export async function readNativeTranscript(path: string, harness: "pi" | "codex", options: { settled?: boolean; leafId?: string | null } = {}): Promise<NativeTranscript> {
  const lines: Line[] = [];
  const prefixes = new Map<number, string>();
  let fragments: Buffer[] = [], pendingBytes = 0, offset = 0;
  const checksum = createHash("sha256");
  const append = (bytes: Buffer) => {
    if (!bytes.length) return;
    fragments.push(bytes); pendingBytes += bytes.length; checksum.update(bytes);
    if (pendingBytes > 32 * 1024 * 1024) throw new Error("Native record is too large / 原生记录过大");
    if (offset + pendingBytes > 128 * 1024 * 1024) throw new Error("Native transcript exceeds the capture limit; original retained / 原生记录超出采集上限，原件已保留");
  };
  for await (const chunk of createReadStream(path)) {
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
        catch { throw new Error("Invalid native JSON record; original retained / 原生 JSON 记录无效，原件已保留"); }
        lines.push({ value, startBytes, endBytes: offset, sha256 });
      }
      start = end + 1;
    }
    append(chunk.subarray(start));
  }
  if (!lines.length) throw new Error("Native transcript is empty / 原生记录为空");
  return { ...(harness === "pi" ? parsePiTranscript(lines, options) : parseCodexTranscript(lines)), prefixes };
}

function parsePiTranscript(lines: Line[], options: { settled?: boolean; leafId?: string | null }): Omit<NativeTranscript, "prefixes"> {
  const header = lines[0]?.value ?? {};
  if (header.type !== "session" || !text(header.id)) throw new Error("Invalid Pi session / Pi 会话无效");
  const entries = new Map(lines.slice(1).filter((line) => text(line.value.id)).map((line) => [text(line.value.id), line]));
  const branch: Line[] = [];
  let leaf = options.leafId ?? (lines.length > 1 ? text(lines.at(-1)?.value.id) : "");
  const visited = new Set<string>();
  while (leaf) {
    if (visited.has(leaf)) throw new Error("Cyclic Pi history / Pi 历史存在循环");
    visited.add(leaf);
    const entry = entries.get(leaf);
    if (!entry) throw new Error("Pi parent history is missing / Pi 父历史缺失");
    branch.push(entry); leaf = text(entry.value.parentId);
  }
  branch.reverse();
  const turns: NativeTranscriptTurn[] = [];
  let cloudSessionId = text(record(header.cohub).sessionId) || text(record(header.affinity).sessionId);
  let current: NativeTranscriptTurn | null = null;
  let messages: NativeTurnMessage[] = [];
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
      const cloudTurnId = text(record(message.meta).turnId);
      if (cloudTurnId && !text(record(header.cohub).sessionId) && !text(record(header.affinity).sessionId)) cloudSessionId = text(record(message.meta).sourceSessionId) || cloudSessionId;
      current = { key: text(entry.id), parentKey: turns.at(-1)?.key ?? null, ...(cloudTurnId ? { cloudTurnId } : {}), userContent: typeof message.content === "string" ? [{ type: "text", text: message.content }] : piContent(message.content), messages: [], startedAt: completedAt, startBytes: line.startBytes, endBytes: line.endBytes, contentEndBytes: line.endBytes, boundaries: {}, sha256: line.sha256, result: null };
      messages = current.messages;
    } else if (current && message.role === "assistant") {
      messages.push({ content: piContent(message.content), provider: text(message.provider) || null, model: text(message.model) || null,
        usage: record(message.usage), stopReason: text(message.stopReason) || null, errorMessage: text(message.errorMessage) || null });
    } else if (current && message.role === "toolResult") {
      const assistant = messages.at(-1);
      if (!assistant) throw new Error("Pi tool result has no assistant Turn / Pi 工具结果缺少所属 Turn");
      assistant.content.push({ type: "tool_result", tool_use_id: text(message.toolCallId), content: typeof message.content === "string" ? message.content : piContent(message.content), is_error: Boolean(message.isError) });
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
function parseCodexTranscript(lines: Line[]): Omit<NativeTranscript, "prefixes"> {
  const header = lines[0]?.value ?? {};
  const metadata = record(header.payload);
  if (header.type !== "session_meta" || !text(metadata.id)) throw new Error("Invalid Codex session / Codex 会话无效");
  if (metadata.history_base || metadata.fork_source) throw new Error("Codex history references another rollout; retain the original and materialize its full history first / Codex 历史引用其他记录，请保留原件并先导出完整历史");
  const turns: NativeTranscriptTurn[] = [];
  let current: NativeTranscriptTurn | null = null;
  let messages: NativeTurnMessage[] = [];
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
      current = { key: text(payload.turn_id), parentKey: turns.at(-1)?.key ?? null, userContent: [], messages: [], startedAt: iso(entry.timestamp), startBytes: line.startBytes, endBytes: line.endBytes, contentEndBytes: line.endBytes, boundaries: {}, sha256: line.sha256, result: null };
      if (!current.key) throw new Error("Codex Turn identity is missing / Codex Turn 身份缺失");
      messages = current.messages; userFromResponse = false;
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
        assistant().content.push({ type: "tool_use", id: text(payload.call_id), name: text(payload.name), input });
      } else if (["function_call_output", "custom_tool_call_output"].includes(text(payload.type))) {
        assistant().content.push({ type: "tool_result", tool_use_id: text(payload.call_id), content: typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? null) });
      }
    }
    if (entry.type === "event_msg" && payload.type === "user_message" && !userFromResponse) {
      current.userContent = [{ type: "text", text: text(payload.message) }];
      userFromResponse = true;
    }
    if (entry.type === "event_msg" && ["turn_complete", "task_complete", "turn_aborted"].includes(text(payload.type))) {
      if (payload.turn_id && payload.turn_id !== current.key) throw new Error("Codex Turn boundary mismatch / Codex Turn 边界不匹配");
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
  if (current && userFromResponse) turns.push(current);
  for (const turn of turns) {
    const last = turn.result?.messages.at(-1);
    if (last && usageByTurn.has(turn.key)) last.usage = usageByTurn.get(turn.key);
  }
  return { nativeSessionId: text(metadata.id), cwd: text(metadata.cwd), cloudSessionId: cloudSessionId || undefined, turns };
}
