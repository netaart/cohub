import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { serializeProjectionRecords, type HarnessArchive, type RuntimeContext } from "@neta-art/cohub";
import { ArchiveNotRestorableError, importNativeArchive } from "./archive.js";
import { piSessionDirectoryName, readTranscript } from "./adapters.js";
import { ProjectionStore, rebindProjectionNativeSession } from "../projection-store.js";
import type { SessionTurnProjectionClient } from "../turn-projection.js";
import type { RuntimeArchiveStore } from "../archive-store.js";
import type { NativeIngest, TranscriptState } from "./ingest.js";
import { parseWorkBuddyOrigin, workbuddyHomeDirectory, workbuddySessionPath } from "./workbuddy-transcript.js";
import { assertWorkBuddySessionAvailable } from "./workbuddy-ownership.js";
import { nativeTurnId } from "./identity.js";

/** How the native file for a Turn was obtained; reported with the Turn result. */
export type ResumeKind = "native" | "restored" | "handoff" | "new";

export type NativeSession = {
  harness: "pi" | "codex" | "workbuddy";
  nativeSessionId: string;
  path: string;
  cwd: string;
};

export type PreparedSession = { session: NativeSession; resume: ResumeKind };

/** Chooses the native file a Turn runs in. 1. */
export class NativeSessions {
  private readonly projections: ProjectionStore;

  constructor(private readonly options: {
    root: string;
    spaceId: string;
    projectionSource: SessionTurnProjectionClient;
    archives: RuntimeArchiveStore;
    ingest: NativeIngest;
    onRestoreFailed?: (error: unknown, context: { sessionId: string; harness: "pi" | "codex" | "workbuddy"; unrestorable: boolean }) => void;
  }) {
    this.projections = new ProjectionStore(options.projectionSource);
  }

  async prepare(input: {
    sessionId: string;
    turnId: string;
    harness: "pi" | "codex" | "workbuddy";
    cwd: string;
    provider?: string | null;
    context: RuntimeContext;
    resumable: (transcript: TranscriptState) => boolean;
    signal?: AbortSignal;
  }): Promise<PreparedSession> {
    if (input.harness === "workbuddy") return this.prepareWorkBuddy(input);
    const existing = this.options.ingest.transcriptFor(input.sessionId, input.harness, input.context.throughTurnId);
    if (existing && input.resumable(existing)) {
      return { session: { harness: existing.harness, nativeSessionId: existing.nativeSessionId, path: existing.path, cwd: existing.cwd }, resume: "native" };
    }
    const archive = input.context.archive;
    if (archive && archive.harness === input.harness && archive.sessionId === input.sessionId && archive.turnId === input.context.throughTurnId) {
      const restored = await this.restore(input, archive, input.signal).catch((error: unknown) => {
        input.signal?.throwIfAborted();
        // A structurally unrestorable archive falls back to projection; so does a transient
        // failure, which simply tries the archive again on the next Turn.
        this.options.onRestoreFailed?.(error, { sessionId: input.sessionId, harness: input.harness, unrestorable: error instanceof ArchiveNotRestorableError });
        return null;
      });
      if (restored) {
        // A restored copy is history the server already has, even where it carries no markers.
        const through = (await readTranscript(restored.path, restored.harness).catch(() => null))?.turns.at(-1)?.key ?? null;
        this.options.ingest.adopt(restored, input.sessionId, { turnKey: through, turnId: input.context.throughTurnId });
        return { session: restored, resume: "restored" };
      }
    }
    const projected = await this.project(input);
    // A new Codex thread gets its file when it starts; the executor adopts it then.
    if (projected.resume !== "new" || input.harness === "pi") this.options.ingest.adopt(projected.session, input.sessionId);
    return projected;
  }

  /** Every Cohub turn gets a private native identity; a user's transcript is only read. */
  private async prepareWorkBuddy(input: Parameters<NativeSessions["prepare"]>[0]): Promise<PreparedSession> {
    input.signal?.throwIfAborted();
    const nativeSessionId = randomUUID(), home = workbuddyHomeDirectory();
    const path = workbuddySessionPath(home, input.cwd, nativeSessionId);
    const session: NativeSession = { harness: "workbuddy", nativeSessionId, path, cwd: input.cwd };
    const existing = this.options.ingest.transcriptFor(input.sessionId, "workbuddy", input.context.throughTurnId);
    const archive = input.context.archive;
    let resume: ResumeKind;
    let prefix: Buffer;
    if (existing && input.resumable(existing)) {
      await assertWorkBuddySessionAvailable(existing.nativeSessionId, { home, signal: input.signal });
      const before = await stat(existing.path, { bigint: true });
      if (!before.isFile()) throw new Error("WorkBuddy source transcript is not a file");
      // The watcher may not have observed a closed desktop session's latest writes yet.
      // Verify the actual tail before hiding copied history behind the execution prefix.
      const source = await readTranscript(existing.path, "workbuddy", input.signal);
      const tail = source.turns.at(-1);
      const matchesHead = tail && input.context.throughTurnId !== null && (
        tail.cloudTurnId === input.context.throughTurnId ||
        nativeTurnId(this.options.spaceId, "workbuddy", existing.nativeSessionId, tail.key) === input.context.throughTurnId
      );
      if (source.nativeSessionId !== existing.nativeSessionId || source.cwd !== existing.cwd || !matchesHead) throw new Error("WorkBuddy source history does not match the Session head; wait for native synchronization before continuing");
      await importNativeArchive({ source: existing.path, target: path, harness: "workbuddy", nativeSessionId: existing.nativeSessionId, id: nativeSessionId, cwd: input.cwd, signal: input.signal });
      const after = await stat(existing.path, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("WorkBuddy source changed while copying; close the session before continuing");
      prefix = await readFile(path, { signal: input.signal });
      resume = "native";
    } else if (archive?.harness === "workbuddy") {
      if (archive.sessionId !== input.sessionId || archive.turnId !== input.context.throughTurnId) throw new Error("WorkBuddy archive does not match the Session head");
      const raw = join(this.options.root, "native", "restored", `${nativeSessionId}.jsonl`);
      const restored = await this.options.archives.restore(archive, raw, input.signal);
      await importNativeArchive({ source: raw, target: path, harness: "workbuddy", nativeSessionId: restored.nativeSessionId, id: nativeSessionId, cwd: input.cwd, signal: input.signal });
      prefix = await readFile(path, { signal: input.signal });
      // Failed restore/import leaves its original evidence in place.
      await rm(raw);
      resume = "restored";
    } else {
      const result = await this.projections.project({ spaceId: this.options.spaceId, sessionId: input.sessionId, turnId: input.turnId, nativeSessionId, cwd: input.cwd, provider: input.provider, target: "workbuddy", throughTurnId: input.context.throughTurnId }, input.signal);
      if (result.projection.warnings.length) throw new Error(`WorkBuddy history projection is incomplete: ${result.projection.warnings.map((warning) => warning.reason).join("; ")}`);
      prefix = Buffer.from(serializeProjectionRecords(result.projection.records));
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      if (prefix.length) await writeFile(path, prefix, { flag: "wx", mode: 0o600, signal: input.signal });
      else {
        // --session-id must create an empty session itself; only reserve its Cohub marker.
        try { await lstat(path); throw new Error("WorkBuddy target transcript already exists"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      resume = prefix.length ? "handoff" : "new";
    }
    input.signal?.throwIfAborted();
    const origin = parseWorkBuddyOrigin({ nativeSessionId, cloudSessionId: input.sessionId, turnId: input.turnId, prefixBytes: prefix.length, prefixSha256: createHash("sha256").update(prefix).digest("hex") });
    await writeFile(`${path}.cohub.json`, `${JSON.stringify(origin)}\n`, { flag: "wx", mode: 0o600, signal: input.signal });
    // The parser excludes the verified prefix; no old native turn key exists in this stream.
    this.options.ingest.adopt(session, input.sessionId);
    return { session, resume };
  }

  private async restore(input: { harness: "pi" | "codex" | "workbuddy"; cwd: string }, archive: HarnessArchive, signal?: AbortSignal): Promise<NativeSession> {
    const id = randomUUID();
    const raw = join(this.options.root, "native", "restored", `${id}.jsonl`);
    const path = nativePath(input.harness, id, input.cwd);
    try {
      const restored = await this.options.archives.restore(archive, raw, signal);
      const imported = await importNativeArchive({ source: raw, target: path, harness: input.harness, nativeSessionId: restored.nativeSessionId, id, cwd: input.cwd, signal });
      return { harness: input.harness, nativeSessionId: imported.nativeSessionId, path, cwd: input.cwd };
    } finally {
      await rm(raw, { force: true }).catch(() => undefined);
    }
  }

  private async project(input: { sessionId: string; turnId: string; harness: "pi" | "codex" | "workbuddy"; cwd: string; provider?: string | null; context: RuntimeContext; signal?: AbortSignal }): Promise<PreparedSession> {
    const nativeSessionId = randomUUID();
    const path = nativePath(input.harness, nativeSessionId, input.cwd);
    const projection = rebindProjectionNativeSession(await this.projections.project({
      spaceId: this.options.spaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      nativeSessionId,
      cwd: input.cwd,
      provider: input.provider,
      target: input.harness,
      throughTurnId: input.context.throughTurnId,
    }, input.signal), nativeSessionId);
    const session = { harness: input.harness, nativeSessionId, path, cwd: input.cwd };
    // An empty Codex thread is created by Codex itself when the Turn starts.
    if (!projection.turns.length && input.harness === "codex") return { session, resume: "new" };
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.projection`;
    await writeFile(temporary, serializeProjectionRecords(projection.projection.records), { mode: 0o600 });
    await rename(temporary, path);
    return { session, resume: projection.turns.length ? "handoff" : "new" };
  }
}

/** Where a harness keeps a new transcript for the bound directory. */
function nativePath(harness: "pi" | "codex" | "workbuddy", nativeSessionId: string, cwd: string): string {
  if (harness === "workbuddy") return workbuddySessionPath(workbuddyHomeDirectory(), cwd, nativeSessionId);
  const stamp = new Date().toISOString();
  if (harness === "pi") {
    const agent = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
    const directory = process.env.PI_CODING_AGENT_SESSION_DIR?.trim() || join(agent, "sessions", piSessionDirectoryName(cwd));
    return join(directory, `${stamp.replace(/[:.]/g, "-")}_${nativeSessionId}.jsonl`);
  }
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const day = stamp.replace(/\.\d{3}Z$/, "").replaceAll(":", "-");
  return join(home, "sessions", day.slice(0, 4), day.slice(5, 7), day.slice(8, 10), `rollout-${day}-${nativeSessionId}.jsonl`);
}
