import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import type { ContentBlock, RuntimeExecutionEvent, RuntimeMessage, RuntimeTurnInput } from "@neta-art/cohub";
import { describeError } from "../../network-error.js";
import { JsonRpcProcess, record, type JsonRecord } from "../json-rpc.js";
import type { Executor } from "../native/execution.js";
import type { TranscriptState } from "../native/ingest.js";
import { projectChainedSession, projectionToolId } from "./chained-projection.js";
import {
  acceptsCursorDirectory, acceptsCursorTranscript, cursorChatsRoot, cursorConfigDirectory, cursorProjectsRoot, cursorSessionHeader, cursorTranscriptPath, readCursorTranscript,
} from "./cursor-transcript.js";
import { array, harnessCommand, harnessExecutableCandidates, inlineImage, missing, text, turnEnvironment, watchHost } from "./process.js";
import type { HarnessModel, HarnessRun, HarnessTurn, LocalHarnessAdapter } from "./types.js";

const BINARY = "cursor-agent";
const PROVIDER = "cursor";
/** Runs without `--model`, so the model chosen in Cursor applies. */
const DEFAULT_MODEL = "default";
/**
 * Every flag a Turn passes, some of them hidden from `--help`. The CLI rejects an unknown option
 * before anything else and an invalid session id right after, so this probe starts no chat.
 */
const PROBE = ["-p", "--output-format", "stream-json", "--stream-partial-output", "--trust", "--new-session-id", "probe", "--conversation-history-file", "probe", "--image", "probe", "--resume", "probe", "--model", "probe", "--", "probe"];
/** Keys `--model` writes to `cli-config.json` as the user's default (Cursor persists any model it starts with). */
const MODEL_PREFERENCE = ["model", "hasChangedDefaultModel", "maxMode", "maxModeAutoEnabled"];
/** Waiting longer than this on a live owner (or a reused pid) fails the Turn instead of stalling it. */
const LOCK_WAIT_MS = 30_000;
const ABORT_ESCALATION_MS = 5_000;
const FLUSH_TIMEOUT_MS = 10_000;
/** The prompt is an argument: Linux caps one at 128 KiB, Windows a whole command line at 32K characters. */
const MAX_PROMPT_BYTES = process.platform === "win32" ? 30_000 : 120_000;
const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const HISTORY_KINDS = ["user", "assistant", "tool"];

const VERSION_DIRECTORY = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/;

/**
 * Cursor's Windows install puts `cursor-agent.cmd` on PATH, which starts PowerShell to run the newest
 * `versions\<version>\node.exe index.js`. A shell would re-quote the prompt, so this resolves the
 * same Node entry the launcher would and runs it directly.
 */
function cursorLauncher(shim: string): [string, string] | null {
  const runnable = (directory: string): [string, string] | null => {
    const node = join(directory, "node.exe"), entry = join(directory, "index.js");
    return existsSync(node) && existsSync(entry) ? [node, entry] : null;
  };
  const beside = runnable(dirname(shim));
  if (beside) return beside;
  const versions = join(dirname(shim), "versions");
  const day = (name: string) => { const match = VERSION_DIRECTORY.exec(name); return match ? Number(`${match[1]}${match[2]?.padStart(2, "0")}${match[3]?.padStart(2, "0")}`) : -1; };
  let entries: string[] = [];
  try { entries = readdirSync(versions).filter((name) => day(name) >= 0 && statSync(join(versions, name)).isDirectory()); } catch { return null; }
  entries.sort((left, right) => day(right) - day(left) || right.localeCompare(left));
  for (const name of entries) {
    const found = runnable(join(versions, name));
    if (found) return found;
  }
  return null;
}

/** The process a Cursor CLI invocation runs, and the variables its launcher would set. */
export function cursorCommand(executable: string, args: string[], cwd: string): { command: [string, string[]]; env: Record<string, string> } {
  if (process.platform !== "win32") return { command: harnessCommand(executable, args, cwd), env: {} };
  const shim = harnessExecutableCandidates(executable, cwd, process.env.PATH ?? "").find((candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile());
  const launcher = shim && [".cmd", ".ps1", ".bat"].includes(extname(shim).toLowerCase()) ? cursorLauncher(shim) : null;
  if (!shim || !launcher) return { command: harnessCommand(executable, args, cwd), env: {} };
  return {
    command: [launcher[0], [launcher[1], ...args]],
    env: { CURSOR_INVOKED_AS: basename(shim), ...(process.env.NODE_COMPILE_CACHE ? {} : { NODE_COMPILE_CACHE: join(process.env.LOCALAPPDATA ?? dirname(dirname(shim)), "cursor-compile-cache") }) },
  };
}

const exec = promisify(execFile);
const command = (executable: string, args: string[], cwd: string, timeout: number) => {
  const run = cursorCommand(executable, args, cwd);
  return exec(...run.command, { cwd, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...run.env, NO_COLOR: "1" } });
};
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

/** Shared by every Runtime process on this machine, one per Cursor config file. */
const preferenceRecord = (config: string) => join(process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state"), "cohub", `cursor-model-${createHash("sha256").update(config).digest("hex").slice(0, 16)}.json`);
type PreferenceHold = { id: string; pid: number };
type PreferenceRecord = { config: string; baseline: JsonRecord | null; requested: string[]; holders: PreferenceHold[] };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
const readJson = (path: string) => readFile(path, "utf8").then((raw) => record(JSON.parse(raw)), () => null);
async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path).catch(async (error: unknown) => { await rm(temporary, { force: true }); throw error; });
}
/**
 * A lock directory naming its owner's pid, published by renaming a prepared one into place, so it
 * never exists without its owner. It is taken over only once that process is gone, by one waiter
 * that renames it aside, so a live owner always releases its own lock.
 */
async function locked<T>(path: string, run: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`, draft = `${lock}.${randomUUID()}`;
  await mkdir(draft, { recursive: true, mode: 0o700 });
  await writeFile(join(draft, String(process.pid)), "");
  try {
    for (const deadline = Date.now() + LOCK_WAIT_MS; ;) {
      // Renaming onto an existing lock (which always holds its owner) fails.
      if (await rename(draft, lock).then(() => true, () => false)) break;
      const [owner] = await readdir(lock).catch(() => []);
      if (!owner || !alive(Number(owner))) {
        const aside = `${lock}.${randomUUID()}`;
        if (await rename(lock, aside).then(() => true, () => false)) await rm(aside, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Another process (pid ${owner}) holds ${lock}; if no Cohub Runtime is running, remove it and retry`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } catch (error) {
    await rm(draft, { recursive: true, force: true });
    throw error;
  }
  // Released by renaming it aside first, so the lock never exists without its owner.
  try { return await run(); } finally {
    const aside = `${lock}.${randomUUID()}`;
    if (await rename(lock, aside).then(() => true, () => false)) await rm(aside, { recursive: true, force: true });
  }
}
const savedModel = (config: JsonRecord | null) => { const model = record(config?.model); return text(model.displayModelId) || text(model.modelId); };

/** Put the baseline back once no Turn holds it, unless the saved model is none the holders chose. Returns the config now saved. */
async function restoreBaseline(config: string, stored: PreferenceRecord): Promise<JsonRecord | null> {
  const [before, after] = [stored.baseline, await readJson(config)];
  const saved = record(after?.model);
  const ours = [text(saved.modelId), text(saved.displayModelId)].some((value) => stored.requested.includes(value));
  if (!before || !after || !ours || MODEL_PREFERENCE.every((key) => JSON.stringify(after[key]) === JSON.stringify(before[key]))) return after;
  const restored = { ...after };
  for (const key of MODEL_PREFERENCE) { if (key in before) restored[key] = before[key]; else delete restored[key]; }
  await writeJson(config, restored);
  return restored;
}

/**
 * Cursor saves the model a run starts with as the user's default. Turns that choose a model hold the
 * preference from before the first of them; once the last one ends it is put back, unless the saved
 * model is none of theirs (the user picked another meanwhile). A Default Turn that overlaps them runs
 * on that preference rather than on another Turn's model. Returns the model to pass, if any.
 */
async function holdModelPreference(requested: string | null): Promise<{ model: string | null; release: () => Promise<void> }> {
  const config = join(cursorConfigDirectory(), "cli-config.json"), path = preferenceRecord(config), id = randomUUID();
  const model = await locked(path, async () => {
    const stored = await readJson(path) as PreferenceRecord | null;
    const holders = stored ? stored.holders.filter((hold) => alive(hold.pid)) : [];
    // Holders that died (a crashed Runtime) left Cursor on their model; their baseline comes back first.
    const current = holders.length && stored ? stored : { config, baseline: stored ? await restoreBaseline(config, stored) : await readJson(config), requested: [], holders: [] };
    const model = requested ?? (holders.length ? savedModel(current.baseline) || null : null);
    if (!model) {
      if (stored && !holders.length) await rm(path, { force: true });
      return null;
    }
    // Parameterized models are saved without their `[…]` overrides.
    await writeJson(path, { ...current, requested: [...new Set([...current.requested, model.split("[")[0] ?? model])], holders: [...holders, { id, pid: process.pid }] });
    return model;
  });
  const release = async () => {
    if (!model) return;
    await locked(path, async () => {
      const stored = await readJson(path) as PreferenceRecord | null;
      if (!stored) return;
      const holders = stored.holders.filter((hold) => hold.id !== id && alive(hold.pid));
      if (holders.length) { await writeJson(path, { ...stored, holders }); return; }
      await restoreBaseline(config, stored);
      await rm(path, { force: true });
    });
  };
  return { model, release };
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
  /** A line still held when the stream ends was no repeat; it stays in the result. */
  const last = (): RuntimeMessage => { release(); return current ? snapshot(current) : { ordinal: 0, content: [], provider: PROVIDER, model }; };
  return {
    result: () => final,
    last,
    push(event: JsonRecord): boolean {
      if (event.type === "assistant") {
        const value = array(record(event.message).content).map((block) => text(record(block).text)).join("");
        if (typeof event.timestamp_ms !== "number" || text(event.model_call_id)) whole(value);
        // A repeat equals all the step's text so far, which includes a line held as a possible repeat.
        else if (streamed && value === streamed + (held ?? "")) { release(); held = value; }
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
  const translator = cursorTranslator(turn.emit, { model: input.model && input.model !== DEFAULT_MODEL ? input.model : null });
  let message: RuntimeMessage = { ordinal: 0, content: [] };
  let host: JsonRpcProcess | null = null;
  let directory: string | null = null;
  let preference: Awaited<ReturnType<typeof holdModelPreference>> | null = null;
  let sent: string | null = null;
  // Cursor records a prompt only after its first output line.
  let spoke = false;
  let exited: { path: string; size: number } | null = null;
  // Bytes already in a continued transcript; a Turn recorded past them is this one. Others start empty.
  const before = prepared.resume === "native" ? await stat(session.path).then((info) => info.size, () => 0) : 0;
  try {
    directory = await mkdtemp(join(tmpdir(), "cohub-cursor-"));
    // The projection sits where Cursor's transcript will be; it is moved out before anything else can fail.
    const history = prepared.resume === "handoff" ? await handoff(session.path, directory) : null;
    const content = await prompt(input, directory);
    sent = content.text;
    signal.throwIfAborted();
    // Without coordination a Turn could run on, or leave behind, another Turn's model; it fails instead.
    preference = await holdModelPreference(input.model && input.model !== DEFAULT_MODEL ? input.model : null);
    const args = [
      "-p", "--output-format", "stream-json", "--stream-partial-output", "--trust",
      ...(prepared.resume === "native" ? ["--resume", session.nativeSessionId] : ["--new-session-id", session.nativeSessionId]),
      ...(history ? ["--conversation-history-file", history] : []),
      ...(preference.model ? ["--model", preference.model] : []),
      ...content.images.flatMap((path) => ["--image", path]),
      "--", content.text,
    ];
    // The prompt is sent when the process starts.
    await turn.started(session);
    try {
      const run = cursorCommand(executor.executables.cursor || BINARY, args, executor.cwd);
      host = new JsonRpcProcess(...run.command, executor.cwd, "stream", { ...run.env, ...turnEnvironment(input) });
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
        const off = child.onEvent((event) => { spoke = true; try { if (translator.push(event)) finish(); } catch (error) { finish(error); } });
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
    const written = await findTranscript(session.nativeSessionId, executor.cwd);
    if (written) exited = { path: written, size: await stat(written).then((info) => info.size, () => 0) };
  } finally {
    await preference?.release().catch((error: unknown) => {
      executor.diagnostics?.log("warn", "harness.cursor_model_preference_failed", { error: describeError(error) }, { ...context, component: "harness" });
    });
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    // A Turn that failed before Cursor started leaves no projection in Cursor's transcripts.
    if (!host && prepared.resume === "handoff") await rm(session.path, { force: true }).catch(() => undefined);
  }
  const path = exited?.path ?? await findTranscript(session.nativeSessionId, executor.cwd);
  if (path) {
    session = { ...session, path };
    // The transcript cannot name Cohub's Turn: it was recorded between the earlier bytes and the size at
    // exit, once the CLI spoke, with this prompt and the reply this run streamed. Another client may write
    // the same chat meanwhile; a Turn the window does not single out keeps the boundary before it, so a
    // Turn identical in prompt and reply may sync twice but no terminal Turn is lost. The server has the
    // file through that boundary, so terminal Turns after it sync even if the Runtime was offline.
    const turns = (await readCursorTranscript(path, session.nativeSessionId).catch(() => null))?.turns ?? [];
    const recorded = spoke && exited ? turns.filter((entry) => entry.startBytes >= before && entry.startBytes < (exited?.size ?? 0)) : [];
    const words = (blocks: ContentBlock[]) => blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("").trim();
    const matching = recorded.filter((entry) => words(entry.userContent) === sent?.trim());
    const replied = words(message.content) ? matching.filter((entry) => words(entry.messages.at(-1)?.content ?? []) === words(message.content)) : [];
    const own = replied.length === 1 ? replied[0] : matching.length === 1 ? matching[0] : !matching.length && recorded.length === 1 ? recorded[0] : undefined;
    const earlier = turns.filter((entry) => entry.startBytes < before).at(-1);
    executor.ingest.adopt(session, input.sessionId, { turnKey: (own ?? earlier)?.key ?? null, turnId: input.turnId });
  }
  return { session, resume: prepared.resume, message, host };
}

export const cursorHarness: LocalHarnessAdapter = {
  id: "cursor",
  binary: BINARY,
  async models(executable, cwd) {
    const probe = await command(executable, PROBE, cwd, 30_000).then(({ stdout, stderr }) => stdout + stderr, (error: { stdout?: string; stderr?: string }) => `${error.stdout ?? ""}${error.stderr ?? ""}`);
    if (!/Invalid --new-session-id/.test(probe)) {
      const unknown = /unknown option '([^']+)'/.exec(probe)?.[1];
      throw new Error(`${executable} is not a supported Cursor CLI${unknown ? ` (no ${unknown})` : ""}; update Cursor`);
    }
    const listed = await command(executable, ["models"], cwd, 60_000).catch((error: { stderr?: string; message?: string }) => {
      throw new Error(`Cursor cannot list models: ${stripVTControlCharacters(error.stderr ?? "").trim() || error.message}`);
    });
    return cursorModels(listed.stdout);
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
