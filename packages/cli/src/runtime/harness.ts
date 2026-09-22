import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, resolve, win32 } from "node:path";
import type { ContentBlock, RuntimeCapabilities, RuntimeExecutionEvent, RuntimeMessage, RuntimeTurnInput } from "@neta-art/cohub";
import { JsonRpcProcess, record, type JsonRecord } from "./json-rpc.js";
import type { RuntimeSessionStore, NativeSession } from "./session-store.js";
import { codexModelCatalog } from "./model-catalog.js";
import { codexTokenTotals, codexUsage, subtractCodexTokens } from "./codex-usage.js";
import { downloadPublicImage } from "../safe-remote-image.js";
import { serializeDiagnosticError, type RuntimeDiagnostics, type RuntimeDiagnosticContext } from "./diagnostics.js";

export type HarnessOptions = { pi?: string; codex?: string };

export function harnessExecutableCandidates(binary: string, cwd: string, path: string, platform = process.platform, pathExt = process.env.PATHEXT): string[] {
  const windows = platform === "win32";
  const paths = windows ? win32 : { delimiter, join, resolve };
  const extensions = windows && !win32.extname(binary)
    ? ["", ...(pathExt || ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => /^\.[a-z0-9]+$/i.test(ext))]
    : [""];
  const roots = binary.includes("/") || binary.includes("\\")
    ? [paths.resolve(cwd, binary)]
    : path.split(paths.delimiter).map((directory) => directory.replace(/^"(.*)"$/, "$1")).filter(Boolean).map((directory) => paths.resolve(cwd, directory, binary));
  return roots.flatMap((root) => extensions.map((ext) => `${root}${ext}`));
}

/** Discover installed executables only; authentication/capability errors stay explicit. */
export async function installedHarnesses(cwd: string, options: HarnessOptions, path = process.env.PATH ?? ""): Promise<("pi" | "codex")[]> {
  const names = options.pi || options.codex ? (["pi", "codex"] as const).filter((name) => options[name]) : ["pi", "codex"] as const;
  const found = await Promise.all(names.map(async (name) => {
    const binary = options[name] || name;
    const candidates = harnessExecutableCandidates(binary, cwd, path);
    for (const candidate of candidates) {
      try { await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK); if ((await stat(candidate)).isFile()) return name; }
      catch { /* Try the next PATH entry. */ }
    }
    return null;
  }));
  return found.filter((name): name is "pi" | "codex" => name !== null);
}
export type HarnessResult = { state: NativeSession; event: Extract<RuntimeExecutionEvent, { type: "turn.end" }> };
const runtimeEnvironment = (input: RuntimeTurnInput) => ({ COHUB_SPACE_ID: input.spaceId, COHUB_SESSION_ID: input.sessionId, COHUB_TURN_ID: input.turnId });
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown) => typeof value === "string" ? value : "";

export function piContent(value: unknown): ContentBlock[] {
  return array(value).flatMap((entry): ContentBlock[] => {
    const block = record(entry);
    if (block.type === "text") return [{ type: "text", text: text(block.text) }];
    if (block.type === "thinking") return [{ type: "thinking", thinking: text(block.thinking), ...(typeof (block.thinkingSignature ?? block.signature) === "string" ? { signature: String(block.thinkingSignature ?? block.signature) } : {}) }];
    if (block.type === "toolCall") return [{ type: "tool_use", id: text(block.id), name: text(block.name), input: record(block.arguments) }];
    if (block.type === "image") return [{ type: "image", source: { type: "base64", data: text(block.data), media_type: text(block.mimeType) } }];
    return [{ type: "text", text: JSON.stringify(block) }];
  });
}

async function imageForPi(block: Extract<ContentBlock, { type: "image" }>) {
  if (block.source.type === "base64") return { type: "image", data: block.source.data, mimeType: block.source.media_type };
  const image = await downloadPublicImage(block.source.url);
  return { type: "image", data: Buffer.from(image.bytes).toString("base64"), mimeType: image.mimeType };
}

export function promptText(content: ContentBlock[]): string {
  return content.filter((block) => block.type !== "image").map((block) => block.type === "text" ? block.text : JSON.stringify(block)).join("\n");
}

async function initializeCodex(rpc: JsonRpcProcess) {
  await rpc.request("initialize", { clientInfo: { name: "cohub", title: "Cohub", version: "1" }, capabilities: { experimentalApi: true } });
  rpc.write({ method: "initialized", params: {} });
}

/** Ask the native process to stop, then hard-close it if the request does not settle quickly. */
function createAbortEscalation(rpc: JsonRpcProcess, signal: AbortSignal, interrupt: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const abort = () => {
    interrupt();
    timer ??= setTimeout(() => { void rpc.close().catch(() => undefined); }, 5000);
  };
  signal.addEventListener("abort", abort, { once: true });
  return {
    abort,
    clear: () => { signal.removeEventListener("abort", abort); if (timer) clearTimeout(timer); },
  };
}

/** Native files stay authoritative; archival failure only degrades cross-host resume. */
async function finishHarnessTurn(store: RuntimeSessionStore, state: NativeSession, message: RuntimeMessage, resume: HarnessResult["event"]["resume"], turnId: string, diagnosticContext?: RuntimeDiagnosticContext): Promise<HarnessResult> {
  // The store records a redacted diagnostic; native files remain authoritative.
  const archive = await store.archive(state, turnId, diagnosticContext).catch(() => null);
  return { state, event: { type: "turn.end", message, resume, archive } };
}

export async function discoverHarnesses(harnesses: ("pi" | "codex")[], options: HarnessOptions, cwd: string): Promise<RuntimeCapabilities> {
  const models: RuntimeCapabilities["models"] = [];
  await Promise.all(harnesses.map(async (harness) => {
    const rpc = new JsonRpcProcess(options[harness] || harness, harness === "pi" ? ["--mode", "rpc", "--no-session"] : ["app-server", "--listen", "stdio://"], cwd, harness);
    try {
      if (harness === "pi") {
        const result = await rpc.request("get_available_models");
        for (const value of array(result.models)) {
          const model = record(value);
          if (model.id && model.provider) models.push({ harness, id: text(model.id), provider: text(model.provider), name: text(model.name) || text(model.id) });
        }
      } else {
        await initializeCodex(rpc);
        const config = await rpc.request("config/read", { includeLayers: false, cwd });
        const entries: unknown[] = [];
        const cursors = new Set<string>();
        let cursor: string | null = null;
        do {
          const result = await rpc.request("model/list", { cursor, limit: 100 });
          entries.push(...array(result.data));
          cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
          if (entries.length > 2000 || cursor && cursors.has(cursor)) throw new Error("Invalid model catalog pagination");
          if (cursor) cursors.add(cursor);
        } while (cursor);
        models.push(...codexModelCatalog(config, entries));
      }
    } finally { await rpc.close(); }
  }));
  return { harnesses, models };
}

export async function executePi(input: RuntimeTurnInput, options: HarnessOptions, cwd: string, store: RuntimeSessionStore, emit: (event: RuntimeExecutionEvent) => void, signal: AbortSignal, diagnostics?: RuntimeDiagnostics, diagnosticContext?: RuntimeDiagnosticContext): Promise<HarnessResult> {
  if (input.accessMode === "read_only") throw new Error("Pi cannot enforce read-only access; select Cohub or Codex");
  signal.throwIfAborted();
  const { state, resume } = await store.prepare(input, cwd, signal);
  signal.throwIfAborted();
  const rpc = new JsonRpcProcess(options.pi || "pi", ["--mode", "rpc", "--session", state.path], cwd, "pi", runtimeEnvironment(input));
  let ordinal = -1;
  let currentContent: ContentBlock[] = [];
  let last: RuntimeMessage = { ordinal: 0, content: [] };
  const abortEscalation = createAbortEscalation(rpc, signal, () => { void rpc.request("abort").catch(() => undefined); });
  const stopFailureLogging = diagnostics
    ? rpc.onFailure((error) => diagnostics.log("error", "harness.rpc_process_failed", { error: serializeDiagnosticError(error) }, { ...diagnosticContext, component: "harness" }))
    : () => undefined;
  const stopTimeoutLogging = diagnostics
    ? rpc.onTimeout((method, timeoutMs) => diagnostics.log("error", "harness.rpc_timeout", { method, timeoutMs }, { ...diagnosticContext, component: "harness" }))
    : () => undefined;
  try {
    if (input.model) {
      let provider = input.provider;
      if (!provider) {
        const catalog = await rpc.request("get_available_models");
        const matches = array(catalog.models).map(record).filter((model) => model.id === input.model);
        if (matches.length !== 1) throw new Error("Select a provider for this local model");
        provider = text(matches[0]?.provider);
      }
      await rpc.request("set_model", { provider, modelId: input.model });
    }
    if (input.thinkingLevel) await rpc.request("set_thinking_level", { level: input.thinkingLevel });
    const stateResult = await rpc.request("get_state");
    state.nativeSessionId = text(stateResult.sessionId) || state.nativeSessionId;
    const model = record(stateResult.model);
    const content = input.messages.flatMap((message) => message.content);
    const images = await Promise.all(content.flatMap((block) => block.type === "image" ? [imageForPi(block)] : []));
    signal.throwIfAborted();
    await store.started(state, input.turnId);
    await new Promise<void>((resolve, reject) => {
      const offFailure = rpc.onFailure(reject);
      const off = rpc.onEvent((event) => {
        try {
          if (event.type === "extension_ui_request") {
            if (["confirm", "select", "input", "editor"].includes(text(event.method))) rpc.write({ type: "extension_ui_response", id: event.id, cancelled: true });
            return;
          }
          if (event.type === "message_start" && record(event.message).role === "assistant") { ordinal++; currentContent = []; emit({ type: "message.start", ordinal }); }
          if (event.type === "message_end" && record(event.message).role === "assistant") {
            currentContent = piContent(record(event.message).content);
            emit({ type: "content.replace", ordinal, content: currentContent });
          }
          if (event.type === "tool_execution_start") {
            const id = text(event.toolCallId);
            if (!currentContent.some((block) => block.type === "tool_use" && block.id === id)) currentContent.push({ type: "tool_use", id, name: text(event.toolName), input: record(event.args), _meta: { toolStatus: "running" } });
            emit({ type: "content.replace", ordinal, content: [...currentContent] });
          }
          if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
            const id = text(event.toolCallId);
            const rawResult = event.type === "tool_execution_end" ? event.result : event.partialResult;
            const result = record(rawResult);
            const resultContent = typeof rawResult === "string" ? rawResult : piContent(result.content);
            currentContent = currentContent.filter((block) => block.type !== "tool_result" || block.tool_use_id !== id);
            currentContent.push({ type: "tool_result", tool_use_id: id, content: resultContent, is_error: Boolean(event.isError), _meta: { toolStatus: event.type === "tool_execution_end" ? "done" : "running" } });
            emit({ type: "content.replace", ordinal, content: [...currentContent] });
          }
          if (event.type === "message_update") {
            const delta = record(event.assistantMessageEvent);
            if (delta.type === "text_delta" || delta.type === "thinking_delta") emit({ type: "text.delta", ordinal, index: Number(delta.contentIndex ?? 0), kind: delta.type === "text_delta" ? "text" : "thinking", delta: text(delta.delta) });
          }
          if (event.type === "turn_end") {
            const message = record(event.message);
            const content = piContent(message.content);
            for (const resultValue of array(event.toolResults)) {
              const result = record(resultValue);
              content.push({ type: "tool_result", tool_use_id: text(result.toolCallId), content: typeof result.content === "string" ? result.content : piContent(result.content), is_error: Boolean(result.isError) });
            }
            last = { ordinal: Math.max(0, ordinal), content, provider: text(message.provider) || text(model.provider), model: text(message.model) || text(model.id), usage: message.usage as RuntimeMessage["usage"], stopReason: text(message.stopReason) === "toolUse" ? "tool_use" : text(message.stopReason) || "stop", errorMessage: text(message.errorMessage) || null };
            emit({ type: "content.replace", ordinal: last.ordinal, content });
            if (last.stopReason === "tool_use") emit({ type: "message.commit", message: last });
          }
          if (event.type === "agent_settled" || event.type === "agent_end" && event.willRetry === undefined) { off(); offFailure(); resolve(); }
        } catch (error) { off(); offFailure(); reject(error); }
      });
      void rpc.request("prompt", { message: promptText(content), images }).catch((error) => { off(); offFailure(); reject(error); });
    });
    await rpc.request("get_state");
  } catch (error) {
    if (!state.pendingTurnId) throw error;
    last = { ...last, stopReason: signal.aborted ? "aborted" : "error", errorMessage: signal.aborted ? null : error instanceof Error ? error.message : String(error) };
  } finally {
    abortEscalation.clear();
    stopFailureLogging();
    stopTimeoutLogging();
    await rpc.close();
  }
  if (signal.aborted) last = { ...last, stopReason: "aborted" };
  return finishHarnessTurn(store, state, last, resume, input.turnId, {
    component: "harness",
    sessionId: input.sessionId,
    turnId: input.turnId,
    harness: "pi",
    traceContext: input.traceContext,
  });
}

export function codexItemContent(item: JsonRecord): ContentBlock[] {
  if (item.type === "agentMessage" || item.type === "plan") return [{ type: "text", text: text(item.text) }];
  if (item.type === "reasoning") return [{ type: "thinking", thinking: [...array(item.summary), ...array(item.content)].map(text).join("\n") }];
  if (item.type === "userMessage") return [];
  if (item.type === "contextCompaction") return [{ type: "system_note", note_type: "compacted", text: "Context compacted" }];
  const id = text(item.id);
  const name = item.type === "commandExecution" ? "bash" : item.type === "fileChange" ? "apply_patch" : text(item.tool) || text(item.type);
  const input = item.type === "commandExecution" ? { command: item.command, cwd: item.cwd } : item.type === "fileChange" ? { changes: item.changes } : record(item.arguments);
  return [
    { type: "tool_use", id, name, input },
    { type: "tool_result", tool_use_id: id, content: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : JSON.stringify(item.result ?? item.error ?? item.changes ?? item), is_error: item.status === "failed" || typeof item.exitCode === "number" && item.exitCode !== 0 },
  ];
}

export async function executeCodex(input: RuntimeTurnInput, options: HarnessOptions, cwd: string, store: RuntimeSessionStore, emit: (event: RuntimeExecutionEvent) => void, signal: AbortSignal, diagnostics?: RuntimeDiagnostics, diagnosticContext?: RuntimeDiagnosticContext): Promise<HarnessResult> {
  signal.throwIfAborted();
  const { state, resume } = await store.prepare(input, cwd, signal);
  signal.throwIfAborted();
  const rpc = new JsonRpcProcess(options.codex || "codex", ["app-server", "--listen", "stdio://"], cwd, "codex", runtimeEnvironment(input));
  const stopFailureLogging = diagnostics
    ? rpc.onFailure((error) => diagnostics.log("error", "harness.rpc_process_failed", { error: serializeDiagnosticError(error) }, { ...diagnosticContext, component: "harness" }))
    : () => undefined;
  const stopTimeoutLogging = diagnostics
    ? rpc.onTimeout((method, timeoutMs) => diagnostics.log("error", "harness.rpc_timeout", { method, timeoutMs }, { ...diagnosticContext, component: "harness" }))
    : () => undefined;
  let nativeTurnId: string | null = null;
  let ordinal = -1;
  const ordinals = new Map<string, number>();
  const items = new Map<string, JsonRecord>();
  const outputs = new Map<string, string>();
  const completedItems = new Set<string>();
  let pending: RuntimeMessage | null = null;
  let final: RuntimeMessage = { ordinal: 0, content: [] };
  let usage: RuntimeMessage["usage"];
  let usageBaseline = state.codexTokenTotals;
  const latestMessage = (): RuntimeMessage => {
    if (pending && pending.ordinal >= ordinal) return pending;
    const item = [...items.entries()].find(([id]) => ordinals.get(id) === ordinal)?.[1];
    return { ordinal: Math.max(0, ordinal), content: item ? codexItemContent(item) : [] };
  };
  const abortEscalation = createAbortEscalation(rpc, signal, () => {
    if (nativeTurnId) void rpc.request("turn/interrupt", { threadId: state.nativeSessionId, turnId: nativeTurnId }).catch(() => undefined);
  });
  try {
    await initializeCodex(rpc);
    const threadOptions = {
      cwd,
      ...(input.model ? { model: input.model } : {}),
      ...(input.provider && input.provider !== "codex" ? { modelProvider: input.provider } : {}),
      ...(input.accessMode === "read_only" ? { sandbox: "read-only" } : {}),
    };
    const opened = resume === "native"
      ? await rpc.request("thread/resume", { ...threadOptions, threadId: state.nativeSessionId, path: state.path, excludeTurns: true })
      : resume === "restored"
        ? await rpc.request("thread/fork", { ...threadOptions, threadId: state.nativeSessionId, path: state.path, excludeTurns: true })
        : resume === "handoff"
          ? await rpc.request("thread/resume", { ...threadOptions, threadId: state.nativeSessionId, path: state.path, excludeTurns: true })
          : await rpc.request("thread/start", threadOptions);
    const thread = record(opened.thread);
    if (typeof thread.id !== "string" || typeof thread.path !== "string") throw new Error("Codex did not provide a durable native thread");
    state.nativeSessionId = thread.id;
    state.path = thread.path;
    const provider = text(opened.modelProvider) || "codex";
    const model = text(opened.model) || input.model;
    const content: JsonRecord[] = await Promise.all(input.messages.flatMap((message) => message.content).map(async (block) => {
      if (block.type === "image") {
        const image = await imageForPi(block);
        return { type: "image", url: `data:${image.mimeType};base64,${image.data}` };
      }
      return { type: "text", text: block.type === "text" ? block.text : JSON.stringify(block), text_elements: [] };
    }));
    signal.throwIfAborted();
    await store.started(state, input.turnId);
    await new Promise<void>((resolve, reject) => {
      const offFailure = rpc.onFailure(reject);
      const off = rpc.onEvent((event) => {
        try {
          const method = text(event.method);
          const params = record(event.params);
          if (event.id != null) {
            // Keep native approval policy. An unattended client never grants an escalation.
            rpc.write({ id: event.id, error: { code: -32000, message: "Approval requires an interactive local client" } });
            return;
          }
          if (params.threadId !== state.nativeSessionId) return;
          if (method === "turn/started") { nativeTurnId = text(record(params.turn).id); if (signal.aborted) abortEscalation.abort(); }
          if (method === "thread/tokenUsage/updated" && nativeTurnId && params.turnId === nativeTurnId) {
            const nativeUsage = record(params.tokenUsage);
            const total = codexTokenTotals(nativeUsage.total);
            usageBaseline ??= subtractCodexTokens(total, codexTokenTotals(nativeUsage.last));
            state.codexTokenTotals = total;
            usage = codexUsage(subtractCodexTokens(total, usageBaseline));
          }
          if (method === "item/started") {
            const item = record(params.item);
            if (item.type === "userMessage" || completedItems.has(text(item.id))) return;
            const existingOrdinal = ordinals.get(text(item.id));
            if (pending && (existingOrdinal == null || existingOrdinal > pending.ordinal)) { emit({ type: "message.commit", message: pending }); pending = null; }
            if (existingOrdinal != null) {
              items.set(text(item.id), item);
              if (item.type === "agentMessage" && text(item.text)) emit({ type: "content.replace", ordinal: existingOrdinal, content: codexItemContent(item) });
              return;
            }
            ordinal++;
            ordinals.set(text(item.id), ordinal);
            items.set(text(item.id), item);
            emit({ type: "message.start", ordinal });
            if (!["agentMessage", "reasoning", "plan"].includes(text(item.type))) emit({ type: "content.replace", ordinal, content: codexItemContent(item).filter((block) => block.type !== "tool_result") });
          }
          if (method === "item/agentMessage/delta" || method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
            const id = text(params.itemId);
            if (completedItems.has(id)) return;
            const itemOrdinal = ordinals.get(id);
            const item = items.get(id);
            if (item) {
              if (method === "item/agentMessage/delta") item.text = text(item.text) + text(params.delta);
              else { const key = method.includes("summary") ? "summary" : "content"; item[key] = [array(item[key]).map(text).join("\n") + text(params.delta)]; }
            }
            if (itemOrdinal != null) emit({ type: "text.delta", ordinal: itemOrdinal, index: 0, kind: method === "item/agentMessage/delta" ? "text" : "thinking", delta: text(params.delta) });
          }
          if (method === "item/commandExecution/outputDelta") {
            const id = text(params.itemId);
            const item = items.get(id);
            const itemOrdinal = ordinals.get(id);
            if (item && itemOrdinal != null) {
              const output = (outputs.get(id) ?? "") + text(params.delta);
              outputs.set(id, output);
              item.aggregatedOutput = output;
              emit({ type: "content.replace", ordinal: itemOrdinal, content: codexItemContent(item) });
            }
          }
          if (method === "item/completed") {
            const item = record(params.item);
            if (item.type === "userMessage" || completedItems.has(text(item.id))) return;
            completedItems.add(text(item.id));
            const itemOrdinal = ordinals.get(text(item.id)) ?? ++ordinal;
            if (!ordinals.has(text(item.id))) { ordinals.set(text(item.id), itemOrdinal); emit({ type: "message.start", ordinal: itemOrdinal }); }
            items.set(text(item.id), item);
            const message: RuntimeMessage = { ordinal: itemOrdinal, content: codexItemContent(item), provider, model, stopReason: "stop" };
            emit({ type: "content.replace", ordinal: itemOrdinal, content: message.content });
            if (pending && pending.ordinal > itemOrdinal) emit({ type: "message.commit", message });
            else {
              if (pending && pending.ordinal !== itemOrdinal) emit({ type: "message.commit", message: pending });
              pending = message;
            }
          }
          if (method === "turn/completed") {
            const turn = record(params.turn);
            final = { ...latestMessage(), provider, model, stopReason: turn.status === "interrupted" ? "aborted" : turn.status === "failed" ? "error" : "stop", errorMessage: text(record(turn.error).message) || null };
            off(); offFailure(); resolve();
          }
        } catch (error) { off(); offFailure(); reject(error); }
      });
      void rpc.request("turn/start", { threadId: state.nativeSessionId, clientUserMessageId: input.userMessageId, input: content, ...(input.thinkingLevel ? { effort: input.thinkingLevel } : {}) })
        .then((result) => { nativeTurnId = text(record(result.turn).id); if (signal.aborted) abortEscalation.abort(); })
        .catch((error) => { off(); offFailure(); reject(error); });
    });
  } catch (error) {
    if (!state.pendingTurnId) throw error;
    final = { ...latestMessage(), stopReason: signal.aborted ? "aborted" : "error", errorMessage: signal.aborted ? null : error instanceof Error ? error.message : String(error) };
  } finally {
    abortEscalation.clear();
    stopFailureLogging();
    stopTimeoutLogging();
    await rpc.close();
  }
  if (signal.aborted) final = { ...final, stopReason: "aborted" };
  if (usage) final = { ...final, usage };
  return finishHarnessTurn(store, state, final, resume, input.turnId, {
    component: "harness",
    sessionId: input.sessionId,
    turnId: input.turnId,
    harness: "codex",
    traceContext: input.traceContext,
  });
}
