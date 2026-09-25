import { appendFile, mkdir, open, readFile, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { NATIVE_INGEST_MAX_TURNS, SETTLED_TURN_STATUSES, type NativeIngestResult, type NativeRuntimeEvent, type NativeTurnComplete, type NativeTurnMessage } from "@neta-art/cohub";
import { acceptsDirectory, acceptsTranscript, readSessionHeader, readTranscript, transcriptRoots, type Harness, type NativeTranscriptTurn } from "./adapters.js";
import { nativeTurnId } from "./identity.js";
import type { RuntimeArchiveStore } from "../archive-store.js";
import { ensurePlainCodexRollout } from "./transcript.js";

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** Transcripts read in parallel per lane. The live lane never waits behind a backfill. */
const LIVE_CONCURRENCY = 2;
export const DEFAULT_IMPORT_CONCURRENCY = 4;
export const MAX_IMPORT_CONCURRENCY = 8;
/** A harness writes one Turn as many appends; filesystem events are coalesced for this long. */
const WATCH_DEBOUNCE_MS = 150;
/** A quiet Pi transcript whose last reply ended is settled after this long. */
const PI_QUIET_SETTLE_MS = 10_000;
const SETTLED_STATUSES = new Set<string>(SETTLED_TURN_STATUSES);
/** Pi stop reasons that end a reply; anything else (a tool call) means more is coming. */
const PI_ENDED = ["stop", "length", "error", "aborted"];
/** A running Turn that shows signs of life tells the server at most this often. */
const ALIVE_INTERVAL_MS = 5 * 60_000;
/** A failed read is retried this many times with backoff; afterwards the next write or reconnect retries. */
const RETRY_ATTEMPTS = 10;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 5 * 60_000;
/**
 * Turns per ingest request. The server writes each Turn in its own transactions, so a batch is kept
 * small enough to answer well within the request timeout; the protocol allows more.
 */
const INGEST_BATCH_TURNS = Math.min(50, NATIVE_INGEST_MAX_TURNS);
/**
 * Records that end or begin a Turn. New bytes of a known transcript are only searched for these;
 * the transcript is parsed and sent when one appears.
 */
const BOUNDARIES: Record<Harness, string[]> = {
  codex: ['"UserMessage"', '"user_message"', '"turn_complete"', '"task_complete"', '"turn_aborted"'],
  pi: ['"role":"user"', ...PI_ENDED.map((reason) => `"stopReason":"${reason}"`)],
};
const BOUNDARY_OVERLAP = Math.max(...Object.values(BOUNDARIES).flat().map((token) => token.length));

export type TranscriptState = {
  harness: Harness;
  path: string;
  nativeSessionId: string;
  cwd: string;
  threadKind: "user" | "internal" | "spawned";
  size: number;
  mtimeMs: number;
  ino: number;
  scannedBytes: number;
  throughTurnKey: string | null;
  throughTurnId: string | null;
  sessionId: string | null;
  runningTurnId: string | null;
  runningTurnKey: string | null;
  headTurnId: string | null;
  origin: "cohub" | "native";
  controllable?: boolean;
};

export type ImportFilter = { harnesses?: Harness[]; nativeSessionId?: string };
/** A backfill of conversations that predate sync. Persisted so a restart resumes it. */
export type ImportJob = {
  state: "idle" | "running" | "paused" | "done";
  filter: ImportFilter;
  concurrency: number;
  files: number;
  done: number;
  turns: number;
  bytes: number;
  totalBytes: number;
  startedAt: string | null;
  failed: Array<{ path: string; message: string }>;
};
/** One journal line: the latest state of one transcript, or of the import job. Later lines win. */
type LedgerEntry = { path: string; state: TranscriptState } | { import: ImportJob };
const IMPORT_FAILURES_KEPT = 100;

export type IngestTransport = {
  ingest(event: Extract<NativeRuntimeEvent, { type: "ingest" }>, options?: { signal?: AbortSignal }): Promise<NativeIngestResult>;
  known(turnIds: string[], options?: { signal?: AbortSignal }): Promise<Array<{ turnId: string; sessionId: string; settled: boolean }>>;
  progress(event: Extract<NativeRuntimeEvent, { type: "progress" }>, options?: { signal?: AbortSignal }): Promise<{ accepted?: boolean; resync?: boolean } | unknown>;
  status(sessionId: string, turnId: string, controllable?: boolean, options?: { signal?: AbortSignal }): Promise<{ abortRequested: boolean; status?: string }>;
};

export type IngestHooks = {
  /**
   * Control-plane certainty about a Pi session's file as last written at `mtimeMs`: `true` when the
   * agent settled after that write, `false` while it runs, `null` when the control plane cannot
   * tell.
   */
  piSettled?: (nativeSessionId: string, mtimeMs: number) => boolean | null;
  controllable?: (state: TranscriptState) => boolean;
  abortTurn?: (state: TranscriptState) => void;
  onGrowth?: (state: TranscriptState) => void;
  onRunning?: (state: TranscriptState, turnId: string | null) => void;
  onError?: (error: unknown, context: { path: string; harness: Harness }) => void;
};

/** A transcript on disk that may belong to the bound directory. */
export type NativeCandidate = { harness: Harness; path: string; size: number; mtimeMs: number; ino: number };

/** Headers are read this many at a time; each costs one small read. */
const HEADER_CONCURRENCY = 16;

const within = (root: string, cwd: string) => cwd === root || cwd.startsWith(`${root}/`);

/** Whether a session in `cwd` belongs to the directory bound at `root`. */
export const owns = (root: string, cwd: string, nested: readonly string[] = []) => Boolean(cwd) && within(root, cwd) && !nested.some((inner) => within(inner, cwd));

/** Every transcript of the bound directory and its subdirectories, newest first. */
export async function discoverTranscripts(cwd: string, harnesses: Harness[], options: { headers?: boolean; nested?: readonly string[]; signal?: AbortSignal } = {}): Promise<Array<NativeCandidate & { nativeSessionId?: string }>> {
  const found: Array<NativeCandidate & { nativeSessionId?: string }> = [];
  for (const harness of harnesses) {
    for (const root of transcriptRoots(harness)) {
      const pending = [root];
      while (pending.length) {
        options.signal?.throwIfAborted();
        const directory = pending.pop() as string;
        const entries = await readdir(directory, { withFileTypes: true }).catch((error) => { if (missing(error) || (error as NodeJS.ErrnoException).code === "ENOTDIR") return []; throw error; });
        for (const entry of entries) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) { if (acceptsDirectory(path, root, harness, cwd)) pending.push(path); }
          else if (entry.isFile() && acceptsTranscript(path, harness, cwd)) {
            const info = await stat(path).catch(() => null);
            if (info) found.push({ harness, path, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino });
          }
        }
      }
    }
  }
  found.sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (!options.headers) return found;
  // Only user conversations of this directory remain; Codex's own work threads are not listed.
  const kept: Array<NativeCandidate & { nativeSessionId?: string } | null> = new Array(found.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(HEADER_CONCURRENCY, found.length) }, async () => {
    while (next < found.length) {
      const index = next++;
      const candidate = found[index] as NativeCandidate;
      const header = await readSessionHeader(candidate.path, candidate.harness, options.signal).catch(() => null);
      if (header?.thread === "user" && owns(cwd, header.cwd, options.nested)) kept[index] = { ...candidate, nativeSessionId: header.nativeSessionId };
    }
  }));
  return kept.filter((candidate) => candidate !== null);
}

/** Ingest batches stay well under the Runtime frame limit. */
const BATCH_MAX_BYTES = 8 * 1024 * 1024;

/** Split in order into batches of at most `count` items and the byte budget. */
function* chunks<T>(items: T[], count: number, size: (item: T) => number = () => 0): Generator<T[]> {
  let batch: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const itemBytes = size(item);
    if (batch.length && (batch.length >= count || bytes + itemBytes > BATCH_MAX_BYTES)) { yield batch; batch = []; bytes = 0; }
    batch.push(item);
    bytes += itemBytes;
  }
  if (batch.length) yield batch;
}

type Candidate = { turn: NativeTranscriptTurn; turnId: string; parentTurnId: string | null; settled: boolean };

/**
 * The daemon's data plane. A harness's transcript is both the durable record of a conversation and
 * the local outbox.
 */
export class NativeIngest {
  private readonly states = new Map<string, TranscriptState>();
  private readonly live = new Map<string, boolean>();
  private readonly busy = new Set<string>();
  private readonly reads = new Set<Promise<void>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly failures = new Map<string, number>();
  private readonly aliveAt = new Map<string, number>();
  private readonly runningPaths = new Set<string>();
  private writing: Promise<void> = Promise.resolve();
  private readonly foreign = new Set<string>();
  private importQueue: NativeCandidate[] = [];
  private runningLive = 0;
  private runningImport = 0;
  private job: ImportJob = { state: "idle", filter: {}, concurrency: DEFAULT_IMPORT_CONCURRENCY, files: 0, done: 0, turns: 0, bytes: 0, totalBytes: 0, startedAt: null, failed: [] };
  private stopped = false;
  private readonly dirty = new Set<string>();
  private jobDirty = false;
  private journalLines = 0;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly watchers: Array<{ close(): void }> = [];
  private transport: IngestTransport | null = null;
  private harnesses: Harness[];
  private enabledAt: string;
  private watching: AbortSignal | null = null;
  private nested: string[] = [];

  constructor(private readonly options: {
    spaceId: string;
    cwd: string;
    harnesses: Harness[];
    enabledAt: string;
    root: string;
    archives: RuntimeArchiveStore;
    hooks?: IngestHooks;
  }) {
    this.harnesses = [...options.harnesses];
    this.enabledAt = options.enabledAt;
  }

  owns(cwd: string): boolean {
    return owns(this.options.cwd, cwd, this.nested);
  }

  exclude(nested: string[]): void {
    this.nested = nested.filter((root) => root !== this.options.cwd && within(this.options.cwd, root));
  }

  configure(harnesses: Harness[], enabledAt: string): void {
    const added = harnesses.filter((harness) => !this.harnesses.includes(harness));
    const paused = this.harnesses.filter((harness) => !harnesses.includes(harness));
    this.harnesses = [...harnesses];
    this.enabledAt = enabledAt;
    if (this.watching) for (const harness of added) void this.watchHarness(harness, this.watching);
    // A paused harness's running Turn is no longer followed: the server treats it as one Cohub
    // cannot stop, so a silence it never reports the end of asks the user.
    for (const path of this.runningPaths) {
      const state = this.states.get(path);
      if (state && paused.includes(state.harness)) void this.reportControl(state);
    }
    if (this.transport) void this.scan().catch((error) => this.report(this.options.cwd, error));
  }

  private get ledgerPath() { return join(this.options.root, "native", "ledger.jsonl"); }

  async load(): Promise<void> {
    let text: string;
    try { text = await readFile(this.ledgerPath, "utf8"); }
    catch (error) { if (missing(error)) return; throw error; }
    const lines = text.split("\n").filter(Boolean);
    for (const line of lines) {
      let entry: LedgerEntry;
      // A torn last line from a crash is dropped; the cache is rebuilt from transcripts and server.
      try { entry = JSON.parse(line) as LedgerEntry; } catch { continue; }
      if ("import" in entry) this.job = { ...this.job, ...entry.import };
      else if (entry.path && entry.state) this.states.set(entry.path, entry.state);
    }
    for (const [path, state] of this.states) if (state.runningTurnId) this.runningPaths.add(path);
    this.journalLines = lines.length;
    if (this.overgrown()) await this.compact();
  }

  connect(transport: IngestTransport | null): void {
    this.transport = transport;
    if (!transport) return;
    void this.scan().then(() => this.resync()).catch((error) => this.report(this.options.cwd, error));
  }

  /**
   * Record that Cohub created or chose this transcript for a Session, before any Turn of it runs.
   */
  adopt(session: { harness: Harness; path: string; nativeSessionId: string; cwd: string }, sessionId: string, through?: { turnKey: string | null; turnId: string | null }): void {
    const state = this.states.get(session.path) ?? this.blank(session.path, session.nativeSessionId, session.cwd, session.harness, "user", { size: -1, mtimeMs: 0, ino: 0 });
    Object.assign(state, { sessionId, nativeSessionId: session.nativeSessionId });
    if (through?.turnKey) Object.assign(state, { throughTurnKey: through.turnKey, throughTurnId: through.turnId, headTurnId: through.turnId });
    if (!this.states.has(session.path)) state.origin = "cohub";
    this.states.set(session.path, state);
    this.markDirty(session.path);
  }

  advance(path: string, turnId: string): void {
    const state = this.states.get(path);
    if (!state) return;
    state.headTurnId = turnId;
    this.markDirty(path);
    this.touch(path);
  }

  touch(path: string): void {
    this.live.set(path, true);
    this.drainLive();
  }

  running(harness: Harness, nativeSessionId: string): TranscriptState | null {
    // A paused harness is neither synced nor previewed.
    if (!this.harnesses.includes(harness)) return null;
    for (const path of this.runningPaths) {
      const state = this.states.get(path);
      if (state?.harness === harness && state.nativeSessionId === nativeSessionId) return state;
    }
    return null;
  }

  stop(sessionId: string, turnId: string): boolean {
    for (const path of this.runningPaths) {
      const state = this.states.get(path);
      if (state?.sessionId !== sessionId || state.runningTurnId !== turnId) continue;
      this.options.hooks?.abortTurn?.(state);
      return true;
    }
    return false;
  }

  alive(harness: Harness, nativeSessionId: string): void {
    const state = this.running(harness, nativeSessionId);
    if (!state?.runningTurnId) return;
    const now = Date.now();
    if (now - (this.aliveAt.get(state.runningTurnId) ?? 0) < ALIVE_INTERVAL_MS) return;
    this.aliveAt.set(state.runningTurnId, now);
    void this.reportControl(state, true);
  }

  /**
   * A native client came or went, so whether Cohub can stop this session's running Turn may have
   * changed.
   */
  controlChanged(harness: Harness, nativeSessionId: string): void {
    const state = this.running(harness, nativeSessionId);
    if (!state) return;
    void this.reportControl(state).then((controllable) => { if (controllable === false) this.touch(state.path); });
  }

  status() {
    return {
      transcripts: this.states.size,
      live: this.live.size + this.runningLive,
      running: [...this.states.values()].filter((state) => state.runningTurnId).length,
      import: { ...this.job, queued: this.importQueue.length, running: this.runningImport },
    };
  }

  transcriptFor(sessionId: string, harness: Harness, headTurnId: string | null): TranscriptState | null {
    // A paused harness's files are not read, so a terminal's may hold Turns its head does not show;
    // only a file Cohub created, whose head Cohub itself advances, is continued then.
    const synced = this.harnesses.includes(harness);
    for (const state of this.states.values()) {
      if (state.sessionId === sessionId && state.harness === harness && state.headTurnId === headTurnId && state.threadKind === "user" && (synced || state.origin === "cohub")) return state;
    }
    return null;
  }

  async scan(): Promise<void> {
    const enabledAt = Date.parse(this.enabledAt);
    for (const candidate of await discoverTranscripts(this.options.cwd, this.harnesses)) {
      const state = this.states.get(candidate.path);
      if (state ? !this.unchanged(state, candidate) : candidate.mtimeMs >= enabledAt) this.live.set(candidate.path, this.live.get(candidate.path) ?? false);
    }
    this.drainLive();
    if (this.job.state === "running") await this.startImport(this.job.filter, this.job.concurrency);
  }

  async plan(filter: ImportFilter = {}, signal?: AbortSignal): Promise<Array<NativeCandidate & { nativeSessionId?: string }>> {
    const harnesses = this.harnesses.filter((harness) => !filter.harnesses?.length || filter.harnesses.includes(harness));
    const candidates = await discoverTranscripts(this.options.cwd, harnesses, { headers: true, nested: this.nested, signal });
    // A transcript whose first read failed is still untracked (size -1), so a later import retries it.
    return candidates.filter((candidate) => (this.states.get(candidate.path)?.size ?? -1) < 0 && !this.live.has(candidate.path)
      && (!filter.nativeSessionId || candidate.nativeSessionId === filter.nativeSessionId));
  }

  /**
   * Start or resume a backfill. What was imported is tracked, so resuming simply plans again; the
   * server recognizes any Turn it already has, so an interrupted batch is never duplicated.
   */
  async startImport(filter: ImportFilter = {}, concurrency = DEFAULT_IMPORT_CONCURRENCY): Promise<ImportJob> {
    const queue = await this.plan(filter);
    const resuming = this.job.state === "running" || this.job.state === "paused";
    const same = resuming && JSON.stringify(this.job.filter) === JSON.stringify(filter);
    const base = same ? this.job : { ...this.job, done: 0, turns: 0, bytes: 0, failed: [], startedAt: new Date().toISOString() };
    this.importQueue = queue;
    this.job = {
      ...base,
      state: queue.length || this.runningImport ? "running" : "done",
      filter,
      concurrency: Math.min(MAX_IMPORT_CONCURRENCY, Math.max(1, Math.trunc(concurrency))),
      files: base.done + queue.length,
      totalBytes: base.bytes + queue.reduce((sum, candidate) => sum + candidate.size, 0),
    };
    this.markJobDirty();
    this.drainImport();
    return { ...this.job };
  }

  pauseImport(): ImportJob {
    if (this.job.state === "running") this.job.state = "paused";
    this.importQueue = [];
    this.markJobDirty();
    return { ...this.job };
  }

  async watch(signal: AbortSignal): Promise<void> {
    this.watching = signal;
    for (const harness of this.harnesses) await this.watchHarness(harness, signal);
  }

  private async watchHarness(harness: Harness, signal: AbortSignal): Promise<void> {
    const { watch } = await import("node:fs");
    for (const root of transcriptRoots(harness)) {
      await mkdir(root, { recursive: true, mode: 0o700 }).catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const watcher = watch(root, { recursive: true }, (_event, name) => {
          if (!name) return;
          const path = join(root, name.toString());
          if (this.foreign.has(path) || !acceptsTranscript(path, harness, this.options.cwd)) return;
          if (!this.live.has(path)) this.live.set(path, false);
          timer ??= setTimeout(() => { timer = null; this.drainLive(); }, WATCH_DEBOUNCE_MS);
          timer.unref?.();
        });
        // An overflowed or failed watch cannot say what changed; a scan finds out once.
        watcher.on("error", (error) => { this.report(root, error); void this.scan().catch(() => undefined); });
        signal.addEventListener("abort", () => watcher.close(), { once: true });
        this.watchers.push(watcher);
      } catch (error) {
        // Without a watch, transcripts sync when the Runtime (re)connects or the control plane reports.
        this.options.hooks?.onError?.(error, { path: root, harness });
      }
    }
  }

  private async resync(): Promise<void> {
    for (const path of [...this.runningPaths]) {
      const state = this.states.get(path);
      if (state) await this.reportControl(state, true);
    }
  }

  private async reportControl(state: TranscriptState, always = false): Promise<boolean | undefined> {
    const transport = this.transport;
    const { sessionId, runningTurnId } = state;
    if (!transport || !sessionId || !runningTurnId) return undefined;
    const controllable = this.harnesses.includes(state.harness) ? this.options.hooks?.controllable?.(state) : false;
    if (!always && controllable === state.controllable) return undefined;
    state.controllable = controllable;
    this.markDirty(state.path);
    const result = await transport.status(sessionId, runningTurnId, controllable).catch(() => {
      // Reported again on the next change or reconnect.
      state.controllable = undefined;
      return null;
    });
    // The server settled it (a confirmed stop): nothing is left to follow until the file changes.
    if (result?.status && SETTLED_STATUSES.has(result.status)) { if (state.runningTurnId === runningTurnId) this.endRunning(state); }
    else if (result?.abortRequested) this.options.hooks?.abortTurn?.(state);
    return controllable;
  }

  async close(signal: AbortSignal): Promise<void> {
    this.stopped = true;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const watcher of this.watchers) watcher.close();
    this.watchers.length = 0;
    await Promise.allSettled(this.reads);
    await this.write();
    await this.options.archives.flush(signal).catch(() => undefined);
  }

  private unchanged(state: TranscriptState, info: { size: number; mtimeMs: number; ino: number }): boolean {
    return state.size === info.size && state.mtimeMs === info.mtimeMs && state.ino === info.ino;
  }

  private drainLive(): void {
    while (!this.stopped && this.transport && this.runningLive < LIVE_CONCURRENCY && this.live.size) {
      const [path, force] = this.live.entries().next().value as [string, boolean];
      this.live.delete(path);
      this.runningLive += 1;
      void this.sync(path, "live", force).then(() => { this.failures.delete(path); }, (error) => this.retryLater(path, error))
        .finally(() => { this.runningLive -= 1; this.drainLive(); });
    }
  }

  private retryLater(path: string, error: unknown): void {
    this.report(path, error);
    if (this.stopped || !this.transport) return;
    const attempts = (this.failures.get(path) ?? 0) + 1;
    if (attempts > RETRY_ATTEMPTS) { this.failures.delete(path); return; }
    this.failures.set(path, attempts);
    this.recheck(path, Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1)));
  }

  private drainImport(): void {
    while (!this.stopped && this.transport && this.job.state === "running" && this.runningImport < this.job.concurrency && this.importQueue.length) {
      const candidate = this.importQueue.shift() as NativeCandidate;
      this.runningImport += 1;
      // A failed conversation is retried by the next `runtime import`.
      void this.sync(candidate.path, "import", true).catch((error) => {
        this.report(candidate.path, error);
        if (this.job.failed.length < IMPORT_FAILURES_KEPT) this.job.failed.push({ path: candidate.path, message: error instanceof Error ? error.message : String(error) });
      }).finally(() => {
        this.runningImport -= 1;
        this.job.done += 1;
        this.job.bytes += candidate.size;
        if (this.job.state === "running" && !this.importQueue.length && !this.runningImport) this.job.state = "done";
        this.markJobDirty();
        this.drainImport();
      });
    }
  }

  private report(path: string, error: unknown): void {
    this.options.hooks?.onError?.(error, { path, harness: this.states.get(path)?.harness ?? this.harnesses[0] as Harness });
  }

  private async sync(path: string, lane: "live" | "import", force: boolean): Promise<void> {
    // One reader per transcript: a conversation reopened during a backfill is read by one lane.
    if (this.busy.has(path)) {
      if (lane === "live") setTimeout(() => { this.live.set(path, force || (this.live.get(path) ?? false)); this.drainLive(); }, WATCH_DEBOUNCE_MS).unref?.();
      return;
    }
    this.busy.add(path);
    const read = this.read(path, lane, force);
    this.reads.add(read);
    try { await read; }
    finally { this.busy.delete(path); this.reads.delete(read); }
  }

  private async read(path: string, lane: "live" | "import", force: boolean): Promise<void> {
    if (this.foreign.has(path)) return;
    const info = await stat(path).catch((error) => { if (missing(error)) return null; throw error; });
    if (!info?.isFile()) return;
    const previous = this.states.get(path);
    // Unchanged bytes can still hold a Turn whose end the control plane has only now reported.
    if (previous && this.unchanged(previous, info) && !(force && previous.runningTurnId)) return;
    const harness = previous?.harness ?? this.harnessFor(path);
    // A paused harness uploads nothing, not even for transcripts it already tracks.
    if (!harness || !this.harnesses.includes(harness)) return;
    if (previous && (previous.threadKind !== "user" || !this.owns(previous.cwd))) return;
    if (!previous) {
      // A header is read once per file: it names the project and the thread's purpose.
      const header = await readSessionHeader(path, harness);
      if (!header) return;
      if (!this.owns(header.cwd)) { this.foreign.add(path); return; }
      if (header.thread !== "user") {
        // Codex's own reviews, compaction runs and spawned agents are not chats; remember and skip them.
        this.states.set(path, this.blank(path, header.nativeSessionId, header.cwd, harness, header.thread, info));
        this.markDirty(path);
        return;
      }
    }
    if (previous && !force && previous.ino === info.ino && previous.size >= 0 && info.size >= previous.scannedBytes) {
      // Nothing new since the last search (a repeated event), or new bytes without a boundary.
      if (info.size === previous.scannedBytes) return;
      if (!await this.crossesBoundary(path, harness, previous.scannedBytes, info.size)) {
        previous.scannedBytes = info.size;
        if (previous.runningTurnId) this.options.hooks?.onGrowth?.(previous);
        return;
      }
    }
    const transcript = await readTranscript(path, harness);
    const state = previous ?? this.blank(path, transcript.nativeSessionId, transcript.cwd, harness, "user", { size: -1, mtimeMs: 0, ino: 0 });
    this.states.set(path, state);
    // The file counts as read only once the server confirmed it; a failed send is retried.
    await this.apply(state, transcript.turns, lane, info.mtimeMs);
    Object.assign(state, { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, scannedBytes: info.size });
    this.markDirty(path);
  }

  private async crossesBoundary(path: string, harness: Harness, from: number, to: number): Promise<boolean> {
    const file = await open(path, "r");
    try {
      const chunk = Buffer.alloc(Math.min(to - from + BOUNDARY_OVERLAP, 1024 * 1024));
      for (let position = from; position < to;) {
        const start = Math.max(0, position - BOUNDARY_OVERLAP);
        const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, to - start), start);
        if (bytesRead <= position - start) break;
        const bytes = chunk.subarray(0, bytesRead);
        // A token that ends inside the bytes already searched was seen before; it does not count again.
        const fresh = position - start;
        for (const token of BOUNDARIES[harness]) {
          for (let index = bytes.indexOf(token); index >= 0; index = bytes.indexOf(token, index + 1)) if (index + token.length > fresh) return true;
        }
        position = start + bytesRead;
      }
      return false;
    } finally { await file.close(); }
  }

  private blank(path: string, nativeSessionId: string, cwd: string, harness: Harness, threadKind: TranscriptState["threadKind"], info: { size: number; mtimeMs: number; ino: number }): TranscriptState {
    return { harness, path, nativeSessionId, cwd, threadKind, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, scannedBytes: Math.max(0, info.size), throughTurnKey: null, throughTurnId: null, headTurnId: null, sessionId: null, runningTurnId: null, runningTurnKey: null, origin: "native" };
  }

  private harnessFor(path: string): Harness | null {
    for (const harness of this.harnesses) {
      if (transcriptRoots(harness).some((root) => path.startsWith(`${root}/`)) && acceptsTranscript(path, harness, this.options.cwd)) return harness;
    }
    return null;
  }

  private tailSettled(state: TranscriptState, tail: NativeTranscriptTurn, mtimeMs: number): boolean {
    if (state.harness === "codex") return tail.result !== null;
    const certain = this.options.hooks?.piSettled?.(state.nativeSessionId, mtimeMs);
    if (certain != null) return certain;
    if (!PI_ENDED.includes(tail.messages.at(-1)?.stopReason ?? "")) return false;
    const idleMs = Date.now() - mtimeMs;
    if (idleMs >= PI_QUIET_SETTLE_MS) return true;
    this.recheck(state.path, PI_QUIET_SETTLE_MS - idleMs);
    return false;
  }

  private recheck(path: string, delayMs: number): void {
    clearTimeout(this.timers.get(path));
    const timer = setTimeout(() => { this.timers.delete(path); this.touch(path); }, Math.max(0, delayMs) + 50);
    timer.unref?.();
    this.timers.set(path, timer);
  }

  private async known(transport: IngestTransport, turnIds: string[]): Promise<Map<string, { sessionId: string; settled: boolean }>> {
    const known = new Map<string, { sessionId: string; settled: boolean }>();
    for (const chunk of chunks([...new Set(turnIds)], NATIVE_INGEST_MAX_TURNS)) {
      for (const entry of await transport.known(chunk)) known.set(entry.turnId, entry);
    }
    return known;
  }

  private async apply(state: TranscriptState, turns: NativeTranscriptTurn[], lane: "live" | "import", mtimeMs: number): Promise<void> {
    const transport = this.transport;
    if (!transport) throw new Error("Runtime is offline");
    const derived = (turn: NativeTranscriptTurn) => nativeTurnId(this.options.spaceId, state.harness, state.nativeSessionId, turn.key);
    const from = state.throughTurnKey ? turns.findIndex((turn) => turn.key === state.throughTurnKey) + 1 : 0;
    const pending = turns.slice(from);
    // One question to the server replaces every local receipt: which of these do you have?
    const known = pending.length ? await this.known(transport, pending.flatMap((turn) => turn.cloudTurnId ? [turn.cloudTurnId, derived(turn)] : [derived(turn)])) : new Map();
    const cohub = (turn: NativeTranscriptTurn) => turn.cloudTurnId && known.has(turn.cloudTurnId) ? turn.cloudTurnId : null;
    const tail = turns.at(-1);
    const head = !tail ? null : pending.length ? cohub(tail) ?? derived(tail) : state.throughTurnId;
    const candidates: Candidate[] = [];
    let parentTurnId = from > 0 ? state.throughTurnId : null;
    for (const [offset, turn] of pending.entries()) {
      const marked = cohub(turn);
      if (marked) {
        // Cohub started this Turn, so the server already has it; the marker exists only so the
        // native conversation can be resumed.
        parentTurnId = marked;
        if (!candidates.length) { state.throughTurnKey = turn.key; state.throughTurnId = marked; }
        continue;
      }
      const settled = offset < pending.length - 1 || this.tailSettled(state, turn, mtimeMs);
      // History that never ended is left to the live lane; its transcript reports it again.
      if (!settled && lane === "import") break;
      // A prompt still being recorded would change the Turn's identity; it is sent once complete.
      if (!settled && state.harness === "codex" && !turn.userFinal) break;
      const turnId = derived(turn);
      candidates.push({ turn, turnId, parentTurnId, settled });
      parentTurnId = turnId;
    }
    if (!candidates.length) { state.headTurnId = head; return; }
    let prefix = 0;
    for (const item of candidates) {
      const recorded = known.get(item.turnId);
      if (!recorded?.settled) break;
      // The server settled it meanwhile (a confirmed stop, or an earlier send that was not answered).
      if (state.runningTurnId === item.turnId) this.endRunning(state);
      state.sessionId = recorded.sessionId;
      state.throughTurnKey = item.turn.key;
      state.throughTurnId = item.turnId;
      prefix += 1;
    }
    // A running Turn is registered once; until it ends, only the realtime path speaks of it.
    const todo = candidates.slice(prefix).filter((item) => {
      const recorded = known.get(item.turnId);
      if (!item.settled && recorded) { this.markRunning(state, recorded.sessionId, item); return false; }
      return !recorded?.settled;
    });
    let lastSettled: Candidate | null = null;
    const controllable = this.options.hooks?.controllable?.(state);
    const payloads = todo.map((item) => ({
      item,
      turn: {
        turnId: item.turnId,
        parentTurnId: item.parentTurnId,
        userContent: item.turn.userContent,
        startedAt: item.turn.startedAt,
        ...(this.imported(item.turn) ? { origin: "local_import" as const } : {}),
        ...(!item.settled && controllable !== undefined ? { controllable } : {}),
        result: item.settled ? this.complete(item.turn.result ?? this.cutOff(item, pending)) : null,
      },
    }));
    for (const batch of chunks(payloads, INGEST_BATCH_TURNS, (payload) => JSON.stringify(payload.turn).length)) {
      const result = await transport.ingest({
        type: "ingest",
        input: { harness: state.harness, nativeSessionId: state.nativeSessionId, turns: batch.map((payload) => payload.turn) },
      });
      const outcomes = new Map(result.turns.map((entry) => [entry.turnId, entry]));
      for (const { item } of batch) {
        const entry = outcomes.get(item.turnId);
        // A Turn the server did not take stops the file here; the next read retries from it.
        if (!entry) throw new Error("Server did not record a native Turn");
        state.sessionId = entry.sessionId;
        if (!entry.settled) { state.controllable = controllable; this.markRunning(state, entry.sessionId, item); continue; }
        if (state.runningTurnId === entry.turnId) this.endRunning(state);
        state.throughTurnKey = item.turn.key;
        state.throughTurnId = entry.turnId;
        lastSettled = item;
        if (lane === "import") this.job.turns += 1;
      }
      this.markDirty(state.path);
    }
    // Only the newest settled state needs raw bytes: every older version is a prefix of it.
    state.headTurnId = head;
    if (lastSettled) await this.archive(state, lastSettled.turn, lastSettled.turnId);
  }

  private markRunning(state: TranscriptState, sessionId: string, item: Candidate): void {
    const changed = state.runningTurnId !== item.turnId;
    state.sessionId = sessionId;
    state.runningTurnId = item.turnId;
    state.runningTurnKey = item.turn.key;
    this.runningPaths.add(state.path);
    if (!changed) return;
    this.options.hooks?.onRunning?.(state, item.turnId);
    // Ask once: a stop may have reached the server before this Runtime knew the Turn.
    this.aliveAt.set(item.turnId, Date.now());
    void this.reportControl(state, true);
  }

  private endRunning(state: TranscriptState): void {
    if (state.runningTurnId) this.aliveAt.delete(state.runningTurnId);
    state.runningTurnId = null;
    state.runningTurnKey = null;
    state.controllable = undefined;
    this.runningPaths.delete(state.path);
    this.options.hooks?.onRunning?.(state, null);
  }

  private cutOff(item: Candidate, pending: NativeTranscriptTurn[]): NonNullable<NativeTranscriptTurn["result"]> {
    const next = pending[pending.indexOf(item.turn) + 1];
    return { messages: item.turn.messages, status: "interrupted", completedAt: next?.startedAt ?? item.turn.startedAt };
  }

  private imported(turn: NativeTranscriptTurn): boolean {
    return Date.parse(turn.startedAt) < Date.parse(this.enabledAt);
  }

  private async archive(state: TranscriptState, turn: NativeTranscriptTurn, turnId: string): Promise<void> {
    if (!state.sessionId) return;
    try {
      const source = turn.path ?? state.path;
      await this.options.archives.stage({
        sessionId: state.sessionId,
        harness: state.harness,
        nativeSessionId: state.nativeSessionId,
        path: state.harness === "codex" ? await ensurePlainCodexRollout(source, join(this.options.root, "native", "rollouts")) : source,
        sizeBytes: turn.endBytes,
        expectedChecksum: turn.sha256,
      }, turnId);
    } catch (error) {
      // Capture never blocks the ledger: a later pass retries, and a rewritten file starts a new
      // archive baseline instead of failing the sync.
      this.options.hooks?.onError?.(error, { path: state.path, harness: state.harness });
    }
  }

  private message(message: NativeTranscriptTurn["messages"][number]): NativeTurnMessage {
    return {
      content: message.content,
      provider: message.provider ?? null,
      model: message.model ?? null,
      usage: (message.usage ?? null) as NativeTurnMessage["usage"],
      stopReason: message.stopReason ?? null,
      errorMessage: message.errorMessage ?? null,
    };
  }

  private complete(result: NonNullable<NativeTranscriptTurn["result"]>): NativeTurnComplete {
    return { messages: result.messages.map((message) => this.message(message)), status: result.status, completedAt: result.completedAt };
  }

  private markDirty(path: string): void {
    this.dirty.add(path);
    this.scheduleWrite();
  }

  private markJobDirty(): void {
    this.jobDirty = true;
    this.scheduleWrite();
  }

  private scheduleWrite(): void {
    if (this.stopped) return;
    this.writeTimer ??= setTimeout(() => { this.writeTimer = null; void this.write().catch((error) => this.report(this.ledgerPath, error)); }, 500);
    this.writeTimer.unref?.();
  }

  private write(): Promise<void> {
    this.writing = this.writing.then(() => this.append(), () => this.append());
    return this.writing;
  }

  private async append(): Promise<void> {
    const entries: LedgerEntry[] = [];
    for (const path of this.dirty) { const state = this.states.get(path); if (state) entries.push({ path, state }); }
    if (this.jobDirty) entries.push({ import: this.job });
    this.dirty.clear();
    this.jobDirty = false;
    if (!entries.length) return;
    await mkdir(join(this.options.root, "native"), { recursive: true, mode: 0o700 });
    await appendFile(this.ledgerPath, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), { mode: 0o600 });
    this.journalLines += entries.length;
    // A long-running Runtime keeps the journal near its content, not just a fresh one.
    if (this.overgrown()) await this.compact();
  }

  private overgrown(): boolean {
    return this.journalLines > 2 * this.states.size + 256;
  }

  private async compact(): Promise<void> {
    const entries: LedgerEntry[] = [...this.states].map(([path, state]) => ({ path, state }));
    entries.push({ import: this.job });
    const temporary = `${this.ledgerPath}.${process.pid}.tmp`;
    const file = await open(temporary, "w", 0o600);
    try { await file.writeFile(entries.map((entry) => `${JSON.stringify(entry)}\n`).join("")); await file.sync(); } finally { await file.close(); }
    await rename(temporary, this.ledgerPath);
    this.journalLines = entries.length;
  }
}
