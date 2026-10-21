import type { ContentBlock, NativeTurnMessage } from "@neta-art/cohub";
import { record, type JsonRecord } from "../json-rpc.js";
import { iso, type NativeTranscript, type NativeTranscriptTurn } from "../native/transcript.js";
import { chainBranch, extendTurn, readChainedLines, startTurn } from "./chained-transcript.js";
import { array, identifiable, text } from "./process.js";
import { streamUsage } from "./stream-json.js";

export const WORKBUDDY_REPLY_ENDED = ["stop", "aborted", "error"];
const INTERRUPTED = "Interrupted by user";

function items(value: unknown): ContentBlock[] {
  return array(value).flatMap((entry): ContentBlock[] => {
    const block = record(entry);
    if (["input_text", "output_text", "text"].includes(text(block.type))) return text(block.text) ? [{ type: "text", text: text(block.text) }] : [];
    if (block.type === "reasoning_text") return text(block.text) ? [{ type: "thinking", thinking: text(block.text) }] : [];
    const image = text(block.image) || text(block.image_url);
    if (block.type === "input_image" && image) {
      const data = /^data:([^;]+);base64,(.*)$/s.exec(image);
      return [{ type: "image", source: data ? { type: "base64", media_type: data[1] ?? "image/png", data: data[2] ?? "" } : { type: "url", url: image } }];
    }
    return [];
  });
}

function toolOutput(value: unknown): string | ContentBlock[] {
  if (typeof value === "string") return value;
  const output = record(value);
  if (output.type === "text") return text(output.text);
  return Array.isArray(value) ? items(value) : JSON.stringify(value ?? null);
}

/**
 * CodeBuddy stores Responses-style items linked by `parentId`: a user message starts a Turn, and each
 * model step (`providerData.messageId`) is one message. Interactive sessions record each end
 * (`turn-metrics`, outside the chain); `-p` sessions do not.
 */
export async function readWorkbuddyTranscript(path: string, nativeSessionId: string, signal?: AbortSignal): Promise<NativeTranscript> {
  const read = await readChainedLines(path, signal);
  const linked = (value: JsonRecord) => value.type === "message" || "parentId" in value;
  const branch = chainBranch(read.lines, (value) => linked(value) ? text(value.id) : "", (value) => text(value.parentId));
  const metricsAt = read.lines.reduce((latest, line) => line.value.type === "turn-metrics" ? line.startBytes : latest, -1);
  const turns: NativeTranscriptTurn[] = [];
  const owners = new Map<string, NativeTurnMessage>();
  const steps = new Map<string, NativeTurnMessage>();
  let cwd = "", cloudSessionId = "", completedAt = "";
  let current: NativeTranscriptTurn | null = null;
  const finish = () => {
    if (!current) return;
    const last = current.messages.at(-1);
    const status = !last || last.stopReason === "aborted" || last.stopReason === "tool_use" ? "interrupted" : last.stopReason === "error" ? "failed" : "completed";
    current.result = { messages: current.messages, completedAt: completedAt || current.startedAt, status };
    turns.push(current);
    current = null;
  };
  for (const line of branch) {
    const value = line.value;
    cwd ||= text(value.cwd);
    if (value.type === "message" && value.role === "user") {
      finish();
      const cohub = record(value.cohub);
      cloudSessionId ||= text(cohub.sessionId);
      current = startTurn(line, text(value.id), turns.at(-1)?.key ?? null, items(value.content), text(cohub.turnId));
      completedAt = current.startedAt;
      owners.clear(); steps.clear();
      continue;
    }
    if (!current) continue;
    const provider = record(value.providerData);
    const step = text(provider.messageId);
    const message = () => {
      let target = step ? steps.get(step) : undefined;
      if (!target) {
        target = { content: [], provider: null, model: text(provider.model) || null, stopReason: null, errorMessage: null };
        current?.messages.push(target);
        if (step) steps.set(step, target);
      }
      return target;
    };
    if (value.type === "message" && value.role === "assistant") {
      const target = message();
      target.content.push(...items(value.content));
      const usage = streamUsage(record(value.message).usage, undefined);
      if (usage) target.usage = usage;
      const error = text(record(provider.error).message);
      target.stopReason = value.status === "incomplete" ? error === INTERRUPTED ? "aborted" : "error" : "stop";
      if (target.stopReason === "error") target.errorMessage = error || "Turn failed";
      if (target.stopReason === "aborted") current.ended = true;
    } else if (value.type === "reasoning") {
      message().content.push(...items(value.rawContent), ...items(value.content).filter((block) => block.type === "thinking"));
    } else if (value.type === "function_call" && identifiable(value.callId) && identifiable(value.name)) {
      let input: Record<string, unknown>;
      try { input = record(JSON.parse(text(value.arguments))); } catch { input = { raw: value.arguments }; }
      const target = message();
      target.content.push({ type: "tool_use", id: value.callId, name: value.name, input });
      target.stopReason = "tool_use";
      const usage = streamUsage(record(value.message).usage, undefined);
      if (usage) target.usage = usage;
      owners.set(value.callId, target);
    } else if (value.type === "function_call_result") {
      const id = text(value.callId);
      owners.get(id)?.content.push({ type: "tool_result", tool_use_id: id, content: toolOutput(value.output) });
    }
    if (typeof value.timestamp === "number" || typeof value.timestamp === "string") completedAt = iso(value.timestamp);
    extendTurn(current, line, true);
  }
  const tail = current as NativeTranscriptTurn | null;
  if (tail && metricsAt >= tail.contentEndBytes) tail.ended = true;
  finish();
  return { nativeSessionId, cwd, ...(cloudSessionId ? { cloudSessionId } : {}), turns, prefixes: read.prefixes };
}
