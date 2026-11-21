import { readFile, rm, stat } from "node:fs/promises";
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
  answerAntigravityApproval,
  antigravityAcpMode,
  antigravityApprovalMode,
  antigravityApprovalModes,
} from "./antigravity-approval.js";
import {
  acceptsAntigravityDirectory,
  acceptsAntigravityTranscript,
  antigravityPrimaryAppDataDir,
  antigravityReplyEnded,
  antigravityRoots,
  antigravitySessionHeader,
  antigravityTranscriptPath,
  parseAntigravityTranscriptPath,
  readAntigravityTranscript,
} from "./antigravity-transcript.js";
import { projectChainedSession } from "./chained-projection.js";
import { SessionGrants } from "./claude-approval.js";
import { array, harnessCommand, inlineImage, text, turnEnvironment, watchHost } from "./process.js";
import type { HarnessModel, HarnessRun, HarnessTurn, LocalHarnessAdapter } from "./types.js";

const BINARY = "agy";
const PROVIDER = "antigravity";
const DEFAULT_MODEL = "default";
const INITIALIZE_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_MS = 30_000;
const PROMPT_TIMEOUT_MS = 24 * 60 * 60_000;
const ABORT_ESCALATION_MS = 5_000;
const FLUSH_WAIT_MS = 250;
const EFFORT_LEVELS: readonly ModelThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];
const MAX_HANDOFF_CHARS = 80_000;

const grants = new SessionGrants();
const supportedModes = new Map<string, Promise<ApprovalMode[]>>();

function acpBaseArgs(extra: string[] = []): string[] {
  const configuredDir = process.env.ANTIGRAVITY_DATA_DIR?.split(",").map((entry) => entry.trim()).filter(Boolean)[0];
  return ["acp", "--stdio", ...(configuredDir && !configuredDir.startsWith("/") && !configuredDir.includes("\\") ? ["--app-data-dir", configuredDir] : []), ...extra];
}

function modelProvider(id: string): string {
  if (id.startsWith("gemini-")) return "google";
  if (id.startsWith("claude-")) return "anthropic";
  return PROVIDER;
}

/**
 * Parse Antigravity's ACP `session/new` response (`models.availableModels` and `configOptions`)
 * into Cohub's `HarnessModel[]`, preserving per-model thinking levels and a `default` entry.
 */
export function antigravityModels(sessionResult: JsonRecord): HarnessModel[] {
  const availableVariants = array(record(sessionResult.models).availableModels).map(record);
  const configOptions = array(sessionResult.configOptions).map(record);
  const modelOption = configOptions.find((option) => text(option.id) === "model" || text(option.category) === "model");
  const thoughtOption = configOptions.find((option) => text(option.id) === "thought_level" || text(option.category) === "thought_level");
  const globalEfforts = array(thoughtOption?.options)
    .map((entry) => text(record(entry).value))
    .filter((level): level is ModelThinkingLevel => isModelThinkingLevel(level) && level !== "off");
  const defaultEfforts = globalEfforts.length ? globalEfforts : EFFORT_LEVELS;

  const variantIds = new Set(availableVariants.map((variant) => text(variant.modelId)).filter(Boolean));
  const entries = array(modelOption?.options).map(record);
  const models: HarnessModel[] = [{
    harness: "antigravity",
    provider: PROVIDER,
    id: DEFAULT_MODEL,
    name: "Default",
    isDefault: true,
    reasoning: true,
    thinkingLevelMap: thinkingLevelMapFor((level) => defaultEfforts.includes(level) ? level : null),
  }];

  const seen = new Set<string>([DEFAULT_MODEL]);
  if (entries.length) {
    for (const entry of entries) {
      const id = text(entry.value).slice(0, 255);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name = (text(entry.name) || id).slice(0, 255);
      const suffixed = EFFORT_LEVELS.filter((level) => variantIds.has(`${id}-${level}`));
      const reasoning = suffixed.length > 0;
      models.push({
        harness: "antigravity",
        provider: modelProvider(id),
        id,
        name,
        ...(reasoning
          ? { reasoning: true, thinkingLevelMap: thinkingLevelMapFor((level) => suffixed.includes(level) ? level : null) }
          : { reasoning: false }),
      });
    }
    return models;
  }

  for (const variant of availableVariants) {
    const id = text(variant.modelId).slice(0, 255);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      harness: "antigravity",
      provider: modelProvider(id),
      id,
      name: (text(variant.name) || id).slice(0, 255),
      reasoning: false,
    });
  }
  return models;
}

function availableAcpModes(sessionResult: JsonRecord): string[] {
  const fromModes = array(record(sessionResult.modes).availableModes).map((entry) => text(record(entry).id)).filter(Boolean);
  if (fromModes.length) return fromModes;
  const modeOption = array(sessionResult.configOptions).map(record).find((option) => text(option.id) === "mode" || text(option.category) === "mode");
  return array(modeOption?.options).map((entry) => text(record(entry).value)).filter(Boolean);
}

async function probeAcpSession(executable: string, cwd: string): Promise<{ models: HarnessModel[]; modes: ApprovalMode[] }> {
  const host = new JsonRpcProcess(...harnessCommand(executable, acpBaseArgs(), cwd), cwd, "jsonrpc");
  try {
    await host.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "cohub", version: "1" },
    }, INITIALIZE_TIMEOUT_MS);
    const created = await host.request("session/new", { cwd, mcpServers: [] }, SESSION_TIMEOUT_MS);
    const sessionId = text(created.sessionId);
    if (sessionId) await host.request("session/close", { sessionId }, 5_000).catch(() => undefined);
    const models = antigravityModels(created);
    if (models.length <= 1) throw new Error("Antigravity ACP lists no models; sign in with `agy`");
    return { models, modes: antigravityApprovalModes(availableAcpModes(created)) };
  } finally {
    await host.close().catch(() => undefined);
  }
}

function probeApprovalModes(executable: string, cwd: string): Promise<ApprovalMode[]> {
  const probe = probeAcpSession(executable, cwd).then((result) => result.modes);
  supportedModes.set(executable, probe);
  probe.catch(() => { if (supportedModes.get(executable) === probe) supportedModes.delete(executable); });
  return probe;
}

function acpUsage(value: unknown): RuntimeMessage["usage"] {
  const usage = record(value);
  const count = (key: string) => typeof usage[key] === "number" ? usage[key] as number : 0;
  const input = count("inputTokens");
  const output = count("outputTokens");
  const cacheRead = count("cachedReadTokens");
  const cacheWrite = count("cachedWriteTokens");
  const total = count("totalTokens") || input + output + cacheRead + cacheWrite;
  if (!input && !output && !cacheRead && !cacheWrite && !total) return undefined;
  return { input, output, cacheRead, cacheWrite, totalTokens: total };
}

function toolResultText(update: JsonRecord): string {
  const rawOutput = update.rawOutput;
  if (typeof rawOutput === "string" && rawOutput) return rawOutput;
  if (rawOutput && typeof rawOutput === "object") {
    const out = record(rawOutput);
    const direct = text(out.output) || text(out.content) || text(out.error) || text(out.message);
    if (direct) return direct;
    return JSON.stringify(rawOutput);
  }
  const contentBlocks = array(update.content).map((entry) => {
    const block = record(entry);
    if (block.type === "content") return text(record(block.content).text);
    return text(block.text) || text(block.content);
  }).filter(Boolean);
  if (contentBlocks.length) return contentBlocks.join("\n");
  return text(update.title);
}

type Step = { ordinal: number; content: ContentBlock[] };

/**
 * Translate ACP `session/update` notifications onto Cohub's streaming protocol.
 * A step commits once all of its `tool_use` blocks have corresponding `tool_result` blocks and new output begins.
 */
export function antigravityTranslator(emit: (event: RuntimeExecutionEvent) => void, identity: { provider: string; model: string | null }) {
  const steps: Step[] = [];
  const owners = new Map<string, Step>();
  let current: Step | null = null;
  let open: { index: number; kind: "text" | "thinking" } | null = null;
  let model = identity.model;

  const settled = (step: Step) => step.content.some((block) => block.type === "tool_use")
    && step.content.every((block) => block.type !== "tool_use" || step.content.some((result) => result.type === "tool_result" && result.tool_use_id === block.id));

  const snapshot = (step: Step): RuntimeMessage => ({
    ordinal: step.ordinal,
    content: [...step.content],
    provider: identity.provider,
    model,
    stopReason: step.content.some((block) => block.type === "tool_use") ? "tool_use" : "stop",
  });

  const target = () => {
    if (current && !settled(current)) return current;
    if (current) emit({ type: "message.commit", message: snapshot(current) });
    current = { ordinal: steps.length, content: [] };
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
    step.content[open.index] = block?.type === "thinking"
      ? { type: "thinking", thinking: block.thinking + chunk }
      : { type: "text", text: (block?.type === "text" ? block.text : "") + chunk };
    emit({ type: "text.delta", ordinal: step.ordinal, index: open.index, kind, delta: chunk });
  };

  const upsertTool = (update: JsonRecord) => {
    const id = text(update.toolCallId);
    if (!id) return;
    const name = text(update.name) || text(update.kind) || "tool";
    const rawInput = record(update.rawInput);
    const input = Object.keys(rawInput).length ? rawInput : record(update.args);
    const existingOwner = owners.get(id);
    const step = existingOwner ?? target();
    const index = step.content.findIndex((block) => block.type === "tool_use" && block.id === id);
    if (index >= 0) {
      const prev = step.content[index];
      const mergedInput = Object.keys(input).length ? input : (prev?.type === "tool_use" ? prev.input : {});
      step.content[index] = { type: "tool_use", id, name, input: mergedInput };
    } else {
      step.content.push({ type: "tool_use", id, name, input });
      owners.set(id, step);
      open = null;
    }

    const status = text(update.status);
    if (status === "completed" || status === "failed") {
      const toolIndex = step.content.findIndex((block) => block.type === "tool_use" && block.id === id);
      if (toolIndex >= 0) {
        const resultBlock: ContentBlock = {
          type: "tool_result",
          tool_use_id: id,
          content: toolResultText(update),
          is_error: status === "failed",
        };
        const next = step.content[toolIndex + 1];
        step.content.splice(toolIndex + 1, next?.type === "tool_result" && next.tool_use_id === id ? 1 : 0, resultBlock);
      }
    }
    replace(step);
  };

  const last = (): RuntimeMessage => current
    ? snapshot(current)
    : { ordinal: 0, content: [], provider: identity.provider, model };

  return {
    last,
    setModel(nextModel: string | null) { if (nextModel) model = nextModel; },
    push(update: JsonRecord) {
      const kind = text(update.sessionUpdate);
      if (kind === "agent_message_chunk") {
        append("text", text(record(update.content).text));
        return;
      }
      if (kind === "agent_thought_chunk") {
        append("thinking", text(record(update.content).text));
        return;
      }
      if (kind === "tool_call" || kind === "tool_call_update") {
        upsertTool(update);
        return;
      }
      if (kind === "config_option_update") {
        const modelOption = array(update.configOptions).map(record).find((option) => text(option.id) === "model");
        if (modelOption && text(modelOption.currentValue)) model = text(modelOption.currentValue);
      }
    },
    finish(result: JsonRecord, aborted: boolean): RuntimeMessage {
      const stop = text(result.stopReason);
      const isAborted = aborted || stop === "cancelled";
      const isError = !isAborted && stop === "error";
      return {
        ...last(),
        stopReason: isAborted ? "aborted" : isError ? "error" : "stop",
        errorMessage: isError ? text(result.error) || "Turn failed" : null,
        usage: acpUsage(result.usage),
      };
    },
  };
}

/** Format projected Cohub history records as a compact system-prompt handoff block for ACP `session/new`. */
async function readHandoffContext(path: string): Promise<string | null> {
  const raw = await readFile(path, "utf8").catch(() => "");
  await rm(path, { force: true }).catch(() => undefined);
  if (!raw.trim()) return null;
  const lines: string[] = [];
  for (const entry of raw.split("\n")) {
    if (!entry.trim()) continue;
    try {
      const rec = record(JSON.parse(entry));
      const role = text(rec.role);
      const body = text(rec.text);
      if (role && body) lines.push(`[${role}]\n${body}`);
    } catch { /* skip malformed line */ }
  }
  if (!lines.length) return null;
  const joined = lines.join("\n\n");
  const clipped = joined.length > MAX_HANDOFF_CHARS ? `...(earlier history truncated)\n\n${joined.slice(-MAX_HANDOFF_CHARS)}` : joined;
  return `<cohub_session_history>\nThe following prior turns occurred earlier in this Cohub Chat before continuing in Antigravity:\n\n${clipped}\n</cohub_session_history>`;
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

async function buildAcpPrompt(input: RuntimeTurnInput): Promise<{ blocks: JsonRecord[]; plainText: string }> {
  const blocks: JsonRecord[] = [];
  const textParts: string[] = [];
  for (const block of input.messages.flatMap((message) => message.content)) {
    if (block.type === "image") {
      const image = await inlineImage(block);
      blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
      continue;
    }
    const content = block.type === "text" ? block.text : JSON.stringify(block);
    if (content) {
      blocks.push({ type: "text", text: content });
      textParts.push(content);
    }
  }
  if (!blocks.length) blocks.push({ type: "text", text: "" });
  return { blocks, plainText: textParts.join("\n\n").trim() };
}

/**
 * Run one Cohub Turn in Antigravity via `agy acp --stdio`.
 * New/handoff sessions use `session/new` (carrying projected Cohub history via `_meta.antigravity.systemPrompt.append`),
 * later Turns resume via `session/resume`. Interactive permissions map to Cohub approval cards.
 */
async function runAntigravity(executor: Executor, turn: HarnessTurn): Promise<HarnessRun> {
  const { input, signal, context } = turn;
  const executable = executor.executables.antigravity || BINARY;
  const modes = await (supportedModes.get(executable) ?? probeApprovalModes(executable, executor.cwd)).catch((): ApprovalMode[] => ["inherit", "auto", "full_access", "read_only"]);
  const mode = antigravityApprovalMode(input, modes);
  const prepare = (resumable: (transcript: TranscriptState) => boolean) => executor.sessions.prepare({
    sessionId: input.sessionId,
    turnId: input.turnId,
    harness: "antigravity",
    cwd: executor.cwd,
    provider: input.provider,
    context: input.context,
    signal,
    resumable,
  });

  // Without a live control plane into user IDE sessions, Cohub continues only sessions it started.
  let prepared = await prepare((transcript) => transcript.path !== turn.diverged && transcript.origin === "cohub");
  let session = prepared.session;
  const requestedModel = input.model && input.model !== DEFAULT_MODEL ? input.model : null;
  const translator = antigravityTranslator(turn.emit, {
    provider: input.provider || (requestedModel ? modelProvider(requestedModel) : PROVIDER),
    model: requestedModel,
  });

  const extraArgs = mode === "full_access" ? ["--dangerously-skip-permissions"] : [];
  let host: JsonRpcProcess | null = null;
  let message: RuntimeMessage = { ordinal: 0, content: [], provider: PROVIDER, model: requestedModel };
  let begun = false;
  let sentText = "";
  let beforeSize = 0;

  try {
    const promptPayload = await buildAcpPrompt(input);
    sentText = promptPayload.plainText;
    signal.throwIfAborted();

    host = new JsonRpcProcess(...harnessCommand(executable, acpBaseArgs(extraArgs), executor.cwd), executor.cwd, "jsonrpc", turnEnvironment(input));
    watchHost(host, executor.diagnostics, context);
    const rpc = host;

    await rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "cohub", version: "1" },
    }, INITIALIZE_TIMEOUT_MS);

    let opened: JsonRecord | null = null;
    if (prepared.resume === "native") {
      opened = await rpc.request("session/resume", {
        sessionId: session.nativeSessionId,
        cwd: executor.cwd,
        mcpServers: [],
      }, SESSION_TIMEOUT_MS).catch(() => null);
      if (!opened) prepared = await prepare(() => false);
    }

    if (!opened) {
      session = prepared.session;
      const handoffAppend = prepared.resume === "handoff" ? await readHandoffContext(session.path) : null;
      const readOnlyNote = input.accessMode === "read_only" || mode === "read_only"
        ? "This session is strictly read-only. Do not modify workspace files, do not run write/shell commands, and do not create artifact files."
        : null;
      const systemAppend = [handoffAppend, readOnlyNote].filter(Boolean).join("\n\n");
      opened = await rpc.request("session/new", {
        cwd: executor.cwd,
        mcpServers: [],
        ...(systemAppend ? { _meta: { antigravity: { systemPrompt: { append: systemAppend } } } } : {}),
      }, SESSION_TIMEOUT_MS);
    }

    const acpSessionId = text(opened.sessionId) || session.nativeSessionId;
    const realPath = antigravityTranscriptPath(acpSessionId, antigravityPrimaryAppDataDir());
    if (acpSessionId !== session.nativeSessionId || realPath !== session.path) {
      session = { ...session, nativeSessionId: acpSessionId, path: realPath };
    }
    beforeSize = prepared.resume === "native" ? await stat(session.path).then((info) => info.size, () => 0) : 0;

    const currentModel = text(record(opened.models).currentModelId);
    if (!requestedModel && currentModel) translator.setModel(currentModel);

    // Apply approval mode, model, and thinking level before sending the prompt.
    const acpMode = antigravityAcpMode(mode);
    if (acpMode) {
      await rpc.request("session/set_mode", { sessionId: acpSessionId, modeId: acpMode }, 15_000).catch(() => undefined);
    }
    if (requestedModel) {
      await rpc.request("session/set_config_option", { sessionId: acpSessionId, configId: "model", value: requestedModel }, 15_000)
        .catch(() => rpc.request("session/set_model", { sessionId: acpSessionId, modelId: requestedModel }, 15_000));
    }
    const effort = isModelThinkingLevel(input.thinkingLevel) && input.thinkingLevel !== "off" ? input.thinkingLevel : null;
    if (effort) {
      await rpc.request("session/set_config_option", { sessionId: acpSessionId, configId: "thought_level", value: effort }, 15_000).catch(() => undefined);
    }

    signal.throwIfAborted();
    await turn.started(session);
    begun = true;

    const approvalScope = new AbortController();
    const cancel = () => {
      approvalScope.abort();
      try { rpc.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: acpSessionId } }); } catch { /* ignore */ }
    };
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      cancel();
      escalation = setTimeout(() => void rpc.close().catch(() => undefined), ABORT_ESCALATION_MS);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const offEvent = rpc.onEvent((event) => {
      // Server-initiated permission request has both `id` and `method`.
      if (event.id != null && event.method === "session/request_permission") {
        const requestId = event.id;
        void answerAntigravityApproval(record(event.params), input, mode, executor.approvals, grants, approvalScope.signal)
          .then((result) => { try { rpc.write({ jsonrpc: "2.0", id: requestId, result }); } catch { /* ignore if closed */ } })
          .catch(() => { try { rpc.write({ jsonrpc: "2.0", id: requestId, result: { outcome: { outcome: "cancelled" } } }); } catch { /* ignore */ } });
        return;
      }
      if (event.method === "session/update") {
        const params = record(event.params);
        if (text(params.sessionId) && text(params.sessionId) !== acpSessionId) return;
        translator.push(record(params.update));
      }
    });

    try {
      if (signal.aborted) onAbort();
      const promptResult = await rpc.request("session/prompt", {
        sessionId: acpSessionId,
        prompt: promptPayload.blocks,
      }, PROMPT_TIMEOUT_MS);
      message = translator.finish(promptResult, signal.aborted);
    } finally {
      approvalScope.abort();
      clearTimeout(escalation);
      signal.removeEventListener("abort", onAbort);
      offEvent();
    }

    // Best-effort close session so Antigravity flushes transcript bytes.
    await rpc.request("session/close", { sessionId: acpSessionId }, 5_000).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, FLUSH_WAIT_MS));
  } catch (error) {
    if (!begun) {
      if (host) await host.close().catch(() => undefined);
      if (prepared.resume === "handoff") await rm(session.path, { force: true }).catch(() => undefined);
      throw error;
    }
    message = {
      ...translator.last(),
      stopReason: signal.aborted ? "aborted" : "error",
      errorMessage: signal.aborted ? null : describeError(error),
    };
  }

  // Mark Cohub's Turn in the ingest ledger so terminal Turns appended afterwards sync cleanly without re-sending this one.
  const transcriptSize = await stat(session.path).then((info) => info.size, () => 0);
  if (transcriptSize > 0) {
    const turns = (await readAntigravityTranscript(session.path, session.nativeSessionId).catch(() => null))?.turns ?? [];
    const recorded = turns.filter((entry) => entry.startBytes >= beforeSize && entry.startBytes < transcriptSize);
    const words = (blocks: ContentBlock[]) => blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("").trim();
    const matching = sentText ? recorded.filter((entry) => words(entry.userContent) === sentText) : [];
    const own = matching.length === 1 ? matching[0] : recorded.length === 1 ? recorded[0] : recorded.at(-1);
    const earlier = turns.filter((entry) => entry.startBytes < beforeSize).at(-1);
    executor.ingest.adopt(session, input.sessionId, { turnKey: (own ?? earlier)?.key ?? null, turnId: input.turnId });
  } else {
    executor.ingest.adopt(session, input.sessionId, { turnKey: null, turnId: input.turnId });
  }

  return { session, resume: prepared.resume, message, host };
}

export const antigravityHarness: LocalHarnessAdapter = {
  id: "antigravity",
  binary: BINARY,
  async models(executable, cwd) {
    const result = await probeAcpSession(executable, cwd);
    supportedModes.set(executable, Promise.resolve(result.modes));
    return result.models;
  },
  approvalModes: probeApprovalModes,
  run: runAntigravity,
  session: {
    path: (nativeSessionId) => antigravityTranscriptPath(nativeSessionId),
    startsWithoutFile: true,
    project: (input) => projectChainedSession(input, "antigravity", { id: "cohubId", parent: "cohubParentId" }, (segment) => {
      const summary = summarizeBlocks(segment.blocks);
      return summary ? [{ role: segment.role, text: summary }] : [];
    }),
    rebind: (records) => records,
  },
  transcript: {
    roots: antigravityRoots,
    acceptsDirectory: acceptsAntigravityDirectory,
    acceptsTranscript: acceptsAntigravityTranscript,
    header: (path) => antigravitySessionHeader(path),
    read: (path, signal) => readAntigravityTranscript(path, parseAntigravityTranscriptPath(path)?.nativeSessionId ?? "", signal),
    boundaries: ['"type":"USER_INPUT"', '"type":"PLANNER_RESPONSE"'],
    turnEndRecorded: false,
    replyEnded: antigravityReplyEnded,
    userFinalMarked: false,
    globalTurnKeys: false,
    marksCohubTurns: false,
  },
};
