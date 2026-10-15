import type { ContentBlock, RuntimeExecutionEvent, RuntimeMessage } from "@neta-art/cohub";
import { record, type JsonRecord } from "../json-rpc.js";
import type { Translator } from "./translate.js";

const requiredString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value) throw new Error(`Invalid WorkBuddy ${label}`);
  return value;
};

export function workbuddyUsage(value: unknown): RuntimeMessage["usage"] {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid WorkBuddy usage");
  const usage = record(value);
  const count = (key: string) => {
    if (usage[key] === undefined) return 0;
    if (usage[key] === null && ["cache_read_input_tokens", "cache_creation_input_tokens"].includes(key)) return 0;
    if (typeof usage[key] !== "number" || !Number.isFinite(usage[key]) || usage[key] < 0) throw new Error("Invalid WorkBuddy usage");
    return usage[key] as number;
  };
  const input = count("input_tokens"), output = count("output_tokens"), cacheRead = count("cache_read_input_tokens"), cacheWrite = count("cache_creation_input_tokens");
  return { input, output, cacheRead, cacheWrite, totalTokens: usage.total_tokens === undefined ? input + output : count("total_tokens"), cost: null };
}

function content(value: unknown): ContentBlock[] {
  if (!Array.isArray(value)) throw new Error("Invalid WorkBuddy message content");
  return value.map((item): ContentBlock => {
    const block = record(item);
    if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
    if (block.type === "thinking" && typeof block.thinking === "string") return { type: "thinking", thinking: block.thinking, ...(typeof block.signature === "string" ? { signature: block.signature } : {}) };
    if (block.type === "tool_use") {
      if (!block.input || typeof block.input !== "object" || Array.isArray(block.input)) throw new Error("Invalid WorkBuddy tool call");
      return { type: "tool_use", id: requiredString(block.id, "tool call"), name: requiredString(block.name, "tool call"), input: record(block.input) };
    }
    if (block.type === "tool_result") {
      return { type: "tool_result", tool_use_id: requiredString(block.tool_use_id, "tool result"), content: typeof block.content === "string" ? block.content : content(block.content), is_error: block.is_error === true };
    }
    if (block.type === "image") {
      const source = record(block.source);
      if (source.type === "base64") return { type: "image", source: { type: "base64", data: requiredString(source.data, "image"), media_type: requiredString(source.media_type, "image") } };
      if (source.type === "url") return { type: "image", source: { type: "url", url: requiredString(source.url, "image") } };
    }
    throw new Error(`Unsupported WorkBuddy content block: ${String(block.type)}`);
  });
}

/** Stream-json replies are Anthropic-shaped, unlike WorkBuddy's durable transcript. */
export function workbuddyTranslator(emit: (event: RuntimeExecutionEvent) => void): Translator & { finish(): void } {
  let ordinal = -1;
  let current: RuntimeMessage = { ordinal: 0, content: [], provider: "workbuddy", model: null };
  let complete = false;
  let model: string | null = null;
  const messages = new Map<number, RuntimeMessage>();
  const calls = new Map<string, { ordinal: number; settled: boolean }>();
  const completed = new Set<number>();
  const streamIndexes = new Map<number, number>();
  let nextCommit = 0;
  const save = (message: RuntimeMessage) => { messages.set(message.ordinal, message); if (message.ordinal === ordinal) current = message; };
  const flushCommits = (force = false) => {
    while (nextCommit < ordinal) {
      const message = messages.get(nextCommit);
      if (!message || !completed.has(nextCommit) || !force && [...calls.values()].some((call) => call.ordinal === nextCommit && !call.settled)) break;
      emit({ type: "message.commit", message });
      nextCommit += 1;
    }
  };
  const begin = () => {
    complete = false;
    streamIndexes.clear();
    ordinal += 1;
    current = { ordinal, content: [], provider: "workbuddy", model };
    save(current);
    flushCommits();
    emit({ type: "message.start", ordinal });
  };
  const ensure = () => { if (ordinal < 0 || complete) begin(); };
  return {
    last: () => current,
    finish: () => flushCommits(true),
    push(event: JsonRecord) {
      if (event.type === "system" && event.subtype === "init") {
        if (typeof event.model === "string") model = event.model;
      } else if (event.type === "stream_event") {
        const stream = record(event.event);
        if (stream.type === "message_start") ensure();
        if (stream.type === "content_block_delta") {
          const delta = record(stream.delta);
          if (delta.type === "text_delta" || delta.type === "thinking_delta") {
            ensure();
            const index = stream.index;
            if (!Number.isSafeInteger(index) || (index as number) < 0) throw new Error("Invalid WorkBuddy content index");
            const text = delta.type === "text_delta" ? delta.text : delta.thinking;
            if (typeof text !== "string") throw new Error("Invalid WorkBuddy text delta");
            const blocks = [...current.content];
            // The CLI uses model-response indexes, but persists reasoning/text as
            // separate assistant items. A new Cohub message may start at wire 1.
            const position = streamIndexes.get(index as number) ?? blocks.length;
            streamIndexes.set(index as number, position);
            const previous = blocks[position];
            if (delta.type === "text_delta") {
              if (previous && previous.type !== "text") throw new Error("WorkBuddy content block changed type");
              blocks[position] = { type: "text", text: (previous?.text ?? "") + text };
            } else {
              if (previous && previous.type !== "thinking") throw new Error("WorkBuddy content block changed type");
              blocks[position] = { type: "thinking", thinking: (previous?.thinking ?? "") + text };
            }
            save({ ...current, content: blocks });
            emit({ type: "text.delta", ordinal, index: position, kind: delta.type === "text_delta" ? "text" : "thinking", delta: text });
          }
        }
      } else if (event.type === "assistant") {
        ensure();
        const message = record(event.message);
        save({ ordinal, content: content(message.content), provider: "workbuddy", model: typeof message.model === "string" ? message.model : model, usage: workbuddyUsage(message.usage), stopReason: typeof message.stop_reason === "string" ? message.stop_reason : "stop" });
        for (const block of current.content) if (block.type === "tool_use") {
          if (calls.has(block.id)) throw new Error("Duplicate WorkBuddy tool call ID");
          calls.set(block.id, { ordinal, settled: false });
        }
        emit({ type: "content.replace", ordinal, content: current.content });
        complete = true;
        completed.add(ordinal);
      } else if (event.type === "user") {
        const message = record(event.message);
        // User echoes are used by execution identity, never rendered as assistant output.
        const results = Array.isArray(message.content) ? message.content.filter((block: unknown) => record(block).type === "tool_result") : [];
        if (results.length) {
          const blocks = content(results);
          for (const block of blocks) {
            if (block.type !== "tool_result") throw new Error("Invalid WorkBuddy tool result");
            const call = calls.get(block.tool_use_id);
            const owner = call && messages.get(call.ordinal);
            if (!call || !owner) throw new Error("WorkBuddy tool result has no matching call");
            if (call.settled) throw new Error("Duplicate WorkBuddy tool result");
            call.settled = true;
            const updated = { ...owner, content: [...owner.content, block] };
            save(updated);
            emit({ type: "content.replace", ordinal: owner.ordinal, content: updated.content });
          }
          flushCommits();
        }
      } else if (event.type === "result") {
        if (typeof event.is_error !== "boolean" || typeof event.subtype !== "string" || (event.subtype !== "success" && !event.subtype.startsWith("error_"))) throw new Error("Invalid WorkBuddy result");
        if (ordinal < 0) begin();
        const failed = event.is_error || event.subtype !== "success";
        const errors = event.errors;
        if (errors !== undefined && (!Array.isArray(errors) || errors.some((error) => typeof error !== "string"))) throw new Error("Invalid WorkBuddy result errors");
        save({
          ...current,
          content: current.content.length ? current.content : typeof event.result === "string" ? [{ type: "text", text: event.result }] : [],
          usage: workbuddyUsage(event.usage) ?? current.usage,
          stopReason: failed ? "error" : "stop",
          errorMessage: failed ? (errors as string[] | undefined)?.join("\n") || `WorkBuddy failed: ${event.subtype}` : null,
        });
        flushCommits(true);
        emit({ type: "content.replace", ordinal: current.ordinal, content: current.content });
        return true;
      }
      return false;
    },
  };
}
