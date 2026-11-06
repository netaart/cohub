import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { readSessionActiveTurns } from "@cohub/core/sessions";
import type { AgentSessionArchiveJobData } from "@cohub/infra/agent-queue";
import { db } from "./db.js";
import { logger } from "./logger.js";
import { disposeSessionHandle } from "./processor.js";
import { loadRuntimeContext } from "./runtime/context-store.js";
import { SessionManager } from "./runtime/local-session-manager.js";
import { getAgentSessionFilePath, getAgentSpaceSessionsPath } from "./runtime/paths.js";
import { acquireSessionLock } from "./session-lock.js";

type EvictionResult = { evicted: boolean; reason?: "restored" | "unsynced" };

async function isDurablyMirrored(data: AgentSessionArchiveJobData, file: string, sessionsDir: string) {
  if (!(await stat(file).then(() => true, () => false))) return true;
  const manager = await SessionManager.open(file, sessionsDir);
  const marker = manager.getCustomEntries("cohub.context").at(-1)?.data as { revision?: string } | undefined;
  await manager.close();
  const head = await loadRuntimeContext({ spaceId: data.spaceId, sessionId: data.sessionId, headOnly: true });
  return marker?.revision === head.revision;
}

async function sessionRuntimeFiles(sessionsDir: string, sessionId: string) {
  const owned = (dir: string) => readdir(dir).then(
    (names) => names.filter((name) => name.startsWith(`${sessionId}.`)).map((name) => join(dir, name)),
    () => [] as string[],
  );
  const archives = join(sessionsDir, "archives");
  return [
    ...await owned(archives),
    ...await owned(join(archives, "recovery")),
  ];
}

export async function evictArchivedSessionRuntime(data: AgentSessionArchiveJobData): Promise<EvictionResult> {
  const lock = await acquireSessionLock(data.sessionId);
  if (!lock) throw new Error("Session is busy; eviction will retry");
  try {
    const state = (await readSessionActiveTurns(db, [data.sessionId])).get(data.sessionId);
    if (!state?.archivedAt || state.activeTurn) return { evicted: false, reason: "restored" };

    const sessionsDir = getAgentSpaceSessionsPath(data.spaceId);
    const file = getAgentSessionFilePath(data.spaceId, data.sessionId);
    if (!(await isDurablyMirrored(data, file, sessionsDir))) {
      logger.warn("[SessionArchive] kept runtime files that are ahead of durable history", data);
      return { evicted: false, reason: "unsynced" };
    }

    await disposeSessionHandle(data.spaceId, data.sessionId);
    const files = [file, ...await sessionRuntimeFiles(sessionsDir, data.sessionId)];
    await Promise.all(files.map((path) => rm(path, { force: true })));
    logger.info("[SessionArchive] evicted runtime files", { ...data, files: files.length });
    return { evicted: true };
  } finally {
    await lock.release();
  }
}
