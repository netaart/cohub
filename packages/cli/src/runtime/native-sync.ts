import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient } from "../client.js";
import { currentIdentityKey } from "../space.js";
import { canonicalRuntimeRoot, getRuntimeSpaceBinding } from "./space-binding.js";
import { readNativeTranscript, readNativeTranscriptHeader } from "./native-transcript.js";
import { findRuntimeNativeSession } from "./session-store.js";
import { listNativeSyncStores, nativeIdentityHash, NativeSyncStore, type NativeSyncTransport } from "./native-sync-store.js";
import type { NativeRuntimeEvent } from "@neta-art/cohub";

export type NativeSyncConfig = { version: 1; identity: string; spaceId: string; root: string; harnesses: ("pi" | "codex")[] };
export const nativeRuntimeRoot = (spaceId: string) => join(homedir(), ".local", "state", "cohub", "runtime", spaceId);
export const nativeSyncConfigPath = (runtimeRoot: string, identity: string) => join(runtimeRoot, "native", nativeIdentityHash(identity), "config.json");

const piSessionDirectory = (cwd: string) => {
  const custom = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (custom) return custom;
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const safePath = `--${cwd.replace(/^[/\\\\]/, "").replace(/[/\\\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safePath);
};
const codexSessionDirectory = () => join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "sessions");
type ImportScanError = { harness: "pi" | "codex"; path: string; message: string };
const LARGE_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

async function nativeTranscriptPaths(root: string, harness: "pi" | "codex", signal?: AbortSignal) {
  const pending = [harness === "pi" ? piSessionDirectory(root) : codexSessionDirectory()];
  const paths: string[] = [];
  const errors: ImportScanError[] = [];
  while (pending.length) {
    signal?.throwIfAborted();
    const directory = pending.pop();
    if (!directory) continue;
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      errors.push({ harness, path: directory, message: error instanceof Error ? error.message : String(error) });
      return [];
    });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push(path);
    }
  }
  return { paths, errors };
}

export type NativeImportCandidate = {
  harness: "pi" | "codex";
  path: string;
  nativeSessionId: string;
  turnCount: number;
  sessionStartedAt: string | undefined;
};

/** Find existing native transcripts for exactly one bound project. */
export async function discoverNativeImportCandidates(root: string, harnesses: ("pi" | "codex")[], options: {
  signal?: AbortSignal;
  onProgress?: (progress: { harness: "pi" | "codex"; scanned: number; candidates: number }) => void;
} = {}) {
  const candidates: NativeImportCandidate[] = [];
  const errors: Array<{ harness: "pi" | "codex"; path: string; message: string }> = [];
  for (const harness of harnesses) {
    options.signal?.throwIfAborted();
    const scanned = await nativeTranscriptPaths(root, harness, options.signal);
    errors.push(...scanned.errors);
    let start = 0;
    while (start < scanned.paths.length) {
      options.signal?.throwIfAborted();
      const paths = scanned.paths.slice(start, start + 2);
      const sizes = await Promise.all(paths.map((path) => stat(path).then((value) => value.size).catch(() => 0)));
      const concurrency = sizes.some((size) => size > LARGE_TRANSCRIPT_BYTES) ? 1 : 2;
      const batch = await Promise.all(paths.slice(0, concurrency).map(async (path) => {
        try {
          const header = await readNativeTranscriptHeader(path, harness, options.signal);
          if (await canonicalRuntimeRoot(header.cwd) !== root) return null;
          const transcript = await readNativeTranscript(path, harness, { settled: true, signal: options.signal });
          if (transcript.turns.length === 0) return { error: { harness, path, message: "Transcript contains no importable Turns" } satisfies ImportScanError };
          return { harness, path, nativeSessionId: transcript.nativeSessionId, turnCount: transcript.turns.length,
            sessionStartedAt: transcript.turns.map((turn) => turn.startedAt).sort()[0] } satisfies NativeImportCandidate;
        } catch (error) {
          return { error: { harness, path, message: error instanceof Error ? error.message : String(error) } satisfies ImportScanError };
        }
      }));
      for (const result of batch) {
        options.signal?.throwIfAborted();
        if (!result) continue;
        if ("error" in result) {
          if (result.error) errors.push(result.error);
        } else candidates.push(result);
        options.onProgress?.({ harness, scanned: start + batch.length, candidates: candidates.length });
      }
      start += concurrency;
    }
  }
  return { candidates, errors };
}

export function nativeArchiveTransport(spaceId: string, identity: string): Pick<NativeSyncTransport, "prepareRuntimeArchive" | "commitRuntimeArchive" | "getRuntimeArchive"> {
  const client = createClient().space(spaceId);
  const guard = async <T>(task: () => Promise<T>): Promise<T> => {
    if (currentIdentityKey() !== identity) throw new Error("Native sync account changed");
    const result = await task();
    if (currentIdentityKey() !== identity) throw new Error("Native sync account changed");
    return result;
  };
  return {
    prepareRuntimeArchive: (...args) => guard(() => client.prepareRuntimeArchive(...args)),
    commitRuntimeArchive: (...args) => guard(() => client.commitRuntimeArchive(...args)),
    getRuntimeArchive: (...args) => guard(() => client.getRuntimeArchive(...args)),
  };
}

export async function readNativeSyncConfig(runtimeRoot: string, identity: string): Promise<NativeSyncConfig | null> {
  try {
    const config = JSON.parse(await readFile(nativeSyncConfigPath(runtimeRoot, identity), "utf8")) as NativeSyncConfig;
    if (config.version !== 1 || config.identity !== identity || !Array.isArray(config.harnesses)) throw new Error("Invalid native sync configuration");
    return config;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

const nativeStores = new Map<string, NativeSyncStore>();
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Canonical alias, but a missing target reports itself instead of failing capture. */
const canonicalPathOrNull = async (path: string) => canonicalRuntimeRoot(path).catch((error) => { if (missing(error)) return null; throw error; });

/** Local capture only. Neither Pi callbacks nor Codex hooks wait for Cohub's network. */
export async function captureNativeSession(input: { harness: "pi" | "codex"; cwd: string; path: string; nativeSessionId?: string; settled?: boolean; leafId?: string | null; sessionStartedAt?: string; origin?: "local_import" }): Promise<NativeSyncStore | null> {
  if (process.env.COHUB_TURN_ID || process.env.COHUB_EXECUTION_TOKEN) return null;
  const identity = currentIdentityKey();
  if (!identity) return null;
  // Pi and Codex create their transcripts lazily, so a pending capture for a file that does
  // not exist yet (or a workspace that has since been removed) is not a sync failure.
  const root = await canonicalPathOrNull(input.cwd);
  if (!root) return null;
  const space = await getRuntimeSpaceBinding(root, identity);
  if (!space) return null;
  const runtimeRoot = nativeRuntimeRoot(space.spaceId);
  const config = await readNativeSyncConfig(runtimeRoot, identity);
  if (!config || config.root !== root || config.spaceId !== space.spaceId || !config.harnesses.includes(input.harness)) return null;
  const path = await canonicalPathOrNull(input.path);
  if (!path) return null;
  const transcript = await readNativeTranscript(path, input.harness, input);
  if (await canonicalPathOrNull(transcript.cwd) !== root || input.nativeSessionId && transcript.nativeSessionId !== input.nativeSessionId) throw new Error("Native transcript belongs to another project or Session");
  const key = JSON.stringify([identity, space.spaceId, input.harness, transcript.nativeSessionId, path]);
  let store = nativeStores.get(key);
  if (!store) {
    const transport = nativeArchiveTransport(space.spaceId, identity);
    const candidates = (await listNativeSyncStores(runtimeRoot, space.spaceId, identity, transport))
      .filter((candidate) => candidate.options.harness === input.harness && candidate.options.nativeSessionId === transcript.nativeSessionId);
    for (const candidate of candidates) if ((await candidate.binding()).path === path) { store = candidate; break; }
    if (!store) {
      const managed = await findRuntimeNativeSession(runtimeRoot, input.harness, transcript.nativeSessionId, path);
      const managedPath = managed ? await canonicalPathOrNull(managed.path) : null;
      if (candidates.length && managedPath !== path) throw new Error("Native path changed; original bindings retained");
      // Restored Pi working copies can share a native ID. Existing Cohub sidecars disambiguate them.
      store = new NativeSyncStore({ runtimeRoot, spaceId: space.spaceId, identity, harness: input.harness, nativeSessionId: transcript.nativeSessionId,
        instanceKey: managedPath === path ? path : undefined, transport });
    }
    if (nativeStores.size >= 256) nativeStores.delete(nativeStores.keys().next().value ?? "");
    nativeStores.set(key, store);
  }
  await store.capture(path, transcript, { sessionStartedAt: input.sessionStartedAt, origin: input.origin });
  return store;
}

/** The existing Runtime supervisor retries receipts even after the original terminal has exited. */
export function nativeWebSocketTransport(spaceId: string, identity: string, send: (event: NativeRuntimeEvent) => Promise<unknown>): NativeSyncTransport {
  const archive = nativeArchiveTransport(spaceId, identity);
  return {
    ...archive,
    startNativeTurn: async (input) => await send({ type: "start", input }) as Awaited<ReturnType<NonNullable<NativeSyncTransport["startNativeTurn"]>>>,
    completeNativeTurn: async (sessionId, turnId, result) => await send({ type: "complete", sessionId, turnId, result }) as { completed: true; artifactsPending?: boolean },
    updateNativeTurn: async (sessionId, turnId, progress) => await send({ type: "progress", sessionId, turnId, progress }) as { accepted: boolean },
    heartbeatNativeTurn: async (sessionId, turnId) => await send({ type: "heartbeat", sessionId, turnId }) as { abortRequested: boolean; status: string },
  };
}

export async function flushNativeSessions(spaceId: string, identity: string, signal: AbortSignal, report: (error: unknown) => void, transportOverride?: NativeSyncTransport): Promise<boolean> {
  if (currentIdentityKey() !== identity) return false;
  const runtimeRoot = nativeRuntimeRoot(spaceId);
  const config = await readNativeSyncConfig(runtimeRoot, identity);
  if (!config || config.spaceId !== spaceId) return false;
  const transport = transportOverride;
  if (!transport) return false;
  const stores = await listNativeSyncStores(runtimeRoot, spaceId, identity, transport);
  let failed = false;
  for (const store of stores) {
    signal.throwIfAborted();
    const binding = await store.binding();
    if (!config.harnesses.includes(binding.harness)) continue;
    try {
      // Codex hooks trigger captures; re-reading here also closes gaps after reconnects or missed hooks.
      if (binding.harness === "codex") await store.capture(binding.path, await readNativeTranscript(binding.path, "codex"));
      await store.flush(AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
    }
    catch (error) {
      if (!signal.aborted) {
        failed = true;
        report(error);
      }
    }
  }
  return failed;
}
