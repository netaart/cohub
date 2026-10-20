import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ContentBlock, RuntimeExecutionEvent, RuntimeMessage, RuntimeTurnInput } from "@neta-art/cohub";
import { JsonRpcProcess, record, type JsonRecord } from "../json-rpc.js";
import { describeError } from "../../network-error.js";
import type { Executor } from "../native/execution.js";
import { array, closeHost, harnessCommand, identifiable, inlineImage, missing, text, turnEnvironment, watchHost } from "./process.js";
import type { HarnessModel, HarnessRun, HarnessTurn } from "./types.js";

/** A stop request that the harness does not honour within this long ends its process. */
const ABORT_ESCALATION_MS = 5_000;
/** After input closes, the CLI flushes its transcript; it is reaped when it does not exit by then. */
const FLUSH_TIMEOUT_MS = 10_000;
/**
 * Plan mode still honours the user's allow rules, so a read-only Turn also gets only these
 * built-in tools and no configured MCP servers.
 */
const READ_ONLY_TOOLS = "Read,Glob,Grep";
/** Flags every Turn relies on; an executable whose help lacks one is an older or unrelated CLI. */
const REQUIRED_FLAGS = ["--input-format", "--output-format", "--include-partial-messages", "--session-id", "--resume", "--permission-mode", "--tools", "--strict-mcp-config", "--model", "--effort"];
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** Runs without `--model`, so the CLI's own configuration and account default apply. */
export const DEFAULT_MODEL = "default";

/** A Claude Code–compatible CLI (`-p --input-format stream-json --output-format stream-json`). */
export type StreamJsonProfile = {
  harness: RuntimeTurnInput["harness"];
  label: string;
  binary: string;
  provider: string;
  /** Root holding `projects/<project>/<session>.jsonl`. */
  dataRoot(): string;
  projectDirectory(cwd: string): string;
  /** Thinking levels accepted by `--effort`. */
  effortLevels: readonly string[];
};

/** The CLI's help, after checking it offers every flag a Turn uses. */
export async function streamJsonHelp(profile: StreamJsonProfile, executable: string, cwd: string) {
  const { stdout } = await promisify(execFile)(...harnessCommand(executable, ["--help"], cwd), { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const missingFlags = REQUIRED_FLAGS.filter((flag) => !new RegExp(`(^|[\\s,])${flag}(?=[\\s,=<]|$)`, "m").test(stdout));
  if (missingFlags.length) throw new Error(`${executable} is not a supported ${profile.label} CLI (missing ${missingFlags.join(", ")}); update ${profile.label}`);
  return stdout;
}

export function streamJsonModel(profile: StreamJsonProfile, id: string, name: string, options: { reasoning: boolean; isDefault?: boolean }): HarnessModel {
  return {
    harness: profile.harness, provider: profile.provider, id, name,
    ...(options.isDefault ? { isDefault: true } : {}),
    ...(options.reasoning ? { reasoning: true, thinkingLevelMap: Object.fromEntries(THINKING_LEVELS.map((level) => [level, profile.effortLevels.includes(level) ? level : null])) } : {}),
  };
}

/** A session's file is found by id; the project directory naming is only the fast path. */
async function findSession(profile: StreamJsonProfile, nativeSessionId: string, cwd: string): Promise<string | null> {
  const name = `${nativeSessionId}.jsonl`;
  const exists = (path: string) => access(path).then(() => true, () => false);
  const preferred = (() => { try { return join(profile.projectDirectory(cwd), name); } catch { return null; } })();
  if (preferred && await exists(preferred)) return preferred;
  const projects = join(profile.dataRoot(), "projects");
  const entries = await readdir(projects, { withFileTypes: true }).catch((error) => { if (missing(error)) return []; throw error; });
  for (const entry of entries) {
    const candidate = join(projects, entry.name, name);
    if (entry.isDirectory() && await exists(candidate)) return candidate;
  }
  return null;
}

function streamContent(value: unknown): ContentBlock[] {
  return array(value).flatMap((entry): ContentBlock[] => {
    const block = record(entry);
    if (block.type === "text") return [{ type: "text", text: text(block.text) }];
    if (block.type === "thinking") return [{ type: "thinking", thinking: text(block.thinking), ...(text(block.signature) ? { signature: text(block.signature) } : {}) }];
    if (block.type === "tool_use") return identifiable(block.id) && identifiable(block.name) ? [{ type: "tool_use", id: block.id, name: block.name, input: record(block.input) }] : [];
    const source = record(block.source);
    if (block.type === "image" && source.type === "base64") return [{ type: "image", source: { type: "base64", data: text(source.data), media_type: text(source.media_type) } }];
    return [];
  });
}

function streamUsage(value: unknown, cost: unknown): RuntimeMessage["usage"] {
  const usage = record(value);
  const count = (key: string) => typeof usage[key] === "number" ? usage[key] as number : 0;
  const input = count("input_tokens"), output = count("output_tokens"), cacheRead = count("cache_read_input_tokens"), cacheWrite = count("cache_creation_input_tokens");
  if (!input && !output && !cacheRead && !cacheWrite) return undefined;
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, ...(typeof cost === "number" && cost > 0 ? { cost: { total: cost } } : {}) };
}

async function prompt(input: RuntimeTurnInput) {
  const content = await Promise.all(input.messages.flatMap((message) => message.content).map(async (block): Promise<JsonRecord> => {
    if (block.type !== "image") return { type: "text", text: block.type === "text" ? block.text : JSON.stringify(block) };
    const image = await inlineImage(block);
    return { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } };
  }));
  return { type: "user", message: { role: "user", content } };
}

/** `partial` holds streamed blocks by index until the complete block arrives, so an interrupted reply keeps them. */
type Message = { ordinal: number; content: ContentBlock[]; partial: Map<number, Extract<ContentBlock, { type: "text" | "thinking" }>>; model: string | null };

/** Maps stream-json output onto Cohub's streaming protocol; sub-agent traffic stays in the native transcript. */
function streamJsonTranslator(emit: (event: RuntimeExecutionEvent) => void, identity: { provider: string; model: string | null }) {
  const messages = new Map<string, Message>();
  const owners = new Map<string, Message>();
  let current: Message | null = null;
  let streaming: Message | null = null;
  let model = identity.model;
  let final: RuntimeMessage | null = null;
  const snapshot = (message: Message): RuntimeMessage => ({
    ordinal: message.ordinal, content: [...message.content, ...message.partial.values()], provider: identity.provider, model: message.model ?? model,
    stopReason: message.content.some((block) => block.type === "tool_use") ? "tool_use" : "stop",
  });
  const begin = (id: string, messageModel: string | null) => {
    const existing = messages.get(id);
    if (existing) return existing;
    if (current) emit({ type: "message.commit", message: snapshot(current) });
    const message: Message = { ordinal: messages.size, content: [], partial: new Map(), model: messageModel };
    messages.set(id, message);
    current = message;
    emit({ type: "message.start", ordinal: message.ordinal });
    return message;
  };
  const last = (): RuntimeMessage => current ? snapshot(current) : { ordinal: 0, content: [], provider: identity.provider, model };
  return {
    /** The final `result`, or `null` while the Turn runs. */
    result: () => final,
    last,
    push(event: JsonRecord): boolean {
      if (event.parent_tool_use_id) return false;
      if (event.type === "system" && event.subtype === "init") { model = text(event.model) || model; return false; }
      if (event.type === "stream_event") {
        const stream = record(event.event);
        if (stream.type === "message_start") streaming = begin(text(record(stream.message).id) || randomUUID(), text(record(stream.message).model) || null);
        const delta = record(stream.delta);
        if (streaming && stream.type === "content_block_delta" && (delta.type === "text_delta" || delta.type === "thinking_delta")) {
          const index = Number(stream.index ?? 0), chunk = text(delta.text ?? delta.thinking);
          const previous = streaming.partial.get(index);
          streaming.partial.set(index, delta.type === "text_delta"
            ? { type: "text", text: (previous?.type === "text" ? previous.text : "") + chunk }
            : { type: "thinking", thinking: (previous?.type === "thinking" ? previous.thinking : "") + chunk });
          emit({ type: "text.delta", ordinal: streaming.ordinal, index, kind: delta.type === "text_delta" ? "text" : "thinking", delta: chunk });
        }
        return false;
      }
      if (event.type === "assistant") {
        const native = record(event.message);
        const message = begin(text(native.id) || randomUUID(), text(native.model) || null);
        // Complete blocks supersede what streamed so far.
        message.partial.clear();
        for (const block of streamContent(native.content)) {
          const index = block.type === "tool_use" ? message.content.findIndex((existing) => existing.type === "tool_use" && existing.id === block.id) : -1;
          if (index >= 0) message.content[index] = block;
          else message.content.push(block);
          if (block.type === "tool_use") owners.set(block.id, message);
        }
        emit({ type: "content.replace", ordinal: message.ordinal, content: [...message.content] });
        return false;
      }
      if (event.type === "user") {
        for (const entry of array(record(event.message).content)) {
          const block = record(entry);
          const id = text(block.tool_use_id);
          const owner = block.type === "tool_result" ? owners.get(id) : undefined;
          if (!owner) continue;
          owner.content = owner.content.filter((existing) => existing.type !== "tool_result" || existing.tool_use_id !== id);
          owner.content.push({ type: "tool_result", tool_use_id: id, content: typeof block.content === "string" ? block.content : streamContent(block.content), is_error: Boolean(block.is_error) });
          emit({ type: "content.replace", ordinal: owner.ordinal, content: [...owner.content] });
        }
        return false;
      }
      if (event.type !== "result") return false;
      const failed = event.is_error === true || event.subtype !== "success";
      final = {
        ...last(),
        stopReason: failed ? "error" : "stop",
        errorMessage: failed ? text(event.result) || array(event.errors).map(text).join("\n") || text(event.subtype) || "Turn failed" : null,
        usage: streamUsage(event.usage, event.total_cost_usd),
      };
      return true;
    },
  };
}

/**
 * One Turn per process. Unattended execution never grants an approval: workspace edits follow
 * `acceptEdits` and every other tool follows the user's own permission rules.
 */
export async function runStreamJson(profile: StreamJsonProfile, executor: Executor, turn: HarnessTurn): Promise<HarnessRun> {
  const { input, signal, context } = turn;
  const prepared = await executor.sessions.prepare({
    sessionId: input.sessionId, turnId: input.turnId, harness: profile.harness, cwd: executor.cwd,
    provider: input.provider, context: input.context, signal,
    // Only a file Cohub wrote and advanced is continued; nothing else writes to it.
    resumable: (transcript) => transcript.path !== turn.diverged && transcript.origin === "cohub",
  });
  let session = prepared.session;
  const effort = input.thinkingLevel && profile.effortLevels.includes(input.thinkingLevel) ? input.thinkingLevel : null;
  const args = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    ...(prepared.resume === "new" ? ["--session-id", session.nativeSessionId] : ["--resume", session.nativeSessionId]),
    ...(input.accessMode === "read_only" ? ["--permission-mode", "plan", "--tools", READ_ONLY_TOOLS, "--strict-mcp-config"] : ["--permission-mode", "acceptEdits"]),
    ...(input.model && input.model !== DEFAULT_MODEL ? ["--model", input.model] : []),
    ...(effort ? ["--effort", effort] : []),
  ];
  const content = await prompt(input);
  signal.throwIfAborted();
  const host = new JsonRpcProcess(...harnessCommand(executor.executables[profile.harness] || profile.binary, args, executor.cwd), executor.cwd, "stream", turnEnvironment(input));
  watchHost(host, executor.diagnostics, context);
  const translator = streamJsonTranslator(turn.emit, { provider: profile.provider, model: input.model && input.model !== DEFAULT_MODEL ? input.model : null });
  let message: RuntimeMessage = { ordinal: 0, content: [] };
  let begun = false;
  try {
    await turn.started(session);
    begun = true;
    await new Promise<void>((resolve, reject) => {
      let escalation: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = (error?: unknown) => {
        if (done) return;
        done = true;
        off(); offFailure(); signal.removeEventListener("abort", abort); clearTimeout(escalation);
        if (error) reject(error); else resolve();
      };
      const offFailure = host.onFailure((error) => finish(error));
      const off = host.onEvent((event) => {
        // An unattended Cohub Turn never grants a permission request.
        if (event.type === "control_request") {
          try { host.write({ type: "control_response", response: { subtype: "success", request_id: event.request_id, response: { behavior: "deny", message: "Approval requires an interactive local client" } } }); }
          catch (error) { finish(error); }
          return;
        }
        try { if (translator.push(event)) finish(); } catch (error) { finish(error); }
      });
      const abort = () => {
        try { host.write({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } }); } catch { /* Escalation closes the process. */ }
        escalation = setTimeout(() => void host.close().catch(() => undefined), ABORT_ESCALATION_MS);
      };
      signal.addEventListener("abort", abort, { once: true });
      try { host.write(content); } catch (error) { finish(error); }
      if (signal.aborted) abort();
    });
    message = translator.result() ?? translator.last();
    // A stopped Turn ends with an error result; the stop is not a failure to report.
    if (signal.aborted) message = { ...message, stopReason: "aborted", errorMessage: null };
  } catch (error) {
    if (!begun) {
      await closeHost(host, null).catch(() => undefined);
      throw error;
    }
    message = { ...translator.last(), stopReason: signal.aborted ? "aborted" : "error", errorMessage: signal.aborted ? null : describeError(error) };
  }
  // Closing input lets the CLI flush its transcript before the executor reaps the process.
  host.endInput();
  await host.exited(FLUSH_TIMEOUT_MS);
  const path = await findSession(profile, session.nativeSessionId, executor.cwd);
  if (path && (path !== session.path || prepared.resume === "new")) {
    session = { ...session, path };
    executor.ingest.adopt(session, input.sessionId);
  }
  return { session, resume: prepared.resume, message, host };
}
