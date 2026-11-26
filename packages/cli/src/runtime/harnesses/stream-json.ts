import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isModelThinkingLevel, thinkingLevelMapFor, type ContentBlock, type RuntimeExecutionEvent, type RuntimeMessage, type RuntimeTurnInput } from "@neta-art/cohub";
import { JsonRpcProcess, record, type JsonRecord } from "../json-rpc.js";
import { describeError } from "../../network-error.js";
import type { Executor } from "../native/execution.js";
import type { TranscriptState } from "../native/ingest.js";
import { array, closeHost, epochSecondsIso, harnessCommand, identifiable, inlineImage, missing, probe, text, turnEnvironment } from "./process.js";
import type { HarnessModel, HarnessRun, HarnessTurn } from "./types.js";

const REDACTED_THINKING = "[Reasoning redacted]";
/** A stop request that the harness does not honour within this long ends its process. */
const ABORT_ESCALATION_MS = 5_000;
/** After input closes, the CLI flushes its transcript; it is reaped when it does not exit by then. */
const FLUSH_TIMEOUT_MS = 10_000;
/**
 * Plan mode still honours the user's allow rules, so a read-only Turn also gets only these
 * built-in tools and no configured MCP servers.
 */
export const READ_ONLY_ARGS = ["--permission-mode", "plan", "--tools", "Read,Glob,Grep", "--strict-mcp-config"];
/** Flags every Turn relies on; an executable whose help lacks one is an older or unrelated CLI. */
const REQUIRED_FLAGS = ["--input-format", "--output-format", "--include-partial-messages", "--session-id", "--resume", "--permission-mode", "--tools", "--strict-mcp-config", "--model", "--effort"];
/** Runs without `--model`, so the CLI's own configuration and account default apply. */
export const DEFAULT_MODEL = "default";

/** A Claude Code–compatible CLI (`-p --input-format stream-json --output-format stream-json`). */
export type StreamJsonProfile = {
  harness: RuntimeTurnInput["harness"];
  label: string;
  binary: string;
  provider: string;
  endpoint?(named?: string | null): string;
  /** Root holding `projects/<project>/<session>.jsonl`. */
  dataRoot(): string;
  projectDirectory(cwd: string): string;
  /** Thinking levels offered when the CLI does not list a model's own. */
  effortLevels: readonly string[];
  /** The CLI keeps a stream-json prompt's `uuid` as its record id, so the file names the Cohub Turn. */
  promptUuid: boolean;
  /** A clean Turn's process is kept for the Session's next Turn. */
  warm?: boolean;
  /** Without it, a Turn with full access runs `acceptEdits` and every permission prompt is denied. */
  approvals?(executor: Executor, input: RuntimeTurnInput): Promise<StreamJsonApprovals | null>;
};

export type StreamJsonApprovals = {
  /** Replaces `--permission-mode acceptEdits`. */
  args: string[];
  /** Answers a `can_use_tool` request; absent, it is denied. */
  answer?(request: JsonRecord, signal: AbortSignal): Promise<JsonRecord>;
};

/** The CLI's help, after checking it offers every flag a Turn uses. */
export async function streamJsonHelp(profile: StreamJsonProfile, executable: string, cwd: string) {
  const { stdout } = await probe(harnessCommand(executable, ["--help"], cwd), cwd, 30_000);
  const missingFlags = REQUIRED_FLAGS.filter((flag) => !new RegExp(`(^|[\\s,])${flag}(?=[\\s,=<]|$)`, "m").test(stdout));
  if (missingFlags.length) throw new Error(`${executable} is not a supported ${profile.label} CLI (missing ${missingFlags.join(", ")}); update ${profile.label}`);
  return stdout;
}

export function streamJsonModel(profile: StreamJsonProfile, id: string, name: string, options: { reasoning: boolean; isDefault?: boolean; provider?: string; effortLevels?: readonly string[] }): HarnessModel {
  const effortLevels = options.effortLevels ?? profile.effortLevels;
  return {
    harness: profile.harness, provider: options.provider ?? profile.provider, id, name,
    ...(options.isDefault ? { isDefault: true } : {}),
    // An explicit `reasoning: false` lets Cohub fit any requested level to `off`, so no `--effort` is sent.
    ...(options.reasoning ? { reasoning: true, thinkingLevelMap: thinkingLevelMapFor((level) => effortLevels.includes(level) ? level : null) } : { reasoning: false }),
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

export function streamContent(value: unknown): ContentBlock[] {
  return array(value).flatMap((entry): ContentBlock[] => {
    const block = record(entry);
    if (block.type === "text") return [{ type: "text", text: text(block.text) }];
    if (block.type === "thinking") return [{ type: "thinking", thinking: text(block.thinking), ...(text(block.signature) ? { signature: text(block.signature) } : {}) }];
    if (block.type === "redacted_thinking") return text(block.data) ? [{ type: "thinking", thinking: REDACTED_THINKING, signature: text(block.data), redacted: true }] : [];
    if (block.type === "tool_use") return identifiable(block.id) && identifiable(block.name) ? [{ type: "tool_use", id: block.id, name: block.name, input: record(block.input) }] : [];
    const source = record(block.source);
    if (block.type === "image" && source.type === "base64") return [{ type: "image", source: { type: "base64", data: text(source.data), media_type: text(source.media_type) } }];
    return [];
  });
}

export function streamUsage(value: unknown, cost: unknown): RuntimeMessage["usage"] {
  const usage = record(value);
  const count = (key: string) => typeof usage[key] === "number" ? usage[key] as number : 0;
  const input = count("input_tokens"), output = count("output_tokens"), cacheRead = count("cache_read_input_tokens"), cacheWrite = count("cache_creation_input_tokens");
  if (!input && !output && !cacheRead && !cacheWrite) return undefined;
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, ...(typeof cost === "number" && cost > 0 ? { cost: { total: cost } } : {}) };
}

async function prompt(profile: StreamJsonProfile, input: RuntimeTurnInput) {
  const content = await Promise.all(input.messages.flatMap((message) => message.content).map(async (block): Promise<JsonRecord> => {
    if (block.type !== "image") return { type: "text", text: block.type === "text" ? block.text : JSON.stringify(block) };
    const image = await inlineImage(block);
    return { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } };
  }));
  return { type: "user", ...(profile.promptUuid ? { uuid: input.turnId } : {}), message: { role: "user", content } };
}

/** Whether a session file already records this Turn's prompt (the CLI silently drops a repeated `uuid`). */
async function holdsPrompt(path: string, turnId: string, signal: AbortSignal): Promise<boolean> {
  const token = Buffer.from(`"uuid":"${turnId}"`);
  let tail = Buffer.alloc(0);
  try {
    for await (const chunk of createReadStream(path, { signal })) {
      const bytes = Buffer.concat([tail, chunk as Buffer]);
      if (bytes.includes(token)) return true;
      tail = bytes.subarray(Math.max(0, bytes.length - token.length + 1));
    }
  } catch (error) { if (!missing(error)) throw error; }
  return false;
}

/** `partial` holds streamed blocks by index until the complete block arrives, so an interrupted reply keeps them. */
type Message = { ordinal: number; content: ContentBlock[]; partial: Map<number, Extract<ContentBlock, { type: "text" | "thinking" }>>; model: string | null; usage?: JsonRecord };

/** Claude Code labels locally built replies (API errors, interrupts) `<synthetic>`; they name no model. */
const nativeModel = (value: unknown) => { const model = text(value); return model && model !== "<synthetic>" ? model : null; };

/** Maps stream-json output onto Cohub's streaming protocol; sub-agent traffic stays in the native transcript. */
/** `spent`: the cumulative `total_cost_usd` a kept process already reported. */
export function streamJsonTranslator(emit: (event: RuntimeExecutionEvent) => void, identity: { provider: string; model: string | null }, spent = 0) {
  const messages = new Map<string, Message>();
  const owners = new Map<string, Message>();
  let current: Message | null = null;
  let streaming: Message | null = null;
  let model = identity.model;
  let final: RuntimeMessage | null = null;
  let rejected: RuntimeMessage["usageLimit"] = null;
  const counts = (value: unknown) => Object.fromEntries(Object.entries(record(value)).filter(([, count]) => typeof count === "number"));
  const snapshot = (message: Message): RuntimeMessage => ({
    ordinal: message.ordinal, content: [...message.content, ...message.partial.values()], provider: identity.provider, model: message.model ?? model,
    usage: streamUsage(message.usage, undefined),
    stopReason: message.content.some((block) => block.type === "tool_use") ? "tool_use" : "stop",
  });
  const begin = (id: string, messageModel: string | null) => {
    const existing = messages.get(id);
    if (existing) return existing;
    if (current) emit({ type: "message.commit", message: snapshot(current) });
    if (messageModel) model = messageModel;
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
      if (event.type === "system" && event.subtype === "init") { model = nativeModel(event.model) ?? model; return false; }
      if (event.type === "stream_event") {
        const stream = record(event.event);
        if (stream.type === "message_start") {
          const native = record(stream.message);
          streaming = begin(text(native.id) || randomUUID(), nativeModel(native.model));
          streaming.usage = counts(native.usage);
        }
        if (streaming && stream.type === "message_delta") streaming.usage = { ...streaming.usage, ...counts(stream.usage) };
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
        const message = begin(text(native.id) || randomUUID(), nativeModel(native.model));
        message.usage = { ...message.usage, ...counts(native.usage) };
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
      if (event.type === "rate_limit_event") {
        const info = record(event.rate_limit_info);
        rejected = info.status === "rejected" ? { resetAt: epochSecondsIso(info.resetsAt) } : null;
        return false;
      }
      if (event.type !== "result") return false;
      const failed = event.is_error === true || event.subtype !== "success";
      const usageLimit = failed ? rejected ?? (event.api_error_status === 429 ? { resetAt: null } : null) : null;
      const reply = last();
      if (reply.usage) reply.usage.contextTokens = (reply.usage.input ?? 0) + (reply.usage.cacheRead ?? 0) + (reply.usage.cacheWrite ?? 0);
      const cost = typeof event.total_cost_usd === "number" ? event.total_cost_usd - spent : 0;
      if (cost > 0) reply.usage = { ...reply.usage, cost: { total: cost } };
      final = {
        ...reply,
        stopReason: failed ? "error" : "stop",
        errorMessage: failed ? text(event.result) || array(event.errors).map(text).join("\n") || text(event.subtype) || "Turn failed" : null,
        ...(usageLimit ? { usageLimit } : {}),
      };
      return true;
    },
  };
}

const WAKING_TOOLS = new Set(["ScheduleWakeup", "CronCreate", "Monitor"]);

const startsBackgroundWork = (event: JsonRecord) =>
  (event.type === "system" && text(event.subtype).startsWith("task_"))
  || (event.type === "assistant" && array(record(event.message).content).map(record).some((block) =>
    block.type === "tool_use" && (WAKING_TOOLS.has(text(block.name)) || record(block.input).run_in_background === true)));

const spentBy = new WeakMap<JsonRpcProcess, number>();

const startsTurn = (event: JsonRecord) => ["assistant", "user", "stream_event", "control_request", "result"].includes(text(event.type)) || (event.type === "system" && event.subtype === "init");

/**
 * One process per Turn, or kept for the next one with a warm profile. Cohub grants a permission prompt only
 * through the profile's approvals; otherwise workspace edits follow `acceptEdits` and every other tool the
 * user's own rules.
 */
export async function runStreamJson(profile: StreamJsonProfile, executor: Executor, turn: HarnessTurn): Promise<HarnessRun> {
  const { input, signal } = turn;
  const prepare = (resumable: (transcript: TranscriptState) => boolean) => executor.sessions.prepare({
    sessionId: input.sessionId, turnId: input.turnId, harness: profile.harness, cwd: executor.cwd,
    provider: input.provider, context: input.context, signal, resumable,
  });
  // Without a control plane, a terminal conversation is read-only: Cohub continues only files it wrote.
  let prepared = await prepare((transcript) => transcript.path !== turn.diverged && transcript.origin === "cohub");
  // A retried Turn whose prompt is already in the file would be dropped, so it continues from history.
  if (profile.promptUuid && prepared.resume === "native" && await holdsPrompt(prepared.session.path, input.turnId, signal)) prepared = await prepare(() => false);
  let session = prepared.session;
  const approvals = await profile.approvals?.(executor, input) ?? null;
  // Cohub has already fitted the level to the levels the model declares; these CLIs have no `off` effort.
  const effort = isModelThinkingLevel(input.thinkingLevel) && input.thinkingLevel !== "off" ? input.thinkingLevel : null;
  const executable = executor.executables[profile.harness] || profile.binary;
  const settings = [
    ...(input.accessMode === "read_only" ? READ_ONLY_ARGS : approvals?.args ?? ["--permission-mode", "acceptEdits"]),
    ...(input.model && input.model !== DEFAULT_MODEL ? ["--model", input.model] : []),
    ...(effort ? ["--effort", effort] : []),
  ];
  const launch = JSON.stringify([executable, settings]);
  const args = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    ...(prepared.resume === "new" ? ["--session-id", session.nativeSessionId] : ["--resume", session.nativeSessionId]),
    ...settings,
  ];
  const content = await prompt(profile, input);
  signal.throwIfAborted();
  const kept = profile.warm ? await executor.warm.take(input.sessionId, prepared.resume === "native" ? session.nativeSessionId : "", launch) : null;
  const { COHUB_TURN_ID: _turnId, ...sessionEnvironment } = turnEnvironment(input);
  const host = kept ?? new JsonRpcProcess(...harnessCommand(executable, args, executor.cwd), executor.cwd, "stream", profile.warm ? sessionEnvironment : turnEnvironment(input));
  turn.spawned(host);
  let background = false;
  const translator = streamJsonTranslator(turn.emit, { provider: profile.endpoint?.(input.provider) || input.provider || profile.provider, model: input.model && input.model !== DEFAULT_MODEL ? input.model : null }, spentBy.get(host));
  let message: RuntimeMessage = { ordinal: 0, content: [] };
  let begun = false;
  // Open approvals close with the process, not only when the Turn is stopped.
  const approvalScope = new AbortController();
  try {
    signal.throwIfAborted();
    await turn.started(session);
    begun = true;
    await new Promise<void>((resolve, reject) => {
      let escalation: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = (error?: unknown) => {
        if (done) return;
        done = true;
        off(); offFailure(); signal.removeEventListener("abort", abort); clearTimeout(escalation);
        approvalScope.abort();
        if (error) reject(error); else resolve();
      };
      const offFailure = host.onFailure((error) => finish(error));
      const off = host.onEvent((event) => {
        if (event.type === "control_request") {
          const respond = (response: JsonRecord) => host.write({ type: "control_response", response: { subtype: "success", request_id: event.request_id, response } });
          const request = record(event.request);
          if (approvals?.answer && request.subtype === "can_use_tool" && input.accessMode !== "read_only") {
            void approvals.answer(request, AbortSignal.any([signal, approvalScope.signal]))
              .catch((): JsonRecord => ({ behavior: "deny", message: "Approval failed" }))
              .then((response) => {
                if (done) return;
                try { respond(response); } catch (error) { finish(error); }
              });
            return;
          }
          try { respond({ behavior: "deny", message: "Approval requires an interactive local client" }); }
          catch (error) { finish(error); }
          return;
        }
        if (startsBackgroundWork(event)) background = true;
        if (event.type === "result" && typeof event.total_cost_usd === "number") spentBy.set(host, event.total_cost_usd);
        try { if (translator.push(event)) finish(); } catch (error) { finish(error); }
      });
      const abort = () => {
        try { host.write({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } }); } catch { /* Escalation closes the process. */ }
        escalation = setTimeout(() => void host.close().catch(() => undefined), ABORT_ESCALATION_MS);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { finish(); return; }
      try { host.write(content); } catch (error) { finish(error); }
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
  const keep = profile.warm && !signal.aborted && message.stopReason === "stop" && !background;
  if (!keep) {
    // Closing input lets the CLI flush its transcript before the executor reaps the process.
    host.endInput();
    await host.exited(FLUSH_TIMEOUT_MS);
  }
  const path = await findSession(profile, session.nativeSessionId, executor.cwd);
  if (path && (path !== session.path || prepared.resume === "new")) {
    session = { ...session, path };
    executor.ingest.adopt(session, input.sessionId);
  }
  if (!keep) return { session, resume: prepared.resume, message, host };
  executor.warm.keep(input.sessionId, session.nativeSessionId, launch, host, startsTurn);
  return { session, resume: prepared.resume, message, host: null };
}
