import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import type { ContentBlock, RuntimeExecutionEvent, RuntimeMessage, RuntimeTurnInput } from "@neta-art/cohub";
import { describeError } from "../../network-error.js";
import { JsonRpcProcess, record, type JsonRecord } from "../json-rpc.js";
import type { Executor } from "../native/execution.js";
import type { TranscriptState } from "../native/ingest.js";
import { projectChainedSession, projectionToolId } from "./chained-projection.js";
import {
  acceptsCursorDirectory, acceptsCursorTranscript, cursorChatsRoot, cursorProjectsRoot, cursorSessionHeader, cursorTranscriptPath, readCursorTranscript,
} from "./cursor-transcript.js";
import { array, harnessCommand, inlineImage, missing, text, turnEnvironment, watchHost } from "./process.js";
import type { HarnessModel, HarnessRun, HarnessTurn, LocalHarnessAdapter } from "./types.js";

const BINARY = "cursor-agent";
const PROVIDER = "cursor";
/** Runs without `--model`, so the model chosen in Cursor applies. */
const DEFAULT_MODEL = "default";
/** Public flags a Turn relies on; an executable whose help lacks one is an older or unrelated CLI. */
const REQUIRED_FLAGS = ["--print", "--output-format", "--stream-partial-output", "--resume", "--model", "--trust"];
const ABORT_ESCALATION_MS = 5_000;
const FLUSH_TIMEOUT_MS = 10_000;
/** The prompt is an argument: Linux caps one at 128 KiB, Windows a whole command line at 32K characters. */
const MAX_PROMPT_BYTES = process.platform === "win32" ? 30_000 : 120_000;
const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const HISTORY_KINDS = ["user", "assistant", "tool"];

const exec = promisify(execFile);
const command = (executable: string, args: string[], cwd: string, timeout: number) =>
  exec(...harnessCommand(executable, args, cwd), { cwd, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, NO_COLOR: "1" } });
const exists = (path: string) => access(path).then(() => true, () => false);

/** `cursor-agent models`: `<id> - <name> (current, default)` per line. */
export function cursorModels(output: string): HarnessModel[] {
  const models = new Map<string, string>();
  for (const line of stripVTControlCharacters(output).split(/\r?\n/)) {
    const match = /^(\S{1,255}) - (.+?)(?: \((?:current|default)(?:, (?:current|default))?\))?$/.exec(line.trim());
    if (match?.[1] && match[1] !== DEFAULT_MODEL && !models.has(match[1])) models.set(match[1], (match[2] ?? match[1]).slice(0, 255));
  }
  if (!models.size) throw new Error("Cursor lists no models; sign in with `cursor-agent login` or set CURSOR_API_KEY");
  return [[DEFAULT_MODEL, "Default"] as const, ...models].map(([id, name]) => ({ harness: "cursor", provider: PROVIDER, id, name, ...(id === DEFAULT_MODEL ? { isDefault: true } : {}) }));
}

/** A chat Cursor stored, wherever its workspace hash put it. */
async function chatStored(nativeSessionId: string): Promise<boolean> {
  const hashes = await readdir(cursorChatsRoot()).catch((error) => { if (missing(error)) return []; throw error; });
  for (const hash of hashes) if (await exists(join(cursorChatsRoot(), hash, nativeSessionId, "store.db"))) return true;
  return false;
}

/** The transcript Cursor wrote for a chat; its project name is the fast path. */
async function findTranscript(nativeSessionId: string, cwd: string): Promise<string | null> {
  const preferred = cursorTranscriptPath(nativeSessionId, cwd);
  if (await exists(preferred)) return preferred;
  const projects = await readdir(cursorProjectsRoot()).catch((error) => { if (missing(error)) return []; throw error; });
  for (const project of projects) {
    const candidate = join(cursorProjectsRoot(), project, "agent-transcripts", nativeSessionId, `${nativeSessionId}.jsonl`);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

function historyContent(block: ContentBlock): JsonRecord[] {
  if (block.type === "text") return [{ text: { text: block.text } }];
  if (block.type === "image" && block.source.type === "base64") return [{ image: { data: block.source.data, mimeType: block.source.media_type } }];
  return [];
}

/** Cursor calls are `{<kind>ToolCall: {args, result}}`; MCP calls name their tool in the arguments. */
function cursorTool(value: unknown): { name: string; input: Record<string, unknown>; result: JsonRecord | null } {
  const call = record(value);
  const [kind, body] = Object.entries(call).find(([key, entry]) => key.endsWith("ToolCall") && entry && typeof entry === "object") ?? [];
  if (!kind) {
    const fn = record(call.function);
    let input: Record<string, unknown>;
    try { input = record(JSON.parse(text(fn.arguments))); } catch { input = { raw: fn.arguments }; }
    return { name: text(fn.name) || "tool", input, result: null };
  }
  const tool = record(body), args = record(tool.args);
  const name = kind === "mcpToolCall" ? text(args.toolName) || text(args.name) || "mcp" : kind.slice(0, -"ToolCall".length);
  return { name, input: args, result: tool.result && typeof tool.result === "object" ? record(tool.result) : null };
}

function cursorResult(result: JsonRecord): { content: string; is_error: boolean } {
  const status = "success" in result ? "success" : Object.keys(result).find((key) => key !== "sandboxPolicy" && result[key] && typeof result[key] === "object") ?? "success";
  const body = record(result[status]);
  const output = text(body.interleavedOutput) || [text(body.stdout), text(body.stderr)].filter(Boolean).join("\n") || text(body.content)
    || array(body.content).map((item) => text(record(record(item).text).text)).filter(Boolean).join("\n")
    || text(body.error) || text(body.reason) || text(body.message);
  return { content: output || JSON.stringify(result[status] ?? null), is_error: status !== "success" };
}

function cursorUsage(value: unknown): RuntimeMessage["usage"] {
  const usage = record(value);
  const count = (key: string) => typeof usage[key] === "number" ? usage[key] as number : 0;
  const input = count("inputTokens"), output = count("outputTokens"), cacheRead = count("cacheReadTokens"), cacheWrite = count("cacheWriteTokens");
  return input || output || cacheRead || cacheWrite ? { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite } : undefined;
}

type Step = { ordinal: number; content: ContentBlock[]; modelCallId: string };

/**
 * Maps `--output-format stream-json --stream-partial-output` onto Cohub's streaming protocol. A reply
 * step ends once its tool calls returned. Cursor repeats a step's streamed text as one line right
 * before a tool call, question or retry (with a timestamp) and at the end (without one); such a line
 * is held until the next event says whether it was a repeat.
 */
export function cursorTranslator(emit: (event: RuntimeExecutionEvent) => void, identity: { model: string | null }) {
  const steps: Step[] = [];
  const owners = new Map<string, Step>();
  let current: Step | null = null;
  let open: { index: number; kind: "text" | "thinking" } | null = null;
  let streamed = "";
  let held: string | null = null;
  let model = identity.model;
  let final: RuntimeMessage | null = null;
  const settled = (step: Step) => step.content.some((block) => block.type === "tool_use")
    && step.content.every((block) => block.type !== "tool_use" || step.content.some((result) => result.type === "tool_result" && result.tool_use_id === block.id));
  const snapshot = (step: Step): RuntimeMessage => ({
    ordinal: step.ordinal, content: [...step.content], provider: PROVIDER, model,
    stopReason: step.content.some((block) => block.type === "tool_use") ? "tool_use" : "stop",
  });
  const target = (modelCallId = "") => {
    if (current && !(settled(current) && (!modelCallId || modelCallId !== current.modelCallId))) return current;
    if (current) emit({ type: "message.commit", message: snapshot(current) });
    current = { ordinal: steps.length, content: [], modelCallId };
    steps.push(current);
    open = null;
    emit({ type: "message.start", ordinal: current.ordinal });
    return current;
  };
  const replace = (step: Step) => emit({ type: "content.replace", ordinal: step.ordinal, content: [...step.content] });
  const append = (kind: "text" | "thinking", chunk: string) => {
    if (!chunk) return;
    const step = target();
    if (!open || open.kind !== kind || open.index !== step.content.length - 1) {
      step.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
      open = { index: step.content.length - 1, kind };
    }
    const block = step.content[open.index];
    step.content[open.index] = block?.type === "thinking" ? { type: "thinking", thinking: block.thinking + chunk } : { type: "text", text: (block?.type === "text" ? block.text : "") + chunk };
    emit({ type: "text.delta", ordinal: step.ordinal, index: open.index, kind, delta: chunk });
  };
  const streamText = (chunk: string) => { append("text", chunk); streamed += chunk; };
  const release = () => { if (held !== null) { const chunk = held; held = null; streamText(chunk); } };
  /** The whole of a step's text: new in non-partial output, otherwise authoritative over what streamed. */
  const whole = (value: string) => {
    release();
    const step = current;
    const last = step?.content.at(-1);
    if (!streamed) append("text", value);
    else if (value !== streamed && step && last?.type === "text" && last.text.endsWith(streamed)) {
      step.content[step.content.length - 1] = { type: "text", text: last.text.slice(0, last.text.length - streamed.length) + value };
      replace(step);
    }
    streamed = "";
  };
  const last = (): RuntimeMessage => current ? snapshot(current) : { ordinal: 0, content: [], provider: PROVIDER, model };
  return {
    result: () => final,
    last,
    push(event: JsonRecord): boolean {
      if (event.type === "assistant") {
        const value = array(record(event.message).content).map((block) => text(record(block).text)).join("");
        if (typeof event.timestamp_ms !== "number" || text(event.model_call_id)) whole(value);
        else if (streamed && value === streamed) { release(); held = value; }
        else { release(); streamText(value); }
        return false;
      }
      if ((event.type === "tool_call" && event.subtype === "started") || (event.type === "interaction_query" && event.subtype === "request") || event.type === "retry") {
        held = null; streamed = "";
      } else release();
      if (event.type === "system" && event.subtype === "init") { model ??= text(event.model) || null; return false; }
      if (event.type === "thinking") {
        if (event.subtype === "delta") append("thinking", text(event.text));
        else open = null;
        return false;
      }
      if (event.type === "tool_call") {
        const id = text(event.call_id);
        if (!id) return false;
        const tool = cursorTool(event.tool_call);
        const step = event.subtype === "started" ? target(text(event.model_call_id)) : owners.get(id);
        if (!step) return false;
        if (event.subtype === "started") {
          step.content.push({ type: "tool_use", id, name: tool.name, input: tool.input });
          step.modelCallId ||= text(event.model_call_id);
          owners.set(id, step);
          open = null;
        } else if (event.subtype === "completed") {
          const index = step.content.findIndex((block) => block.type === "tool_use" && block.id === id);
          if (index < 0) return false;
          step.content[index] = { type: "tool_use", id, name: tool.name, input: tool.input };
          const result = cursorResult(tool.result ?? {});
          const next = step.content[index + 1];
          step.content.splice(index + 1, next?.type === "tool_result" && next.tool_use_id === id ? 1 : 0, { type: "tool_result", tool_use_id: id, ...result });
        }
        replace(step);
        return false;
      }
      if (event.type !== "result") return false;
      const failed = event.is_error === true || event.subtype !== "success";
      final = { ...last(), stopReason: failed ? "error" : "stop", errorMessage: failed ? text(event.result) || "Turn failed" : null, usage: cursorUsage(event.usage) };
      return true;
    },
  };
}

/** The prompt is an argument; images go beside it as files. */
async function prompt(input: RuntimeTurnInput, directory: string): Promise<{ text: string; images: string[] }> {
  const parts: string[] = [], images: string[] = [];
  for (const block of input.messages.flatMap((message) => message.content)) {
    if (block.type !== "image") { parts.push(block.type === "text" ? block.text : JSON.stringify(block)); continue; }
    const image = await inlineImage(block);
    const path = join(directory, `image-${images.length + 1}.${IMAGE_EXTENSIONS[image.mimeType] ?? "png"}`);
    await writeFile(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
    images.push(path);
  }
  const value = parts.join("\n\n").trim() || (images.length ? "See the attached image." : "");
  if (Buffer.byteLength(value) > MAX_PROMPT_BYTES) throw new Error("Prompt is too long for the Cursor CLI command line; shorten the message");
  return { text: value, images };
}

/** Projected history becomes the CLI's conversation history file; the projection itself is not Cursor's transcript. */
async function handoff(path: string, directory: string): Promise<string> {
  const messages = (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => {
    const value = record(JSON.parse(line));
    return Object.fromEntries(HISTORY_KINDS.flatMap((kind) => kind in value ? [[kind, value[kind]]] : []));
  });
  await rm(path, { force: true });
  const file = join(directory, "history.json");
  await writeFile(file, JSON.stringify({ messages }), { mode: 0o600 });
  return file;
}

/**
 * One `cursor-agent -p` process per Turn. Without `--force`, commands outside the user's allowlist are
 * refused by the CLI itself; it answers its own questions and nothing is ever granted. Cohub's
 * history starts a chat through `--conversation-history-file`; later Turns `--resume` it.
 */
async function runCursor(executor: Executor, turn: HarnessTurn): Promise<HarnessRun> {
  const { input, signal, context } = turn;
  const prepare = (resumable: (transcript: TranscriptState) => boolean) => executor.sessions.prepare({
    sessionId: input.sessionId, turnId: input.turnId, harness: "cursor", cwd: executor.cwd,
    provider: input.provider, context: input.context, signal, resumable,
  });
  // Without a control plane, a terminal chat is read-only: Cohub continues only chats it started.
  let prepared = await prepare((transcript) => transcript.path !== turn.diverged && transcript.origin === "cohub");
  if (prepared.resume === "native" && !await chatStored(prepared.session.nativeSessionId)) prepared = await prepare(() => false);
  let session = prepared.session;
  const directory = await mkdtemp(join(tmpdir(), "cohub-cursor-"));
  const translator = cursorTranslator(turn.emit, { model: input.model && input.model !== DEFAULT_MODEL ? input.model : null });
  let message: RuntimeMessage = { ordinal: 0, content: [] };
  let host: JsonRpcProcess | null = null;
  try {
    const content = await prompt(input, directory);
    const args = [
      "-p", "--output-format", "stream-json", "--stream-partial-output", "--trust",
      ...(prepared.resume === "native" ? ["--resume", session.nativeSessionId] : ["--new-session-id", session.nativeSessionId]),
      ...(prepared.resume === "handoff" ? ["--conversation-history-file", await handoff(session.path, directory)] : []),
      ...(input.model && input.model !== DEFAULT_MODEL ? ["--model", input.model] : []),
      ...content.images.flatMap((path) => ["--image", path]),
      "--", content.text,
    ];
    signal.throwIfAborted();
    // The prompt is sent when the process starts.
    await turn.started(session);
    try {
      host = new JsonRpcProcess(...harnessCommand(executor.executables.cursor || BINARY, args, executor.cwd), executor.cwd, "stream", turnEnvironment(input));
      watchHost(host, executor.diagnostics, context);
      const child = host;
      await new Promise<void>((resolve, reject) => {
        let escalation: ReturnType<typeof setTimeout> | undefined;
        let done = false;
        const finish = (error?: unknown) => {
          if (done) return;
          done = true;
          off(); offFailure(); signal.removeEventListener("abort", abort); clearTimeout(escalation);
          if (error) reject(error); else resolve();
        };
        const offFailure = child.onFailure((error) => finish(error));
        const off = child.onEvent((event) => { try { if (translator.push(event)) finish(); } catch (error) { finish(error); } });
        const abort = () => {
          // The exit that follows a stop is expected.
          child.endInput();
          child.interrupt();
          escalation = setTimeout(() => void child.close().catch(() => undefined), ABORT_ESCALATION_MS);
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      message = translator.result() ?? translator.last();
      if (signal.aborted) message = { ...message, stopReason: "aborted", errorMessage: null };
    } catch (error) {
      message = { ...translator.last(), stopReason: signal.aborted ? "aborted" : "error", errorMessage: signal.aborted ? null : describeError(error) };
    }
    host?.endInput();
    await host?.exited(FLUSH_TIMEOUT_MS);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
  const path = await findTranscript(session.nativeSessionId, executor.cwd);
  if (path && (path !== session.path || prepared.resume === "new")) {
    session = { ...session, path };
    executor.ingest.adopt(session, input.sessionId);
  }
  return { session, resume: prepared.resume, message, host };
}

export const cursorHarness: LocalHarnessAdapter = {
  id: "cursor",
  binary: BINARY,
  async models(executable, cwd) {
    const { stdout: help } = await command(executable, ["--help"], cwd, 30_000);
    const missingFlags = REQUIRED_FLAGS.filter((flag) => !new RegExp(`(^|[\\s,])${flag}(?=[\\s,=<\\[]|$)`, "m").test(help));
    if (missingFlags.length) throw new Error(`${executable} is not a supported Cursor CLI (missing ${missingFlags.join(", ")}); update Cursor`);
    return cursorModels((await command(executable, ["models"], cwd, 60_000)).stdout);
  },
  run: runCursor,
  session: {
    path: cursorTranscriptPath,
    startsWithoutFile: true,
    // Records are Cursor's ConversationHistory messages, turned into the history file when the Turn starts.
    project: (input) => {
      const names = new Map<string, string>();
      return projectChainedSession(input, "cursor", { id: "cohubId", parent: "cohubParentId" }, (segment) => {
        if (segment.role === "user" && segment.blocks.some((block) => block.type === "tool_result")) {
          return segment.blocks.flatMap((block) => block.type !== "tool_result" ? [] : [{ tool: {
            toolCallId: projectionToolId(block.tool_use_id), toolName: names.get(block.tool_use_id) ?? "tool", isError: block.is_error ?? false,
            content: typeof block.content === "string" ? [{ text: { text: block.content } }] : block.content.flatMap(historyContent),
          } }]);
        }
        if (segment.role === "user") {
          const content = segment.blocks.flatMap(historyContent);
          return content.length ? [{ user: { content } }] : [];
        }
        const content = segment.blocks.flatMap((block) => {
          if (block.type !== "tool_use") return historyContent(block);
          names.set(block.id, block.name);
          return [{ toolCall: { toolCallId: projectionToolId(block.id), toolName: block.name, argsJson: JSON.stringify(block.input) } }];
        });
        return content.length ? [{ assistant: { content } }] : [];
      });
    },
    rebind: (records) => records,
  },
  transcript: {
    roots: () => [cursorProjectsRoot()],
    acceptsDirectory: acceptsCursorDirectory,
    acceptsTranscript: acceptsCursorTranscript,
    header: (path) => cursorSessionHeader(path),
    read: (path, signal) => readCursorTranscript(path, basename(path, ".jsonl"), signal),
    boundaries: ["<user_query>", '"type":"turn_ended"'],
    turnEndRecorded: true,
    userFinalMarked: false,
    globalTurnKeys: false,
    // The transcript keeps no ids, so the ledger records which Turn Cohub is running.
    marksCohubTurns: false,
  },
};
