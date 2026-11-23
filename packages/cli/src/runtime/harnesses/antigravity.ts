import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  isModelThinkingLevel,
  thinkingLevelMapFor,
  type ApprovalMode,
  type ContentBlock,
  type ModelThinkingLevel,
  type RuntimeExecutionEvent,
  type RuntimeMessage,
  type RuntimeTurnInput,
} from "@neta-art/cohub";
import { describeError } from "../../network-error.js";
import { JsonRpcProcess, record, type JsonRecord } from "../json-rpc.js";
import type { Executor } from "../native/execution.js";
import type { TranscriptState } from "../native/ingest.js";
import {
  acceptsAntigravityDirectory,
  acceptsAntigravityTranscript,
  antigravityCliDir,
  antigravityRoots,
  antigravitySessionHeader,
  antigravityStepStart,
  antigravityTranscriptPath,
  antigravityUsage,
  HANDOFF_TAG,
  readAntigravityTranscript,
} from "./antigravity-transcript.js";
import { projectChainedSession } from "./chained-projection.js";
import { array, closeHost, harnessCommand, type ImageBlock, localStateDirectory, missing, text, turnEnvironment, watchHost, writeImage } from "./process.js";
import type { HarnessModel, HarnessRun, HarnessTurn, LocalHarnessAdapter } from "./types.js";

const BINARY = "agy";
const PROVIDER = "antigravity";
/** Runs without `--model`, so the account's own default applies. */
const DEFAULT_MODEL = "default";
/** `agy models` lists one slug per effort, such as `gemini-4-neon-high`. */
const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/;
const EFFORT_NAME = /\s*\((?:low|medium|high|xhigh|max)\)\s*$/i;
/** Flags every Turn relies on; an executable whose help lacks one is an older or unrelated CLI. */
const REQUIRED_FLAGS = ["--input-format", "--output-format", "--conversation", "--model", "--effort", "--settings", "--dangerously-skip-permissions"];
const STARTUP_TIMEOUT_MS = 60_000;
const ABORT_ESCALATION_MS = 5_000;
/** After input closes, the CLI finishes writing its transcript; it is reaped when it does not exit by then. */
const FLUSH_TIMEOUT_MS = 10_000;
const MAX_HANDOFF_CHARS = 80_000;
/**
 * Deny rules win over every mode, allow rule and `--dangerously-skip-permissions`. `--settings` replaces
 * the user's own deny list, so a read-only Turn carries it along.
 */
const READ_ONLY_DENY = ["write_file(*)", "command(*)", "mcp(*)", "read_url(*)", "execute_url(*)", "download_url(*)"];
/** Headless mode cannot ask: anything needing approval is denied. Cohub only chooses how much is pre-approved. */
const APPROVAL_MODES: ApprovalMode[] = ["inherit", "full_access", "read_only"];

const execute = promisify(execFile);

async function command(executable: string, args: string[], cwd: string, timeout: number) {
  return await execute(...harnessCommand(executable, args, cwd), { cwd, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
}

/** The CLI's own explanation, such as asking to sign in, rather than "Command failed". */
function commandError(error: unknown): Error {
  const output = error as { stderr?: string; message?: string };
  const line = (output.stderr ?? "").split("\n").map((entry) => entry.trim()).filter(Boolean).at(-1);
  return new Error(line?.replace(/^error:\s*/i, "") || output.message || "agy failed");
}

/** One Cohub model per base slug; its effort variants become thinking levels passed as `--effort`. */
export function antigravityModels(listing: string): HarnessModel[] {
  const groups = new Map<string, { name: string; levels: ModelThinkingLevel[] }>();
  for (const line of listing.split("\n")) {
    // Columns are tab-separated when piped; the docs show them aligned with spaces.
    const [slug = "", name = ""] = line.trim().split(/\t|\s{2,}/).map((part) => part.trim());
    if (!slug || !name) continue;
    const effort = EFFORT_SUFFIX.exec(slug);
    const id = (effort ? slug.slice(0, -effort[0].length) : slug).slice(0, 255);
    const group = groups.get(id) ?? { name: name.replace(EFFORT_NAME, "").slice(0, 255) || id, levels: [] };
    const level = effort?.[1];
    if (isModelThinkingLevel(level) && !group.levels.includes(level)) group.levels.push(level);
    groups.set(id, group);
  }
  return [
    { harness: "antigravity", provider: PROVIDER, id: DEFAULT_MODEL, name: "Default", isDefault: true, reasoning: false },
    ...[...groups].map(([id, { name, levels }]): HarnessModel => ({
      harness: "antigravity", provider: PROVIDER, id, name,
      ...(levels.length ? { reasoning: true, thinkingLevelMap: thinkingLevelMapFor((level) => levels.includes(level) ? level : null) } : { reasoning: false }),
    })),
  ];
}

/** The platform's read-only access always wins; there is no approval card, so no mode asks. */
export function antigravityApprovalMode(input: RuntimeTurnInput): ApprovalMode {
  if (input.accessMode === "read_only") {
    if (input.approvalMode && input.approvalMode !== "read_only") throw new Error("The approval mode conflicts with read-only access");
    return "read_only";
  }
  const mode = input.approvalMode ?? "inherit";
  if (!APPROVAL_MODES.includes(mode)) throw new Error(`Antigravity does not support the ${mode} approval mode`);
  return mode;
}

/** The user's deny rules plus Cohub's; a file Antigravity cannot parse contributes none, as for Antigravity. */
export async function antigravityReadOnlySettings(): Promise<JsonRecord> {
  const raw = await readFile(join(antigravityCliDir(), "settings.json"), "utf8").catch((error) => { if (missing(error)) return ""; throw error; });
  let deny: string[] = [];
  try { deny = array(record(record(JSON.parse(raw.replace(/^\uFEFF/, ""))).permissions).deny).filter((rule): rule is string => typeof rule === "string"); }
  catch { /* No usable rules of the user's own. */ }
  return { permissions: { deny: [...new Set([...deny, ...READ_ONLY_DENY])] } };
}

function toolOutput(info: JsonRecord): string {
  const error = record(info.error);
  return text(info.output) || text(error.message) || text(info.error);
}

type Message = { ordinal: number; step: number; content: ContentBlock[] };

/**
 * Maps `--output-format stream-json` onto Cohub's streaming protocol. Each `agent_response` step opens a
 * message; the `tool` steps after it are its tool calls, keyed by step index.
 */
export function antigravityTranslator(emit: (event: RuntimeExecutionEvent) => void, identity: { provider: string; model: string | null }) {
  let current: Message | null = null;
  let count = 0;
  let model = identity.model;
  let final: RuntimeMessage | null = null;
  // `result.usage` counts the whole conversation, so this Turn's usage is the sum of its own steps.
  const spent = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 };
  const settledContent = (content: ContentBlock[]) => content.map((block) => block.type === "text" ? { ...block, text: block.text.trimEnd() } : block);
  const snapshot = (message: Message): RuntimeMessage => ({
    ordinal: message.ordinal, content: settledContent(message.content), provider: identity.provider, model,
    stopReason: message.content.some((block) => block.type === "tool_use") ? "tool_use" : "stop",
  });
  const begin = (step: number) => {
    if (current) emit({ type: "message.commit", message: snapshot(current) });
    current = { ordinal: count++, step, content: [] };
    emit({ type: "message.start", ordinal: current.ordinal });
    return current;
  };
  const last = (): RuntimeMessage => current ? snapshot(current) : { ordinal: 0, content: [], provider: identity.provider, model };
  const tool = (message: Message, step: JsonRecord) => {
    const info = record(step.tool_info);
    const id = `agy-step-${Number(step.step_index)}`;
    const use: ContentBlock = { type: "tool_use", id, name: text(info.name) || text(step.tool_name) || "tool", input: record(info.parameters) };
    let index = message.content.findIndex((block) => block.type === "tool_use" && block.id === id);
    if (index < 0) index = message.content.push(use) - 1;
    else message.content[index] = use;
    if (text(step.state) === "DONE") {
      const next = message.content[index + 1];
      const result: ContentBlock = { type: "tool_result", tool_use_id: id, content: toolOutput(info), is_error: Boolean(info.error) };
      message.content.splice(index + 1, next?.type === "tool_result" && next.tool_use_id === id ? 1 : 0, result);
    }
    emit({ type: "content.replace", ordinal: message.ordinal, content: [...message.content] });
  };
  return {
    /** The final `result`, or `null` while the Turn runs. */
    result: () => final,
    last,
    push(event: JsonRecord): boolean {
      if (event.event === "init") { model = text(record(event.init).model) || model; return false; }
      if (event.event === "step_update") {
        const step = record(event.step_update);
        const index = Number(step.step_index);
        const kind = text(step.step_type);
        const usage = record(step.usage);
        if (text(step.state) === "DONE") for (const key of Object.keys(spent) as Array<keyof typeof spent>) if (typeof usage[key] === "number") spent[key] += usage[key] as number;
        if (kind === "agent_response") {
          const message = current?.step === index ? current : begin(index);
          const delta = text(step.text_delta);
          if (!delta) return false;
          const tail = message.content.at(-1);
          if (tail?.type === "text") message.content[message.content.length - 1] = { type: "text", text: tail.text + delta };
          else message.content.push({ type: "text", text: delta });
          emit({ type: "text.delta", ordinal: message.ordinal, index: message.content.length - 1, kind: "text", delta });
        } else if (kind === "tool") {
          tool(current ?? begin(index), step);
        }
        return false;
      }
      if (event.event !== "result") return false;
      const result = record(event.result);
      const status = text(result.status);
      const denied = array(result.denied_actions).map((entry) => text(record(entry).display_name) || text(record(entry).action)).filter(Boolean);
      const answered = Boolean(text(result.response).trim());
      const error = status === "SUCCESS"
        ? !answered && denied.length ? `Antigravity denied ${[...new Set(denied)].join(", ")}: headless mode cannot ask. Allow it in ${join(antigravityCliDir(), "settings.json")} or choose full access.` : null
        : text(result.error) || `Antigravity ended the Turn: ${status || "unknown status"}`;
      final = {
        ...last(),
        stopReason: status === "INTERRUPTED" || status === "CANCELED" ? "aborted" : error ? "error" : "stop",
        errorMessage: error,
        usage: antigravityUsage(spent),
      };
      return true;
    },
  };
}

/**
 * Projected Cohub history, read once and removed: it is handed over inside the first prompt. A projection
 * that cannot be read fails the Turn rather than starting the conversation without its history.
 */
async function readHandoff(path: string, directory: () => Promise<string>): Promise<string | null> {
  const raw = await readFile(path, "utf8");
  await rm(path, { force: true });
  const lines: string[] = [];
  let images = 0;
  for (const entry of raw.split("\n").filter((line) => line.trim())) {
    const value = record(JSON.parse(entry));
    const attached: string[] = [];
    for (const block of array(value.images) as ImageBlock[]) attached.push(`[image: ${await writeImage(block, await directory(), `history-image-${++images}`)}]`);
    const body = [text(value.text), ...attached].filter(Boolean).join("\n");
    if (text(value.role) && body) lines.push(`[${text(value.role)}]\n${body}`);
  }
  if (!lines.length) return null;
  const joined = lines.join("\n\n");
  const clipped = joined.length > MAX_HANDOFF_CHARS ? `...(earlier history truncated)\n\n${joined.slice(-MAX_HANDOFF_CHARS)}` : joined;
  return `<${HANDOFF_TAG}>\nEarlier turns of this Cohub chat, before it continued in Antigravity (open listed images with read_file):\n\n${clipped}\n</${HANDOFF_TAG}>`;
}

function summarizeBlocks(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text.trim()) parts.push(block.text.trim());
    else if (block.type === "tool_use") parts.push(`[tool_use:${block.name} ${JSON.stringify(block.input)}]`);
    else if (block.type === "tool_result") {
      const body = typeof block.content === "string" ? block.content : block.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      parts.push(`[tool_result:${block.is_error ? "error" : "ok"} ${body.slice(0, 1000)}]`);
    }
  }
  return parts.join("\n");
}

/** Stream-json input takes text only; images go beside the prompt as files, which `read_file` shows the model. */
async function prompt(input: RuntimeTurnInput, directory: () => Promise<string>, handoff: string | null): Promise<string> {
  const parts: string[] = [];
  const images: string[] = [];
  for (const block of input.messages.flatMap((message) => message.content)) {
    if (block.type === "image") images.push(await writeImage(block, await directory(), `image-${images.length + 1}`));
    else parts.push(block.type === "text" ? block.text : JSON.stringify(block));
  }
  return [
    handoff,
    parts.join("\n\n").trim(),
    images.length ? `Attached images (open them with read_file):\n${images.map((path) => `- ${path}`).join("\n")}` : null,
  ].filter(Boolean).join("\n\n");
}

/**
 * One `agy --input-format stream-json` process per Turn, continuing a conversation with `--conversation`.
 * The CLI reports its conversation id before it reads a prompt, so the Turn starts on the real file.
 */
async function runAntigravity(executor: Executor, turn: HarnessTurn): Promise<HarnessRun> {
  const { input, signal, context } = turn;
  const mode = antigravityApprovalMode(input);
  const prepare = (resumable: (transcript: TranscriptState) => boolean) => executor.sessions.prepare({
    sessionId: input.sessionId, turnId: input.turnId, harness: "antigravity", cwd: executor.cwd,
    provider: input.provider, context: input.context, signal, resumable,
  });
  // Without a control plane, a terminal conversation is read-only: Cohub continues only conversations it started.
  let prepared = await prepare((transcript) => transcript.path !== turn.diverged && transcript.origin === "cohub");
  let session = prepared.session;
  const requested = prepared.resume === "native" ? session.nativeSessionId : null;
  const model = input.model && input.model !== DEFAULT_MODEL ? input.model : null;
  // Cohub has already fitted the level to the model's own; `--effort` has no `off`.
  const effort = isModelThinkingLevel(input.thinkingLevel) && input.thinkingLevel !== "off" ? input.thinkingLevel : null;
  let created: string | null = null;
  const directory = async () => created ??= await mkdtemp(join(tmpdir(), "cohub-antigravity-"));
  let host: JsonRpcProcess | null = null;
  const translator = antigravityTranslator(turn.emit, { provider: input.provider || PROVIDER, model });
  let message: RuntimeMessage = { ordinal: 0, content: [] };
  let begun = false;
  let before = 0;
  let ownStep: number | null = null;
  try {
    const settings = mode === "read_only" ? join(await directory(), "settings.json") : null;
    if (settings) await writeFile(settings, JSON.stringify(await antigravityReadOnlySettings()), { mode: 0o600 });
    const args = [
      "--input-format", "stream-json", "--output-format", "stream-json",
      ...(requested ? ["--conversation", requested] : []),
      ...(model ? ["--model", model] : []),
      ...(effort ? ["--effort", effort] : []),
      ...(mode === "full_access" ? ["--dangerously-skip-permissions"] : []),
      ...(settings ? ["--settings", settings] : []),
    ];
    signal.throwIfAborted();
    const rpc = new JsonRpcProcess(...harnessCommand(executor.executables.antigravity || BINARY, args, executor.cwd), executor.cwd, "stream", turnEnvironment(input));
    host = rpc;
    watchHost(rpc, executor.diagnostics, context);
    let ready: (conversation: string) => void = () => {};
    let fail: (error: unknown) => void = () => {};
    let finish: (error?: unknown) => void = () => {};
    let started = false;
    const offEvent = rpc.onEvent((event) => {
      if (!started) {
        if (event.event === "init") { started = true; ready(text(event.conversation_id)); translator.push(event); }
        else if (event.event === "result") fail(new Error(text(record(event.result).error) || "Antigravity did not start a conversation"));
        return;
      }
      const step = record(event.step_update);
      if (ownStep === null && text(step.step_type) === "user_input" && typeof step.step_index === "number") ownStep = step.step_index;
      try { if (translator.push(event)) finish(); } catch (error) { finish(error); }
    });
    const offFailure = rpc.onFailure((error) => { fail(error); finish(error); });
    try {
      const conversation = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Antigravity did not start a conversation in time")), STARTUP_TIMEOUT_MS);
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        const settle = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
        ready = (id) => { settle(); if (id) resolve(id); else reject(new Error("Antigravity reported no conversation id")); };
        fail = (error) => { settle(); reject(error); };
      });
      if (requested && conversation !== requested) {
        // `--conversation` silently starts a new conversation when the old one is gone; history goes into the prompt.
        executor.diagnostics?.log("warn", "harness.antigravity_conversation_missing", { conversation: requested }, { ...context, component: "harness" });
        prepared = await prepare(() => false);
      }
      session = { ...prepared.session, nativeSessionId: conversation, path: antigravityTranscriptPath(conversation) };
      const handoff = prepared.resume === "handoff" ? await readHandoff(prepared.session.path, directory) : null;
      const content = await prompt(input, directory, handoff);
      before = prepared.resume === "native" ? await stat(session.path).then((info) => info.size, () => 0) : 0;
      signal.throwIfAborted();
      await turn.started(session);
      begun = true;
      await new Promise<void>((resolve, reject) => {
        let escalation: ReturnType<typeof setTimeout> | undefined;
        let done = false;
        const abort = () => {
          rpc.interrupt();
          escalation = setTimeout(() => void rpc.close().catch(() => undefined), ABORT_ESCALATION_MS);
        };
        finish = (error?: unknown) => {
          if (done) return;
          done = true;
          signal.removeEventListener("abort", abort);
          clearTimeout(escalation);
          if (error) reject(error); else resolve();
        };
        signal.addEventListener("abort", abort, { once: true });
        try { rpc.write({ event: "user", message: { content: content || " " } }); } catch (error) { finish(error); }
        if (signal.aborted) abort();
      });
    } finally {
      offEvent();
      offFailure();
    }
    message = translator.result() ?? translator.last();
    if (signal.aborted) message = { ...message, stopReason: "aborted", errorMessage: null };
  } catch (error) {
    if (!begun) {
      if (host) await closeHost(host, null).catch(() => undefined);
      if (created) await rm(created, { recursive: true, force: true }).catch(() => undefined);
      if (prepared.resume === "handoff") await rm(prepared.session.path, { force: true }).catch(() => undefined);
      throw error;
    }
    message = { ...translator.last(), stopReason: signal.aborted ? "aborted" : "error", errorMessage: signal.aborted ? null : describeError(error) };
  }
  // Closing input lets the CLI finish its transcript before the executor reaps the process.
  host?.endInput();
  await host?.exited(FLUSH_TIMEOUT_MS);
  if (created) await rm(created, { recursive: true, force: true }).catch(() => undefined);
  const transcript = await readAntigravityTranscript(session.path).catch(() => null);
  if (transcript) {
    // The run reported the step index of its prompt, which names Cohub's Turn in the file exactly. Without
    // it the server has the file through the Turns before this run; terminal Turns after them still sync.
    const start = ownStep === null ? null : await antigravityStepStart(session.path, ownStep);
    const own = start === null ? undefined : transcript.turns.find((entry) => entry.startBytes === start);
    const earlier = transcript.turns.filter((entry) => entry.startBytes < before).at(-1);
    executor.ingest.adopt(session, input.sessionId, { turnKey: (own ?? earlier)?.key ?? null, turnId: input.turnId });
  }
  return { session, resume: prepared.resume, message, host };
}

export const antigravityHarness: LocalHarnessAdapter = {
  id: "antigravity",
  binary: BINARY,
  async models(executable, cwd) {
    // Go's flag package prints usage on stderr.
    const help = await command(executable, ["--help"], cwd, 30_000).then(({ stdout, stderr }) => stdout + stderr, (error: { stdout?: string; stderr?: string }) => `${error.stdout ?? ""}${error.stderr ?? ""}`);
    const missingFlags = REQUIRED_FLAGS.filter((flag) => !new RegExp(`(^|\\s)${flag}(?=\\s|$)`, "m").test(help));
    if (missingFlags.length) throw new Error(`${executable} is not a supported Antigravity CLI (missing ${missingFlags.join(", ")}); update Antigravity`);
    const { stdout } = await command(executable, ["models"], cwd, 60_000).catch((error: unknown) => { throw commandError(error); });
    const models = antigravityModels(stdout);
    if (models.length <= 1) throw new Error("Antigravity lists no models; run `agy` to sign in");
    return models;
  },
  approvalModes: async () => APPROVAL_MODES,
  run: runAntigravity,
  session: {
    // Only a staging file: projected history is handed over inside the first prompt, never as Antigravity's own state.
    path: (nativeSessionId) => join(localStateDirectory(), "antigravity-handoff", `${nativeSessionId}.jsonl`),
    startsWithoutFile: true,
    project: (input) => projectChainedSession(input, "antigravity", { id: "cohubId", parent: "cohubParentId" }, (segment) => {
      const summary = summarizeBlocks(segment.blocks);
      // Embedded images, uploaded or returned by a tool; URL images are omitted, as for Cursor, rather than fetched.
      const images = segment.blocks.flatMap((block) => block.type === "tool_result" && Array.isArray(block.content) ? block.content : [block])
        .filter((block) => block.type === "image" && block.source.type === "base64");
      return summary || images.length ? [{ role: segment.role, text: summary, ...(images.length ? { images } : {}) }] : [];
    }),
    rebind: (records) => records,
  },
  transcript: {
    roots: antigravityRoots,
    acceptsDirectory: acceptsAntigravityDirectory,
    acceptsTranscript: acceptsAntigravityTranscript,
    header: (path) => antigravitySessionHeader(path),
    read: readAntigravityTranscript,
    boundaries: ['"type":"USER_INPUT"', '"type":"PLANNER_RESPONSE"'],
    turnEndRecorded: false,
    // The reader sets a result only once a final, tool-free reply is done.
    replyEnded: (turn) => turn.result !== null,
    userFinalMarked: false,
    globalTurnKeys: false,
    marksCohubTurns: false,
  },
};
