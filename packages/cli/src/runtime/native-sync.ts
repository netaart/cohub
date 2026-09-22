import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient } from "../client.js";
import { currentIdentityKey } from "../space.js";
import { canonicalRuntimeRoot, getRuntimeSpaceBinding } from "./space-binding.js";
import { readNativeTranscript } from "./native-transcript.js";
import { findRuntimeNativeSession } from "./session-store.js";
import { listNativeSyncStores, nativeIdentityHash, NativeSyncStore, type NativeSyncTransport } from "./native-sync-store.js";
import type { NativeRuntimeEvent } from "@neta-art/cohub";

export type NativeSyncConfig = { version: 1; identity: string; spaceId: string; root: string; harnesses: ("pi" | "codex")[] };
export const nativeRuntimeRoot = (spaceId: string) => join(homedir(), ".local", "state", "cohub", "runtime", spaceId);
export const nativeSyncConfigPath = (runtimeRoot: string, identity: string) => join(runtimeRoot, "native", nativeIdentityHash(identity), "config.json");

export function nativeArchiveTransport(spaceId: string, identity: string): Pick<NativeSyncTransport, "prepareRuntimeArchive" | "commitRuntimeArchive" | "getRuntimeArchive"> {
  const client = createClient().space(spaceId);
  const guard = async <T>(task: () => Promise<T>): Promise<T> => {
    if (currentIdentityKey() !== identity) throw new Error("Native sync account changed / 原生同步账号已变化");
    const result = await task();
    if (currentIdentityKey() !== identity) throw new Error("Native sync account changed / 原生同步账号已变化");
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
    if (config.version !== 1 || config.identity !== identity || !Array.isArray(config.harnesses)) throw new Error("Invalid native sync configuration / 原生同步配置无效");
    return config;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

const nativeStores = new Map<string, NativeSyncStore>();

/** Local capture only. Neither Pi callbacks nor Codex hooks wait for Cohub's network. */
export async function captureNativeSession(input: { harness: "pi" | "codex"; cwd: string; path: string; nativeSessionId?: string; settled?: boolean; leafId?: string | null }): Promise<NativeSyncStore | null> {
  if (process.env.COHUB_TURN_ID || process.env.COHUB_EXECUTION_TOKEN) return null;
  const identity = currentIdentityKey();
  if (!identity) return null;
  const root = await canonicalRuntimeRoot(input.cwd);
  const space = await getRuntimeSpaceBinding(root, identity);
  if (!space) return null;
  const runtimeRoot = nativeRuntimeRoot(space.spaceId);
  const config = await readNativeSyncConfig(runtimeRoot, identity);
  if (!config || config.root !== root || config.spaceId !== space.spaceId || !config.harnesses.includes(input.harness)) return null;
  const path = await canonicalRuntimeRoot(input.path);
  const transcript = await readNativeTranscript(path, input.harness, input);
  if (await canonicalRuntimeRoot(transcript.cwd) !== root || input.nativeSessionId && transcript.nativeSessionId !== input.nativeSessionId) throw new Error("Native transcript belongs to another project or Session / 原生记录属于其他项目或会话");
  const key = JSON.stringify([identity, space.spaceId, input.harness, transcript.nativeSessionId, path]);
  let store = nativeStores.get(key);
  if (!store) {
    const transport = nativeArchiveTransport(space.spaceId, identity);
    const candidates = (await listNativeSyncStores(runtimeRoot, space.spaceId, identity, transport))
      .filter((candidate) => candidate.options.harness === input.harness && candidate.options.nativeSessionId === transcript.nativeSessionId);
    for (const candidate of candidates) if ((await candidate.binding()).path === path) { store = candidate; break; }
    if (!store) {
      const managed = await findRuntimeNativeSession(runtimeRoot, input.harness, transcript.nativeSessionId, path);
      const managedPath = managed ? await canonicalRuntimeRoot(managed.path).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }) : null;
      if (candidates.length && managedPath !== path) throw new Error("Native path changed; original bindings retained / 原生路径已变化，原关联已保留");
      // Restored Pi working copies can share a native ID. Existing Cohub sidecars disambiguate them.
      store = new NativeSyncStore({ runtimeRoot, spaceId: space.spaceId, identity, harness: input.harness, nativeSessionId: transcript.nativeSessionId,
        instanceKey: managedPath === path ? path : undefined, transport });
    }
    if (nativeStores.size >= 256) nativeStores.delete(nativeStores.keys().next().value ?? "");
    nativeStores.set(key, store);
  }
  await store.capture(path, transcript);
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

export async function flushNativeSessions(spaceId: string, identity: string, signal: AbortSignal, report: (error: unknown) => void, transportOverride?: NativeSyncTransport) {
  if (currentIdentityKey() !== identity) return;
  const runtimeRoot = nativeRuntimeRoot(spaceId);
  const config = await readNativeSyncConfig(runtimeRoot, identity);
  if (!config || config.spaceId !== spaceId) return;
  const transport = transportOverride;
  if (!transport) return;
  const stores = await listNativeSyncStores(runtimeRoot, spaceId, identity, transport);
  for (const store of stores) {
    signal.throwIfAborted();
    const binding = await store.binding();
    if (!config.harnesses.includes(binding.harness)) continue;
    try {
      // Codex hooks only push capture requests while its terminal lives; the Daemon keeps re-reading
      // the transcript between hooks so Stop-flushed Turns are picked up even if a hook is missed.
      if (binding.harness === "codex") await store.capture(binding.path, await readNativeTranscript(binding.path, "codex"));
      await store.flush(AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
    }
    catch (error) { if (!signal.aborted) report(error); }
  }
}
