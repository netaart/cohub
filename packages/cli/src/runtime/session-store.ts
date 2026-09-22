import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { RUNTIME_RECOVERY_BATCH_SIZE, runtimeEventSchema, serializeProjectionRecords, type RuntimeExecutionEvent, type HarnessArchive, type RuntimePendingExecution, type RuntimeTurnInput } from "@neta-art/cohub";
import { RuntimeArchiveStore, checksumNativeFile, atomicRuntimeJson as atomicJson, type ArchiveTransport } from "./archive-store.js";
import type { CodexTokenTotals } from "./codex-usage.js";
import { importNativeArchive, readCodexArchiveTotals } from "./native-archive.js";
import { serializeDiagnosticError, type RuntimeDiagnosticContext, type RuntimeDiagnostics } from "./diagnostics.js";
import type { SessionTurnProjectionClient } from "./turn-projection.js";
import { ProjectionStore, rebindProjectionNativeSession } from "./projection-store.js";

export class ContextRequiredError extends Error {}

export type RuntimeSessionStoreOptions = {
  stateRoot?: string;
  archiveTransport?: ArchiveTransport;
  projectionSource: SessionTurnProjectionClient;
};

export type NativeSession = {
  version: 1;
  sessionId: string;
  harness: "pi" | "codex";
  nativeSessionId: string;
  path: string;
  cwd?: string;
  throughTurnId: string | null;
  revision: string;
  checksum: string;
  pendingTurnId: string | null;
  resultChecksum?: string;
  archivePendingTurnId?: string;
  codexTokenTotals?: CodexTokenTotals;
  projectionVersion?: 1;
  sourceSequence?: number | null;
  sourceTurnId?: string | null;
  sourceFingerprint?: string | null;
  nativeLeafId?: string | null;
};
/** Reverse lookup for native clients; the existing Runtime state remains authoritative. */
export async function findRuntimeNativeSession(root: string, harness: "pi" | "codex", nativeSessionId: string, path?: string): Promise<NativeSession | null> {
  const directory = join(root, harness);
  const names = await readdir(directory).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; });
  const matches: NativeSession[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const state = JSON.parse(await readFile(join(directory, name), "utf8")) as NativeSession;
    if (state.version === 1 && state.harness === harness && state.nativeSessionId === nativeSessionId) matches.push(state);
  }
  if (path && matches.length) {
    const canonical = await realpath(path);
    const exact: NativeSession[] = [];
    for (const state of matches) {
      const candidate = await realpath(state.path).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
      if (candidate === canonical) exact.push(state);
    }
    if (exact.length === 1) return exact[0] ?? null;
  }
  if (matches.length > 1) throw new Error("Native Session has ambiguous Runtime bindings / 原生会话存在多个 Runtime 关联");
  return matches[0] ?? null;
}

const checksum = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
class CaptureUnavailableError extends Error {}

function piSessionDirectory(cwd: string): string {
  const custom = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (custom) return custom;
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safePath);
}

function codexSessionPath(id: string): string {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "").replaceAll(":", "-");
  const root = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return join(root, "sessions", timestamp.slice(0, 4), timestamp.slice(5, 7), timestamp.slice(8, 10), `rollout-${timestamp}-${id}.jsonl`);
}

/** Local references are hints validated against actual native files, never cloud existence claims. */
export class RuntimeSessionStore {
  readonly root: string;
  readonly archives: RuntimeArchiveStore;
  private archiveFlush: Promise<void> | null = null;
  private diagnostics: RuntimeDiagnostics | null = null;
  private readonly nativeWrites = new Map<string, Promise<void>>();
  private readonly projectionStore: ProjectionStore;
  constructor(spaceId: string, options: RuntimeSessionStoreOptions) {
    this.root = join(options.stateRoot ?? join(homedir(), ".local", "state", "cohub", "runtime"), spaceId);
    this.archives = new RuntimeArchiveStore(join(this.root, "archives"), options.archiveTransport);
    this.projectionStore = new ProjectionStore(options.projectionSource);
  }
  setDiagnostics(diagnostics: RuntimeDiagnostics): void {
    this.diagnostics = diagnostics;
    this.archives.setErrorReporter((error, index) => diagnostics.log("warn", "archive.upload_pending", { error: serializeDiagnosticError(error) }, {
      component: "archive",
      sessionId: index?.sessionId,
      turnId: index?.turnId,
      harness: index?.harness,
    }));
  }
  private statePath(input: Pick<RuntimeTurnInput, "sessionId" | "harness">) { return join(this.root, input.harness, `${input.sessionId}.json`); }
  private nativePath(input: Pick<RuntimeTurnInput, "sessionId" | "harness">, nativeSessionId: string, cwd: string) {
    if (input.harness === "pi") return join(piSessionDirectory(cwd), `${nativeSessionId}.jsonl`);
    return codexSessionPath(nativeSessionId);
  }
  private async withNativeWrite(path: string, write: () => Promise<void>) {
    const previous = this.nativeWrites.get(path) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(write);
    this.nativeWrites.set(path, current);
    try { await current; }
    finally { if (this.nativeWrites.get(path) === current) this.nativeWrites.delete(path); }
  }
  private async syncParentDirectory(path: string) {
    if (process.platform === "win32") return;
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  private async writeNativeFile(path: string, data: string) {
    await this.withNativeWrite(path, async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.projection`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(data, "utf8"); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, path);
        await this.syncParentDirectory(path);
      } finally { await rm(temporary, { force: true }); }
    });
  }
  private async appendNativeFile(path: string, data: string, expectedChecksum?: string | null) {
    if (!data) return;
    await this.withNativeWrite(path, async () => {
      const file = await open(path, "r+", 0o600);
      try {
        const bytes = await file.readFile();
        if (expectedChecksum && checksum(bytes) !== expectedChecksum) throw new Error("Native session changed outside Cohub; original data was preserved");
        const prefix = bytes.length > 0 && bytes.at(-1) !== 10 ? "\n" : "";
        await file.write(`${prefix}${data}`, bytes.length, "utf8");
        await file.sync();
      } finally { await file.close(); }
      await this.syncParentDirectory(path);
    });
  }
  private async lastNativeRecordId(path: string): Promise<string | null> {
    const file = await open(path, "r");
    try {
      let position = (await file.stat()).size;
      let tail = "";
      while (position > 0) {
        const size = Math.min(position, 64 * 1024);
        position -= size;
        const chunk = Buffer.alloc(size);
        await file.read(chunk, 0, size, position);
        tail = chunk.toString("utf8") + tail;
        const candidate = tail.trimEnd();
        const newline = candidate.lastIndexOf("\n");
        if (newline >= 0) {
          const record = JSON.parse(candidate.slice(newline + 1)) as { id?: unknown };
          return typeof record.id === "string" ? record.id : null;
        }
      }
      const record = JSON.parse(tail.trim()) as { id?: unknown };
      return typeof record.id === "string" ? record.id : null;
    } finally { await file.close(); }
  }
  private reportProjectionWarnings(input: RuntimeTurnInput, warnings: Array<{ sourceMessageId: string; sourceTurnId: string; reason: string }>) {
    if (warnings.length === 0) return;
    this.diagnostics?.log("warn", "runtime.projection_loss", { warningCount: warnings.length, warnings: warnings.slice(0, 100), truncated: warnings.length > 100 }, { component: "projection", sessionId: input.sessionId, turnId: input.turnId, harness: input.harness });
  }
  private async syncNativeProjection(input: RuntimeTurnInput, cwd: string, previous: NativeSession | null, signal?: AbortSignal): Promise<{ state: NativeSession; resume: "native" | "handoff" | "new" }> {
    const existing = previous && (previous.checksum.length > 0 || previous.sourceSequence != null || previous.pendingTurnId != null) ? previous : null;
    const projection = await this.projectionStore.project({
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      nativeSessionId: existing?.nativeSessionId ?? randomUUID(),
      cwd,
      provider: input.provider,
      target: input.harness,
      throughTurnId: input.context.throughTurnId,
      cursor: existing ? {
        throughSequence: existing.sourceSequence ?? null,
        throughTurnId: existing.sourceTurnId ?? null,
        sourceFingerprint: existing.sourceFingerprint ?? null,
      } : null,
    }, signal);
    if (existing && projection.append && projection.turns.length === 0) return { state: existing, resume: "native" };
    const replacing = existing !== null && !projection.append;
    const id = replacing || !existing ? randomUUID() : existing.nativeSessionId;
    const path = replacing || !existing ? this.nativePath(input, id, cwd) : existing.path;
    const materialized = replacing ? rebindProjectionNativeSession(projection, id) : projection;
    this.reportProjectionWarnings(input, materialized.projection.warnings);
    const turns = materialized.turns;
    const next: NativeSession = {
      ...(replacing || !existing ? { version: 1, sessionId: input.sessionId, harness: input.harness, nativeSessionId: id, path, cwd, throughTurnId: null, revision: input.context.revision, checksum: "", pendingTurnId: null } : existing),
      projectionVersion: 1,
      nativeSessionId: id,
      path,
      cwd,
      sourceSequence: materialized.cursor.throughSequence,
      sourceTurnId: materialized.cursor.throughTurnId,
      sourceFingerprint: materialized.cursor.sourceFingerprint,
      throughTurnId: input.context.throughTurnId,
      revision: input.context.revision,
    };
    const serialized = serializeProjectionRecords(materialized.projection.records);
    if (input.harness === "codex" && turns.length === 0 && !existing) return { state: next, resume: "new" };
    if (materialized.append && existing) {
      let suffix = serialized;
      let leafId = existing.nativeLeafId ?? null;
      if (input.harness === "pi") {
        leafId = await this.lastNativeRecordId(existing.path);
        if (leafId) {
          let rebound = false;
          const records = materialized.projection.records.map((entry) => {
            if (rebound || !("parentId" in entry.record)) return entry;
            rebound = true;
            return { ...entry, record: { ...entry.record, parentId: leafId } };
          });
          suffix = serializeProjectionRecords(records);
        }
      }
      await this.appendNativeFile(existing.path, suffix, existing.checksum);
      const projectedLeaf = materialized.projection.records.at(-1)?.record.id;
      if (typeof projectedLeaf === "string") leafId = projectedLeaf;
      next.nativeLeafId = leafId;
    } else {
      await this.writeNativeFile(path, serialized);
      const projectedLeaf = materialized.projection.records.at(-1)?.record.id;
      next.nativeLeafId = typeof projectedLeaf === "string" ? projectedLeaf : null;
    }
    next.checksum = await checksumNativeFile(path);
    if (existing) await atomicJson(this.statePath(next), next);
    return { state: next, resume: existing ? "handoff" : (turns.length ? "handoff" : "new") };
  }
  async *pendingExecutionBatches(): AsyncGenerator<RuntimePendingExecution[]> {
    let batch: RuntimePendingExecution[] = [];
    for (const harness of ["pi", "codex"] as const) {
      const directory = join(this.root, harness);
      const names = await readdir(directory).catch((error) => { if (missing(error)) return []; throw error; });
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        try {
          const state = JSON.parse(await readFile(join(directory, name), "utf8")) as NativeSession;
          if (state.version !== 1 || state.harness !== harness || !state.sessionId || !state.pendingTurnId) continue;
          batch.push({ sessionId: state.sessionId, turnId: state.pendingTurnId, harness });
          if (batch.length >= RUNTIME_RECOVERY_BATCH_SIZE) {
            yield batch;
            batch = [];
          }
        } catch (error) {
          this.diagnostics?.log("error", "runtime.session_state_unreadable", { path: join(directory, name), error: serializeDiagnosticError(error) });
        }
      }
    }
    if (batch.length) yield batch;
  }
  async flushArchives(signal: AbortSignal) {
    this.archiveFlush ??= this.flushArchiveOutbox(signal).finally(() => { this.archiveFlush = null; });
    return this.archiveFlush;
  }
  private async flushArchiveOutbox(signal: AbortSignal) {
    const captures = join(this.archives.root, "captures");
    const names = await readdir(captures).catch((error) => { if (missing(error)) return []; throw error; });
    for (const name of names) {
      signal.throwIfAborted();
      if (!name.endsWith(".json")) continue;
      let receipt: string | undefined;
      try {
        receipt = await readFile(join(captures, name), "utf8");
        let state: NativeSession;
        try { state = JSON.parse(receipt) as NativeSession; }
        catch { throw new CaptureUnavailableError("Invalid capture receipt"); }
        const turnId = state?.archivePendingTurnId;
        if (typeof turnId !== "string" || typeof state?.path !== "string" || typeof state.resultChecksum !== "string") {
          throw new CaptureUnavailableError("Invalid capture receipt");
        }
        if (!await this.archives.hasCapture(turnId)) {
          const digest = await checksumNativeFile(state.path).catch((error) => {
            if (missing(error)) throw new CaptureUnavailableError("Native session missing");
            throw error;
          });
          if (digest !== state.resultChecksum) throw new CaptureUnavailableError("Native session changed; original files retained");
          signal.throwIfAborted();
          await this.archives.stage(state, turnId);
        }
        await rm(join(captures, name), { force: true });
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof CaptureUnavailableError && receipt !== undefined) {
          // Preserve the exact receipt before retiring it from the retry queue. Never alter native files.
          await atomicJson(join(this.archives.root, "failed", "captures", `${name}.${checksum(receipt)}.json`), {
            receipt, reason: error.message, failedAt: new Date().toISOString(),
          });
          await rm(join(captures, name), { force: true });
          this.diagnostics?.log("error", "archive.capture_unavailable", { reason: error.message, receipt: true }, { component: "archive" });
        } else {
          this.diagnostics?.log("warn", "archive.capture_pending", { error: serializeDiagnosticError(error) }, { component: "archive" });
        }
      }
    }
    await this.archives.flush(signal);
  }
  async pendingTurnIds(sessionId: string): Promise<string[]> {
    const ids: string[] = [];
    for (const harness of ["pi", "codex"] as const) {
      try {
        const state = JSON.parse(await readFile(this.statePath({ sessionId, harness }), "utf8")) as NativeSession;
        if (state.sessionId !== sessionId || state.harness !== harness) throw new Error("Local session identity mismatch");
        if (state.pendingTurnId) ids.push(state.pendingTurnId);
      } catch (error) { if (!missing(error)) throw error; }
    }
    return ids;
  }
  async prepare(input: RuntimeTurnInput, cwd: string, signal?: AbortSignal): Promise<{ state: NativeSession; resume: "native" | "restored" | "handoff" | "new" }> {
    let previous: NativeSession | null = null;
    try { previous = JSON.parse(await readFile(this.statePath(input), "utf8")) as NativeSession; }
    catch (error) { if (!missing(error)) throw new Error("Local session state is unreadable; original files were preserved", { cause: error }); }
    if (previous) {
      if (previous.sessionId !== input.sessionId || previous.harness !== input.harness) throw new Error("Local session identity mismatch");
      const pending = previous.pendingTurnId;
      if (pending) {
        const resolved = input.context.resolvedTurnIds?.includes(pending) === true;
        const settled = input.context.settledTurnIds?.includes(pending) === true;
        const lostAcknowledgement = Boolean(previous.resultChecksum) && pending === input.context.throughTurnId && pending !== input.turnId;
        // A human-confirmed stop is authoritative: rebuild from durable history instead of
        // resuming a native projection whose outcome the server never recorded.
        const retire = resolved || (settled && !lostAcknowledgement);
        const nativeChecksum = await checksumNativeFile(previous.path).catch((error) => { if (missing(error)) return null; throw error; });
        if (previous.resultChecksum && (settled || resolved) && nativeChecksum && nativeChecksum !== previous.resultChecksum) {
          throw new Error("Native session changed outside Cohub; original data was preserved");
        }
        if (retire) {
          // The server reached a terminal state for this turn. Archive the local projection and
          // rebuild from durable context; native files are never deleted, so nothing is lost.
          const receipt = await readFile(this.resultPath(previous), "utf8").catch((error) => { if (missing(error)) return null; throw error; });
          const retired = { state: previous, receipt };
          await atomicJson(join(this.root, "retired", `${pending}.${checksum(JSON.stringify(retired))}.json`), retired);
          previous = null;
        } else if (lostAcknowledgement) {
          // The server already persisted this turn; only our acknowledgement was lost.
          await this.acknowledge(previous, pending, input.context.revision);
        } else if (input.context.complete === false) {
          throw new ContextRequiredError("Server resolution is required for the pending native execution");
        } else {
          throw new Error(`Local turn ${pending} has unconfirmed results; reconcile it before continuing`);
        }
      }
    }
    if (previous) {
      const previousPath = previous.path;
      const canonical = await realpath(previousPath).catch((error) => { if (missing(error)) return previousPath; throw error; });
      const externallyOwned = await readFile(join(this.root, "native-owners", `${checksum(canonical)}.json`), "utf8").then(() => true).catch((error) => { if (missing(error)) return false; throw error; });
      // Interactive clients own their native files, including symlink aliases. Use an independent projection.
      if (externallyOwned) previous = null;
    }
    if (previous) {
      try {
        const nativeChecksum = await checksumNativeFile(previous.path);
        if (nativeChecksum !== previous.checksum) {
          this.diagnostics?.log("warn", "runtime.projection_rebuilt", { reason: "native file changed outside Cohub" }, { component: "projection", sessionId: input.sessionId, turnId: input.turnId, harness: input.harness });
          return await this.syncNativeProjection(input, cwd, null, signal);
        }
        if (previous.archivePendingTurnId) {
          await this.archives.stage(previous, previous.archivePendingTurnId);
          previous.archivePendingTurnId = undefined;
          await atomicJson(this.statePath(previous), previous);
        }
        if (input.harness === "codex" && !previous.codexTokenTotals) previous.codexTokenTotals = await readCodexArchiveTotals(previous.path);
        return await this.syncNativeProjection(input, cwd, previous?.cwd === cwd ? previous : null, signal);
      } catch (error) { if (!missing(error)) throw error; }
    }
    const id = randomUUID();
    const path = this.nativePath(input, id, cwd);
    const archive = input.context.archive;
    const restore = archive?.harness === input.harness && archive.sessionId === input.sessionId && archive.turnId === input.context.throughTurnId;
    const rawPath = join(this.root, "archives", "restored", `${id}.jsonl`);
    const state: NativeSession = {
      version: 1, harness: input.harness, sessionId: input.sessionId, nativeSessionId: id,
      path, cwd, throughTurnId: input.context.throughTurnId, revision: input.context.revision, checksum: "", pendingTurnId: null,
      projectionVersion: 1, sourceSequence: null, sourceTurnId: null, sourceFingerprint: null,
    };
    if (restore) {
      try {
        const restored = await this.archives.restore(archive, rawPath, signal);
        Object.assign(state, await importNativeArchive({ source: rawPath, target: path, harness: input.harness, nativeSessionId: restored.nativeSessionId, id, cwd, signal }));
        return { state, resume: "restored" };
      } catch (error) {
        signal?.throwIfAborted();
        this.diagnostics?.log("warn", "archive.restore_failed", { error: serializeDiagnosticError(error) }, { component: "archive" });
      }
    }
    return await this.syncNativeProjection(input, cwd, state, signal);
  }
  async started(state: NativeSession, turnId: string) { state.pendingTurnId = turnId; state.resultChecksum = undefined; await atomicJson(this.statePath(state), state); }
  private resultPath(state: Pick<NativeSession, "sessionId" | "harness">) { return join(this.root, "results", `${state.sessionId}.${state.harness}.json`); }
  async recordResult(state: NativeSession, requestId: string, events: RuntimeExecutionEvent[]) {
    if (!state.pendingTurnId) throw new Error("Cannot record a result for an idle native session");
    if (state.harness === "pi") state.nativeLeafId = await this.lastNativeRecordId(state.path);
    state.resultChecksum = await checksumNativeFile(state.path);
    if (state.archivePendingTurnId) await atomicJson(join(this.archives.root, "captures", `${state.archivePendingTurnId}.json`), state);
    await atomicJson(this.resultPath(state), { requestId, state, events });
    await atomicJson(this.statePath(state), state);
  }
  async recoverResult(input: Pick<RuntimeTurnInput, "sessionId" | "harness" | "turnId">, requestId?: string): Promise<{ state: NativeSession; events: RuntimeExecutionEvent[] } | null> {
    try {
      const saved = JSON.parse(await readFile(this.resultPath(input), "utf8")) as { requestId: string; state: NativeSession; events: unknown[] };
      if (saved.state.sessionId !== input.sessionId || saved.state.harness !== input.harness) throw new Error("Runtime result identity mismatch");
      if (saved.state.pendingTurnId !== input.turnId) return null;
      if (requestId && saved.requestId !== requestId) throw new Error("Runtime result execution identity mismatch");
      return { state: saved.state, events: saved.events.map((event) => runtimeEventSchema.parse(event)) };
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  async archive(state: NativeSession, turnId: string, diagnosticContext: RuntimeDiagnosticContext = {}): Promise<HarnessArchive | null> {
    if (!state.path) return null;
    state.archivePendingTurnId = turnId;
    try {
      const reference = await this.archives.stage(state, turnId);
      state.archivePendingTurnId = undefined;
      return reference;
    } catch (error) {
      this.diagnostics?.log("warn", "archive.capture_failed", { error: serializeDiagnosticError(error) }, { ...diagnosticContext, component: "archive", turnId, harness: state.harness });
      throw error;
    }
  }
  async acknowledge(state: NativeSession, turnId: string, revision: string) {
    if (state.pendingTurnId !== turnId) throw new Error("Runtime acknowledgement identity mismatch");
    const currentChecksum = await checksumNativeFile(state.path).catch((error) => { if (missing(error)) return state.resultChecksum ?? state.checksum; throw error; });
    if (state.resultChecksum && currentChecksum !== state.resultChecksum) throw new Error("Native data changed before acknowledgement; files preserved");
    let sourceSequence = state.sourceSequence ?? null;
    let sourceTurnId = state.sourceTurnId ?? null;
    let sourceFingerprint = state.sourceFingerprint ?? null;
    const projectionCursor = await this.projectionStore.cursorForTurn(state.sessionId, turnId);
    sourceSequence = projectionCursor.throughSequence;
    sourceTurnId = projectionCursor.throughTurnId;
    sourceFingerprint = projectionCursor.sourceFingerprint;
    const acknowledged: NativeSession = { ...state, checksum: currentChecksum, pendingTurnId: null, resultChecksum: undefined, throughTurnId: turnId, revision, sourceSequence, sourceTurnId, sourceFingerprint };
    await atomicJson(this.statePath(state), acknowledged);
    Object.assign(state, acknowledged);
  }
}
