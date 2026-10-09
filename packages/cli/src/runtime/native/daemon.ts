import type { NativeRuntimeEvent, NativeTurnProgress } from "@neta-art/cohub";
import type { RuntimeArchiveStore } from "../archive-store.js";
import { serializeDiagnosticError, type RuntimeDiagnostics } from "../diagnostics.js";
import type { HarnessOptions } from "../harness.js";
import { record } from "../json-rpc.js";
import type { SessionTurnProjectionClient } from "../turn-projection.js";
import { readTranscript, type Harness } from "./adapters.js";
import { CodexShared, type CodexChannel, type CodexEvent } from "./codex-link.js";
import { readNativeConfig, type NativeConfig } from "./config.js";
import type { Executor } from "./execution.js";
import { DEFAULT_IMPORT_CONCURRENCY, NativeIngest, type ImportFilter, type ImportJob, type TranscriptState } from "./ingest.js";
import { piExtensionSource, piExtensionState, type PiExtensionState } from "./install.js";
import { controlSocketPath } from "./pi-extension.js";
import { PI_MIN_VERSION, PiLink, type PiSessionLink } from "./pi-link.js";
import { atLeast, formatVersion, harnessVersion } from "./version.js";
import { ExecutionResults } from "./results.js";
import { NativeSessions } from "./sessions.js";
import { codexTranslator, LiveProgress, piTranslator, type Translator } from "./translate.js";
import { nativeWebSocketTransport } from "./transport.js";
import { readRuntimeSpaceBindings } from "../space-binding.js";

const text = (value: unknown) => typeof value === "string" ? value : "";
/** Streamed previews reach the web at most this often. */
const STREAM_INTERVAL_MS = 250;
/** A client Cohub cannot stream is previewed from its file, at most this often. */
const FILE_PREVIEW_INTERVAL_MS = 2_000;
/** A file preview waits at least this many times as long as its last read took. */
const FILE_PREVIEW_COST_FACTOR = 20;

export type NativeStatus = {
  synced: Harness[];
  transcripts: number;
  running: number;
  pi: { extension: PiExtensionState; connected: number; unavailable: string | null } | null;
  codex: { control: "shared" | "private"; watching: number } | null;
  import: ImportJob & { queued: number; running: number };
};

type Stream = { translator: Translator; progress: LiveProgress };

/**
 * Everything the Runtime does with native sessions: the ingest engine (data plane), the Pi and
 * Codex links (control plane), and the executor that runs Cohub Turns through them.
 */
export class NativeRuntime {
  readonly ingest: NativeIngest;
  readonly executor: Executor;
  private readonly pi: PiLink;
  private readonly codex: CodexShared;
  private readonly streams = new Map<string, Stream>();
  private readonly filePreviews = new Map<string, { progress: LiveProgress; timer: ReturnType<typeof setTimeout> | null; readMs: number }>();
  private readonly watched = new Map<string, { path: string | null }>();
  private readonly active = new Set<string>();
  private send: ((event: NativeRuntimeEvent) => Promise<unknown>) | null = null;
  private extension: PiExtensionState = "missing";

  constructor(private readonly options: {
    spaceId: string;
    root: string;
    stateRoot: string;
    harnesses: Harness[];
    executables: HarnessOptions;
    identity: string;
    config: NativeConfig | null;
    archives: RuntimeArchiveStore;
    projectionSource: SessionTurnProjectionClient;
    diagnostics: RuntimeDiagnostics;
  }) {
    this.pi = new PiLink({
      socketPath: controlSocketPath(options.root), owns: (cwd) => this.ingest.owns(cwd),
      onEvent: (link, event) => this.onPiEvent(link, event),
      onConnect: (link) => this.ingest.controlChanged("pi", link.sessionId),
      onDisconnect: (link) => {
        this.endStream(`pi:${link.sessionId}`);
        this.ingest.controlChanged("pi", link.sessionId);
        if (link.sessionFile) this.ingest.touch(link.sessionFile);
      },
    });
    this.codex = new CodexShared(options.executables.codex || "codex", options.root, Boolean(options.config?.codexShared) && options.harnesses.includes("codex"));
    this.codex.onConnect((channel) => this.observeCodex(channel));
    this.ingest = new NativeIngest({
      spaceId: options.spaceId,
      cwd: options.root,
      harnesses: this.synced,
      enabledAt: options.config?.enabledAt ?? new Date().toISOString(),
      root: options.stateRoot,
      archives: options.archives,
      hooks: {
        piSettled: (nativeSessionId, mtimeMs) => {
          const link = this.pi.find(nativeSessionId);
          if (!link) return null;
          if (!link.idle) return false;
          // Idle and nothing written since it settled: done. A newer write lets the file decide.
          return link.settledAt >= mtimeMs ? true : null;
        },
        controllable: (state) => state.harness === "pi"
          ? this.pi.find(state.nativeSessionId) !== null
          : this.codex.enabled && (this.active.has(state.nativeSessionId) || this.watched.has(state.nativeSessionId) || this.codex.driving.has(state.nativeSessionId)),
        abortTurn: (state) => {
          const stop = state.harness === "pi"
            ? this.pi.abort(state.nativeSessionId)
            : state.runningTurnKey ? this.codex.interrupt(state.nativeSessionId, state.runningTurnKey) : Promise.resolve(false);
          void stop.catch((error: unknown) => options.diagnostics.log("warn", "native.stop_failed", { error: serializeDiagnosticError(error) }, { harness: state.harness, sessionId: state.sessionId ?? undefined }));
        },
        onGrowth: (state) => this.onGrowth(state),
        onRunning: (state, turnId) => this.onRunning(state, turnId),
        onError: (error, context) => options.diagnostics.log("warn", "native.sync_pending", { path: context.path, error: serializeDiagnosticError(error) }, { component: "native", harness: context.harness }),
      },
    });
    const results = new ExecutionResults(options.stateRoot);
    this.executor = {
      cwd: options.root,
      executables: options.executables,
      sessions: new NativeSessions({
        root: options.stateRoot, spaceId: options.spaceId, projectionSource: options.projectionSource, archives: options.archives, ingest: this.ingest,
        onRestoreFailed: (error, context) => options.diagnostics.log("warn", "native.restore_failed", { error: serializeDiagnosticError(error), unrestorable: context.unrestorable }, { component: "archive", harness: context.harness, sessionId: context.sessionId }),
      }),
      results,
      ingest: this.ingest,
      archives: options.archives,
      pi: this.pi,
      codex: this.codex,
      piExtension: piExtensionSource(),
      diagnostics: options.diagnostics,
    };
  }

  private get synced(): Harness[] {
    const { config, root, harnesses } = this.options;
    return config?.root === root ? config.harnesses.filter((harness) => harnesses.includes(harness)) : [];
  }

  async start(signal: AbortSignal): Promise<void> {
    const degraded = (event: string) => (error: unknown) => this.options.diagnostics.log("warn", event, { error: serializeDiagnosticError(error) }, { component: "native" });
    await this.ingest.load().catch(degraded("native.ledger_unreadable"));
    await this.refreshScope();
    if (this.options.harnesses.includes("pi")) {
      const version = await harnessVersion(this.options.executables.pi || "pi");
      if (!atLeast(version, PI_MIN_VERSION)) this.pi.unavailable = `Pi ${formatVersion(version)} predates the Cohub extension (${PI_MIN_VERSION.join(".")}+); upgrade Pi, then restart the Runtime`;
      else await this.pi.listen(signal).catch((error: unknown) => {
        this.pi.unavailable = `Pi control socket unavailable (${serializeDiagnosticError(error).message}); restart the Runtime`;
        degraded("native.pi_socket_unavailable")(error);
      });
      this.extension = await piExtensionState().catch(() => "missing" as const);
    }
    await this.ingest.watch(signal).catch(degraded("native.watch_unavailable"));
    // Connecting early lets a terminal Codex find the server before the first Cohub Turn needs it.
    if (this.codex.enabled) void this.codex.get();
  }

  connect(send: ((event: NativeRuntimeEvent) => Promise<unknown>) | null): void {
    this.send = send;
    this.ingest.connect(send ? nativeWebSocketTransport(send) : null);
  }

  stop(sessionId: string, turnId: string): boolean {
    return this.ingest.stop(sessionId, turnId);
  }

  status(): NativeStatus {
    const ingest = this.ingest.status();
    return {
      synced: this.synced,
      transcripts: ingest.transcripts,
      running: ingest.running,
      pi: this.options.harnesses.includes("pi") ? { extension: this.extension, connected: this.pi.list().length, unavailable: this.pi.unavailable } : null,
      codex: this.options.harnesses.includes("codex") ? { control: this.codex.enabled ? "shared" : "private", watching: this.watched.size } : null,
      import: ingest.import,
    };
  }

  async control(action: string, message: Record<string, unknown>): Promise<unknown> {
    if (action === "reload") return await this.reload();
    if (action !== "import") throw new Error("Unknown Runtime control request");
    if (!this.synced.length) throw new Error("Native sync is not enabled for this directory; run cohub runtime up");
    const filter: ImportFilter = {
      ...(Array.isArray(message.harnesses) && message.harnesses.length ? { harnesses: message.harnesses as Harness[] } : {}),
      ...(typeof message.nativeSessionId === "string" && message.nativeSessionId ? { nativeSessionId: message.nativeSessionId } : {}),
    };
    if (message.command === "pause") return this.ingest.pauseImport();
    if (message.command === "start") return await this.ingest.startImport(filter, typeof message.concurrency === "number" ? message.concurrency : DEFAULT_IMPORT_CONCURRENCY);
    const plan = await this.ingest.plan(filter);
    return {
      files: plan.length,
      bytes: plan.reduce((sum, candidate) => sum + candidate.size, 0),
      // Enough to show what an import would bring in; the full list stays in the Runtime.
      sample: plan.slice(0, 20).map(({ harness, path, nativeSessionId, mtimeMs, size }) => ({ harness, path, nativeSessionId, mtimeMs, size })),
    };
  }

  private async reload(): Promise<NativeStatus> {
    await this.refreshScope();
    this.options.config = await readNativeConfig(this.options.stateRoot, this.options.identity);
    this.ingest.configure(this.synced, this.options.config?.enabledAt ?? new Date().toISOString());
    this.codex.enabled = Boolean(this.options.config?.codexShared) && this.options.harnesses.includes("codex");
    if (this.codex.enabled) void this.codex.get();
    if (this.options.harnesses.includes("pi")) this.extension = await piExtensionState().catch(() => "missing" as const);
    return this.status();
  }

  private async refreshScope(): Promise<void> {
    const { bindings } = await readRuntimeSpaceBindings().catch(() => ({ bindings: [] }));
    this.ingest.exclude(bindings.filter((binding) => binding.key === this.options.identity && binding.spaceId !== this.options.spaceId).map((binding) => binding.root));
  }

  async close(signal: AbortSignal): Promise<void> {
    for (const stream of this.streams.values()) stream.progress.dispose();
    for (const preview of this.filePreviews.values()) { preview.progress.dispose(); if (preview.timer) clearTimeout(preview.timer); }
    await Promise.allSettled([this.pi.close(), this.codex.close(), this.ingest.close(signal)]);
  }

  private sink(harness: Harness, nativeSessionId: string) {
    return (progress: NativeTurnProgress) => {
      const running = this.ingest.running(harness, nativeSessionId);
      if (!running?.sessionId || !running.runningTurnId || !this.send) return null;
      return this.send({ type: "progress", sessionId: running.sessionId, turnId: running.runningTurnId, progress }).catch(() => ({ accepted: false }));
    };
  }

  /**
   * A connected Pi. A user prompt starting and the agent settling are the two moments its file has
   * something to persist; everything between streams as a preview of a Turn someone runs there.
   */
  private onPiEvent(link: PiSessionLink, event: Record<string, unknown>): void {
    const key = `pi:${link.sessionId}`;
    const type = text(event.type);
    const userPrompt = type === "message_end" && record(event.message).role === "user";
    if (userPrompt || type === "agent_settled") { if (link.sessionFile) this.ingest.touch(link.sessionFile); }
    if (type === "agent_start") this.endStream(key);
    // An automatic retry follows `agent_end` within the same Turn; only settling ends it.
    if (type === "agent_settled") { this.endStream(key); return; }
    this.ingest.alive("pi", link.sessionId);
    // A Turn Cohub runs streams through its own execution; this is only a terminal user's Turn.
    if (!this.ingest.running("pi", link.sessionId) && !userPrompt && !this.streams.has(key)) return;
    this.stream(key, "pi", link.sessionId).translator.push(event);
  }

  private stream(key: string, harness: Harness, nativeSessionId: string): Stream {
    let stream = this.streams.get(key);
    if (!stream) {
      const progress = new LiveProgress(this.sink(harness, nativeSessionId), STREAM_INTERVAL_MS);
      const emit = (update: Parameters<LiveProgress["apply"]>[0]) => progress.apply(update);
      stream = { progress, translator: harness === "pi" ? piTranslator(emit) : codexTranslator(emit, { provider: null, model: null }) };
      this.streams.set(key, stream);
    }
    return stream;
  }

  private endStream(key: string): void {
    this.streams.get(key)?.progress.dispose();
    this.streams.delete(key);
  }

  private endFilePreview(path: string): void {
    const preview = this.filePreviews.get(path);
    if (!preview) return;
    preview.progress.dispose();
    if (preview.timer) clearTimeout(preview.timer);
    this.filePreviews.delete(path);
  }

  private observeCodex(channel: CodexChannel): void {
    const offEvent = channel.onEvent((event) => this.onCodexEvent(event));
    const offClose = channel.onClose(() => {
      offEvent(); offClose();
      // Subscriptions die with the connection; the next activity in a rollout reconnects.
      const lost = new Set([...this.watched.keys(), ...this.active]);
      this.watched.clear();
      this.active.clear();
      for (const key of [...this.streams.keys()]) if (key.startsWith("codex:")) this.endStream(key);
      for (const threadId of lost) this.ingest.controlChanged("codex", threadId);
    });
    void channel.request("thread/loaded/list", {}).then((result) => {
      for (const threadId of Array.isArray(result.data) ? result.data : []) if (typeof threadId === "string") void this.watchCodexThread(channel, threadId, false);
    }).catch(() => undefined);
  }

  private async watchCodexThread(channel: CodexChannel, threadId: string, busy: boolean): Promise<void> {
    if (this.watched.has(threadId)) return;
    const read = await channel.request("thread/read", { threadId }).catch(() => null);
    const thread = record(read?.thread);
    if (!busy && record(thread.status).type !== "active") return;
    // Only this project's conversations; sub-agents and ephemeral threads are not chats.
    if (!this.ingest.owns(text(thread.cwd)) || thread.parentThreadId || thread.ephemeral === true) return;
    this.active.add(threadId);
    if (this.codex.driving.has(threadId)) return;
    this.watched.set(threadId, { path: text(thread.path) || null });
    this.ingest.controlChanged("codex", threadId);
    await this.codex.join(threadId).catch((error: unknown) => {
      this.watched.delete(threadId);
      this.options.diagnostics.log("debug", "native.codex_join_failed", { error: serializeDiagnosticError(error) }, { harness: "codex" });
    });
  }

  private onCodexEvent(event: CodexEvent & { id?: string | number }): void {
    // Approvals of other clients' Turns are theirs to answer.
    if (event.id != null) return;
    const threadId = text(event.params.threadId);
    if (!threadId) return;
    if (event.method === "thread/status/changed") {
      if (record(event.params.status).type === "active") void this.codex.get().then((channel) => channel && this.watchCodexThread(channel, threadId, true));
      return;
    }
    const watched = this.watched.get(threadId);
    // A Turn Cohub runs streams through its own execution.
    if (!watched || this.codex.driving.has(threadId)) return;
    this.ingest.alive("codex", threadId);
    const key = `codex:${threadId}`;
    if (event.method === "turn/started") this.endStream(key);
    if (event.method === "turn/completed") {
      this.endStream(key);
      if (watched.path) this.ingest.touch(watched.path);
      return;
    }
    this.stream(key, "codex", threadId).translator.push(event);
  }

  /**
   * A terminal Pi runs many Turns in one process; once the ledger knows which one is running, its
   * tools are told, so a `cohub` call from a tool names the right Space, Session and Turn.
   */
  private onRunning(state: TranscriptState, turnId: string | null): void {
    if (!turnId) this.endFilePreview(state.path);
    if (state.harness !== "pi" || !state.sessionId || !this.pi.find(state.nativeSessionId)) return;
    void this.pi.context(state.nativeSessionId, { COHUB_SPACE_ID: this.options.spaceId, COHUB_SESSION_ID: state.sessionId, COHUB_TURN_ID: turnId }).catch(() => undefined);
  }

  /**
   * A running Turn's file grew. A connected client streams it already; otherwise the preview is
   * read from the file, at a pace set by a timer, not by every write.
   */
  private onGrowth(state: TranscriptState): void {
    this.ingest.alive(state.harness, state.nativeSessionId);
    if (state.harness === "codex" && this.codex.enabled && !this.watched.has(state.nativeSessionId)) void this.codex.get();
    const streamed = state.harness === "pi" ? this.pi.find(state.nativeSessionId) !== null : this.watched.has(state.nativeSessionId);
    if (streamed) return;
    let preview = this.filePreviews.get(state.path);
    if (!preview) {
      preview = { progress: new LiveProgress(this.sink(state.harness, state.nativeSessionId), 0), timer: null, readMs: 0 };
      this.filePreviews.set(state.path, preview);
    }
    const entry = preview;
    // A preview re-reads the file; a long transcript is previewed less often, so it costs a bounded share of time.
    entry.timer ??= setTimeout(() => {
      if (!state.runningTurnId) { this.endFilePreview(state.path); return; }
      const startedAt = performance.now();
      void readTranscript(state.path, state.harness).then((transcript) => {
        if (!state.runningTurnId) { this.endFilePreview(state.path); return; }
        const tail = transcript.turns.at(-1);
        entry.progress.replace((tail?.messages ?? []).map((message) => ({ content: message.content, provider: message.provider ?? null, model: message.model ?? null })));
      }).catch(() => undefined).finally(() => {
        entry.readMs = performance.now() - startedAt;
        // Growth during the read schedules the next one only now: reads never overlap.
        entry.timer = null;
      });
    }, Math.max(FILE_PREVIEW_INTERVAL_MS, FILE_PREVIEW_COST_FACTOR * entry.readMs));
    entry.timer.unref?.();
  }
}
