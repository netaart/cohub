import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { serializeProjectionRecords, type HarnessArchive, type RuntimeContext } from "@neta-art/cohub";
import { ArchiveNotRestorableError, importNativeArchive } from "./archive.js";
import { piSessionDirectoryName, readTranscript } from "./adapters.js";
import { ProjectionStore, rebindProjectionNativeSession } from "../projection-store.js";
import type { SessionTurnProjectionClient } from "../turn-projection.js";
import type { RuntimeArchiveStore } from "../archive-store.js";
import type { NativeIngest, TranscriptState } from "./ingest.js";

/** How the native file for a Turn was obtained; reported with the Turn result. */
export type ResumeKind = "native" | "restored" | "handoff" | "new";

export type NativeSession = {
  harness: "pi" | "codex";
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
    onRestoreFailed?: (error: unknown, context: { sessionId: string; harness: "pi" | "codex"; unrestorable: boolean }) => void;
  }) {
    this.projections = new ProjectionStore(options.projectionSource);
  }

  async prepare(input: {
    sessionId: string;
    turnId: string;
    harness: "pi" | "codex";
    cwd: string;
    provider?: string | null;
    context: RuntimeContext;
    resumable: (transcript: TranscriptState) => boolean;
    signal?: AbortSignal;
  }): Promise<PreparedSession> {
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

  private async restore(input: { harness: "pi" | "codex"; cwd: string }, archive: HarnessArchive, signal?: AbortSignal): Promise<NativeSession> {
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

  private async project(input: { sessionId: string; turnId: string; harness: "pi" | "codex"; cwd: string; provider?: string | null; context: RuntimeContext; signal?: AbortSignal }): Promise<PreparedSession> {
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
function nativePath(harness: "pi" | "codex", nativeSessionId: string, cwd: string): string {
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
