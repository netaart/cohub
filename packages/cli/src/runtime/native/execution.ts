import type { ContentBlock, RuntimeExecutionEvent, RuntimeMessage, RuntimeTurnInput } from "@neta-art/cohub";
import { imageForPi, type HarnessOptions } from "../harness.js";
import { JsonRpcProcess, record, RpcProcessClosedError, type JsonRecord } from "../json-rpc.js";
import { ProcessCleanupUncertainError } from "../process-group.js";
import type { RuntimeArchiveStore } from "../archive-store.js";
import { serializeDiagnosticError, type RuntimeDiagnosticContext, type RuntimeDiagnostics } from "../diagnostics.js";
import { openPrivateServer, type CodexChannel, type CodexShared } from "./codex-link.js";
import type { NativeIngest } from "./ingest.js";
import { PI_DISCONNECTED, type PiLink, type PiSessionLink } from "./pi-link.js";
import type { ExecutionResults } from "./results.js";
import type { NativeSession, NativeSessions, ResumeKind } from "./sessions.js";
import { codexTranslator, piTranslator } from "./translate.js";

const text = (value: unknown) => typeof value === "string" ? value : "";
/** A stop request that the harness does not honour within this long ends its private process. */
const ABORT_ESCALATION_MS = 5_000;
/** Pause before asking a busy Pi again, so a Turn that is starting has reported itself. */
const PI_BUSY_RETRY_MS = 100;

export type Executor = {
  cwd: string;
  executables: HarnessOptions;
  sessions: NativeSessions;
  results: ExecutionResults;
  ingest: NativeIngest;
  archives: RuntimeArchiveStore;
  pi: PiLink;
  codex: CodexShared;
  piExtension: string;
  diagnostics?: RuntimeDiagnostics;
};

export type HarnessResult = {
  session: NativeSession;
  event: Extract<RuntimeExecutionEvent, { type: "turn.end" }>;
  uncertainCleanup?: { processGroupId: number; error: string };
};

type Run = { session: NativeSession; resume: ResumeKind; message: RuntimeMessage; host: JsonRpcProcess | null };
type Turn = {
  input: RuntimeTurnInput;
  emit: (event: RuntimeExecutionEvent) => void;
  signal: AbortSignal;
  diverged: string | null;
  started: (session: NativeSession) => Promise<void>;
};

/**
 * Run one Cohub Turn in a local harness. Both harnesses are driven through the same interface a
 * terminal user shares: Pi through the Cohub extension inside the Pi process, Codex through its
 * app-server.
 */
export async function executeTurn(executor: Executor, input: RuntimeTurnInput, emit: Turn["emit"], signal: AbortSignal, requestId: string | null, context?: RuntimeDiagnosticContext): Promise<HarnessResult> {
  signal.throwIfAborted();
  const diverged = await executor.results.admit(input);
  const turn: Turn = { input, emit, signal, diverged, started: (session) => executor.results.start(session, input, requestId) };
  const run = await (input.harness === "pi" ? runPi : runCodex)(executor, turn, context);
  let uncertainCleanup: HarnessResult["uncertainCleanup"];
  if (run.host) uncertainCleanup = await closeHost(run.host, run.message.errorMessage);
  const message = signal.aborted ? { ...run.message, stopReason: "aborted" } : run.message;
  const archive = await executor.archives.stage({ sessionId: input.sessionId, harness: input.harness, nativeSessionId: run.session.nativeSessionId, path: run.session.path }, input.turnId).catch((error: unknown) => {
    // A missing archive only costs cross-machine native resume; the file itself is intact.
    executor.diagnostics?.log("warn", "archive.capture_failed", { error: serializeDiagnosticError(error) }, { ...context, component: "archive" });
    return null;
  });
  executor.ingest.advance(run.session.path, input.turnId);
  return { session: run.session, event: { type: "turn.end", message, resume: run.resume, archive }, ...(uncertainCleanup ? { uncertainCleanup } : {}) };
}

/** Variables a Turn's tools see, so a `cohub` call inside a tool knows where it runs. */
const turnEnvironment = (input: RuntimeTurnInput) => ({ COHUB_SPACE_ID: input.spaceId, COHUB_SESSION_ID: input.sessionId, COHUB_TURN_ID: input.turnId });

async function runPi(executor: Executor, turn: Turn, context?: RuntimeDiagnosticContext): Promise<Run> {
  const { input, signal } = turn;
  if (input.accessMode === "read_only") throw new Error("Pi cannot enforce read-only access; select Cohub or Codex");
  // Cohub drives every Pi through its extension, which needs the control socket and a recent Pi.
  if (executor.pi.unavailable) throw new Error(executor.pi.unavailable);
  const prepared = await executor.sessions.prepare({
    sessionId: input.sessionId, turnId: input.turnId, harness: "pi", cwd: executor.cwd,
    provider: input.provider, context: input.context, signal,
    // A terminal Pi is continued only through its extension; without one it is read-only.
    resumable: (transcript) => transcript.path !== turn.diverged && (transcript.origin === "cohub" || executor.pi.find(transcript.nativeSessionId) !== null),
  });
  let session = prepared.session;
  let link = executor.pi.find(session.nativeSessionId);
  let host: JsonRpcProcess | null = null;
  let message: RuntimeMessage = { ordinal: 0, content: [] };
  let begun = false;
  try {
    if (!link) {
      host = new JsonRpcProcess(executor.executables.pi || "pi", ["--mode", "rpc", "--session", session.path, "-e", executor.piExtension], executor.cwd, "pi", turnEnvironment(input));
      watchHost(host, executor.diagnostics, context);
      const rpc = host;
      // Nobody is at this Pi's terminal to answer an extension's question.
      rpc.onEvent((event) => {
        if (event.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(text(event.method))) rpc.write({ type: "extension_ui_response", id: event.id, cancelled: true });
      });
      await configurePiHost(host, input);
      link = await Promise.race([
        executor.pi.waitFor({ sessionId: session.nativeSessionId, sessionFile: session.path }, signal),
        new Promise<never>((_, reject) => host?.onFailure(reject)),
      ]);
    }
    const piSession: PiSessionLink = link;
    session = { ...session, nativeSessionId: piSession.sessionId };
    // Never interleave with a Turn a terminal user is running; follow it instead.
    await executor.pi.idle(piSession.sessionId, signal);
    const content = await piPrompt(input);
    signal.throwIfAborted();
    await turn.started(session);
    begun = true;
    const translator = piTranslator(turn.emit);
    const model = !host && input.model && input.provider ? { provider: input.provider, id: input.model } : null;
    await new Promise<void>((resolve, reject) => {
      let escalation: ReturnType<typeof setTimeout> | undefined;
      /** Events held until Pi takes the prompt; until then they belong to a terminal Turn. */
      let held: Array<Record<string, unknown>> | null = [];
      let done = false;
      const finish = (error?: unknown) => {
        if (done) return;
        done = true;
        off(); signal.removeEventListener("abort", abort); clearTimeout(escalation);
        if (error) reject(error); else resolve();
      };
      const feed = (event: Record<string, unknown>) => {
        try { if (translator.push(event)) finish(); } catch (error) { finish(error); }
      };
      const off = executor.pi.subscribe(piSession.sessionId, (event) => {
        if (event.type === PI_DISCONNECTED) { finish(new Error("Pi exited during the Turn")); return; }
        if (held) held.push(event); else feed(event);
      });
      const abort = () => {
        // Not taken yet: the Pi is running someone else's Turn, which is not Cohub's to stop.
        if (held) { finish(signal.reason ?? new Error("Aborted")); return; }
        void executor.pi.abort(piSession.sessionId).catch(() => undefined);
        if (host) escalation = setTimeout(() => void host?.close().catch(() => undefined), ABORT_ESCALATION_MS);
      };
      signal.addEventListener("abort", abort, { once: true });
      void (async () => {
        for (;;) {
          // Only what follows this request can be this Turn's.
          held = [];
          const { accepted } = await executor.pi.prompt(piSession.sessionId, { turnId: input.turnId, content, model, thinkingLevel: host ? null : input.thinkingLevel ?? null, env: turnEnvironment(input) });
          if (accepted) break;
          // The terminal started a Turn first: wait for it to settle, then ask again.
          await new Promise((resolve) => setTimeout(resolve, PI_BUSY_RETRY_MS));
          await executor.pi.idle(piSession.sessionId, signal);
          if (done) return;
        }
        const events = held ?? [];
        held = null;
        if (done) { void executor.pi.abort(piSession.sessionId).catch(() => undefined); return; }
        for (const event of events) feed(event);
        if (signal.aborted) abort();
      })().catch(finish);
      if (signal.aborted) abort();
    });
    message = translator.last();
    // The Pi keeps running for its terminal user; its tools no longer work for this Turn.
    if (!host) void executor.pi.context(piSession.sessionId, { COHUB_TURN_ID: null }).catch(() => undefined);
  } catch (error) {
    // Before the prompt, nothing ran and the error is the outcome.
    if (!begun) {
      if (host) await closeHost(host, null).catch(() => undefined);
      throw error;
    }
    message = { ...message, stopReason: signal.aborted ? "aborted" : "error", errorMessage: signal.aborted ? null : error instanceof Error ? error.message : String(error) };
  }
  return { session, resume: prepared.resume, message, host };
}

/** A Pi that Cohub starts is configured through its RPC before the extension takes the prompt. */
async function configurePiHost(host: JsonRpcProcess, input: RuntimeTurnInput) {
  if (input.model) {
    let provider = input.provider;
    if (!provider) {
      const catalog = await host.request("get_available_models");
      const matches = (Array.isArray(catalog.models) ? catalog.models : []).map(record).filter((model) => model.id === input.model);
      if (matches.length !== 1) throw new Error("Select a provider for this local model");
      provider = text(matches[0]?.provider);
    }
    await host.request("set_model", { provider, modelId: input.model });
  }
  if (input.thinkingLevel) await host.request("set_thinking_level", { level: input.thinkingLevel });
}

async function piPrompt(input: RuntimeTurnInput) {
  const blocks = input.messages.flatMap((message) => message.content);
  return await Promise.all(blocks.map(async (block): Promise<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> => {
    if (block.type === "image") return await imageForPi(block) as { type: "image"; data: string; mimeType: string };
    return { type: "text", text: block.type === "text" ? block.text : JSON.stringify(block) };
  }));
}

async function runCodex(executor: Executor, turn: Turn, context?: RuntimeDiagnosticContext): Promise<Run> {
  const { input, signal } = turn;
  const shared = await executor.codex.get();
  const prepared = await executor.sessions.prepare({
    sessionId: input.sessionId, turnId: input.turnId, harness: "codex", cwd: executor.cwd,
    provider: input.provider, context: input.context, signal,
    // Only the shared server coordinates with terminal clients; a private one never opens their files.
    resumable: (transcript) => transcript.path !== turn.diverged && (transcript.origin === "cohub" || shared !== null),
  });
  let session = prepared.session;
  let host: JsonRpcProcess | null = null;
  let channel: CodexChannel | null = shared;
  let message: RuntimeMessage = { ordinal: 0, content: [] };
  let begun = false;
  try {
    if (!channel) {
      host = new JsonRpcProcess(executor.executables.codex || "codex", ["app-server", "--listen", "stdio://"], executor.cwd, "codex", turnEnvironment(input));
      watchHost(host, executor.diagnostics, context);
      channel = await openPrivateServer(host);
    }
    const codex = channel;
    const threadOptions = {
      cwd: executor.cwd,
      ...(input.model ? { model: input.model } : {}),
      ...(input.provider && input.provider !== "codex" ? { modelProvider: input.provider } : {}),
      ...(input.accessMode === "read_only" ? { sandbox: "read-only" } : {}),
      // Tools of a shared server otherwise see the environment of whoever started that server.
      config: { "shell_environment_policy.set.COHUB_SPACE_ID": input.spaceId, "shell_environment_policy.set.COHUB_SESSION_ID": input.sessionId },
    };
    const existing = { ...threadOptions, threadId: session.nativeSessionId, path: session.path, excludeTurns: true };
    const opened = prepared.resume === "new" ? await codex.request("thread/start", threadOptions)
      : prepared.resume === "restored" ? await codex.request("thread/fork", existing)
        : await codex.request("thread/resume", existing);
    const thread = record(opened.thread);
    if (typeof thread.id !== "string" || typeof thread.path !== "string") throw new Error("Codex did not provide a durable native thread");
    const threadId = thread.id;
    if (thread.path !== session.path || threadId !== session.nativeSessionId) {
      session = { ...session, nativeSessionId: threadId, path: thread.path };
      executor.ingest.adopt(session, input.sessionId);
    }
    const translator = codexTranslator(turn.emit, { provider: text(opened.modelProvider) || "codex", model: text(opened.model) || input.model || null });
    const content = await codexPrompt(input);
    signal.throwIfAborted();
    await turn.started(session);
    begun = true;
    let nativeTurnId: string | null = null;
    executor.codex.driving.add(threadId);
    await new Promise<void>((resolve, reject) => {
      let escalation: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = (error?: unknown) => {
        if (done) return;
        done = true;
        off(); offClose(); signal.removeEventListener("abort", abort); clearTimeout(escalation);
        if (error) reject(error); else resolve();
      };
      const interrupt = () => { if (nativeTurnId) void codex.request("turn/interrupt", { threadId, turnId: nativeTurnId }).catch(() => undefined); };
      const off = codex.onEvent((event) => {
        const params = event.params;
        if (event.id != null) {
          // An unattended Cohub Turn never grants an escalation.
          if (!codex.shared || params.threadId === threadId && (!nativeTurnId || params.turnId === nativeTurnId)) codex.refuse(event.id, "Approval requires an interactive local client");
          return;
        }
        if (params.threadId !== threadId) return;
        // A resumed thread replays its last usage; only this Turn's counts belong to it.
        if (event.method === "thread/tokenUsage/updated" && params.turnId !== nativeTurnId) return;
        if (event.method === "turn/started" && !nativeTurnId) { nativeTurnId = text(record(params.turn).id) || null; if (signal.aborted) interrupt(); }
        if (event.method === "turn/completed" && nativeTurnId && text(record(params.turn).id) !== nativeTurnId) return;
        try { if (translator.push(event)) finish(); } catch (error) { finish(error); }
      });
      const offClose = codex.onClose((error) => finish(error));
      const abort = () => {
        interrupt();
        if (host) escalation = setTimeout(() => void host?.close().catch(() => undefined), ABORT_ESCALATION_MS);
      };
      signal.addEventListener("abort", abort, { once: true });
      codex.request("turn/start", { threadId, clientUserMessageId: input.turnId, input: content, ...(input.thinkingLevel ? { effort: input.thinkingLevel } : {}) })
        .then((result) => { nativeTurnId ??= text(record(result.turn).id) || null; if (signal.aborted) interrupt(); })
        .catch(finish);
    }).finally(() => executor.codex.driving.delete(threadId));
    message = translator.last();
  } catch (error) {
    if (!begun) {
      if (host) await closeHost(host, null).catch(() => undefined);
      throw error;
    }
    message = { ...message, stopReason: signal.aborted ? "aborted" : "error", errorMessage: signal.aborted ? null : error instanceof Error ? error.message : String(error) };
  }
  return { session, resume: prepared.resume, message, host };
}

async function codexPrompt(input: RuntimeTurnInput): Promise<JsonRecord[]> {
  return await Promise.all(input.messages.flatMap((message) => message.content).map(async (block: ContentBlock) => {
    if (block.type === "image") {
      const image = await imageForPi(block);
      return { type: "image", url: `data:${image.mimeType};base64,${image.data}` };
    }
    return { type: "text", text: block.type === "text" ? block.text : JSON.stringify(block), text_elements: [] };
  }));
}

function watchHost(host: JsonRpcProcess, diagnostics: RuntimeDiagnostics | undefined, context: RuntimeDiagnosticContext | undefined) {
  if (!diagnostics) return;
  host.onFailure((error) => {
    if (!(error instanceof RpcProcessClosedError)) diagnostics.log("error", "harness.rpc_process_failed", { error: serializeDiagnosticError(error) }, { ...context, component: "harness" });
  });
  host.onTimeout((method, timeoutMs) => diagnostics.log("error", "harness.rpc_timeout", { method, timeoutMs }, { ...context, component: "harness" }));
}

/** Close a harness process Cohub started. An unconfirmable cleanup marks the result uncertain; it never masks it. */
async function closeHost(host: JsonRpcProcess, executionError: string | null | undefined): Promise<HarnessResult["uncertainCleanup"]> {
  return await host.close().then(
    () => undefined,
    (cleanupError: unknown) => {
      const processGroupId = host.processGroupId;
      if (!(cleanupError instanceof ProcessCleanupUncertainError) || processGroupId == null) throw cleanupError;
      const detail = executionError ? `; execution error: ${executionError}` : "";
      return { processGroupId, error: `${cleanupError.message}${detail}` };
    },
  );
}
