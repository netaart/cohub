import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessArchiveIndex, NativeTurnBinding, NativeTurnComplete, NativeTurnStart, NativeTurnProgress } from "@neta-art/cohub";
import { nativeTurnCompleteSchema, nativeTurnStartSchema, nativeTurnProgressSchema, harnessArchiveIndexSchema } from "@neta-art/cohub";
import { RuntimeArchiveStore, atomicRuntimeJson, type ArchiveTransport } from "./archive-store.js";
import { findRuntimeNativeSession } from "./session-store.js";
import { withRuntimeSpaceBindingsLock } from "./space-binding.js";
import type { NativeTranscript } from "./native-transcript.js";

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const nativeIdentityHash = (identity: string) => hash(identity);
export function nativeStableId(value: string) {
  const hex = hash(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if (missing(error)) return null; throw error; }
}

type NativeBinding = {
  version: 1;
  identity: string;
  spaceId: string;
  harness: "pi" | "codex";
  nativeSessionId: string;
  instanceKey?: string;
  path: string;
  originSessionId: string;
  sessionId: string | null;
  throughTurnId: string | null;
  throughBytes: number;
  anchors: Array<{ turnId: string; sizeBytes: number; sha256: string }>;
};
export type NativeTurnReceipt = {
  version: 1;
  turnId: string;
  key: string;
  parentKey: string | null;
  parentCloudTurnId: string | null;
  userContent: NativeTurnStart["userContent"];
  startedAt: string;
  endBytes: number;
  contentEndBytes?: number;
  result: NativeTurnComplete | null;
  progress?: NativeTurnProgress;
};
export type NativeSyncTransport = ArchiveTransport & {
  startNativeTurn?(input: NativeTurnStart, options?: { signal?: AbortSignal }): Promise<NativeTurnBinding>;
  completeNativeTurn?(sessionId: string, turnId: string, input: NativeTurnComplete, options?: { signal?: AbortSignal }): Promise<{ completed: true; artifactsPending?: boolean }>;
  heartbeatNativeTurn?(sessionId: string, turnId: string, options?: { signal?: AbortSignal }): Promise<{ abortRequested: boolean; status: string }>;
  updateNativeTurn?(sessionId: string, turnId: string, input: NativeTurnProgress, options?: { signal?: AbortSignal }): Promise<{ accepted: boolean }>;
};
export type NativeSyncOptions = { runtimeRoot: string; spaceId: string; identity: string; harness: "pi" | "codex"; nativeSessionId: string; instanceKey?: string; transport?: NativeSyncTransport };

/** Turn receipts are append-only. Capture never waits for the network; network ACKs live in separate files. */
export class NativeSyncStore {
  readonly root: string;
  readonly archives: RuntimeArchiveStore;
  private archiveFailure: unknown;
  constructor(readonly options: NativeSyncOptions) {
    const source = options.instanceKey ? JSON.stringify([options.nativeSessionId, options.instanceKey]) : options.nativeSessionId;
    this.root = join(options.runtimeRoot, "native", nativeIdentityHash(options.identity), `${options.harness}-${hash(source)}`);
    const transport = options.transport;
    this.archives = new RuntimeArchiveStore(join(this.root, "archives"), transport ? {
      prepareRuntimeArchive: async (index, request) => transport.prepareRuntimeArchive(await this.cloudArchive(index), request),
      commitRuntimeArchive: async (index, request) => transport.commitRuntimeArchive(await this.cloudArchive(index), request),
      getRuntimeArchive: (...args) => transport.getRuntimeArchive(...args),
      fetchObject: transport.fetchObject,
    } : undefined);
    this.archives.setErrorReporter((error) => { this.archiveFailure = error; });
  }
  private bindingPath() { return join(this.root, "binding.json"); }
  private turnId(key: string) {
    return nativeStableId(JSON.stringify([this.options.identity, this.options.spaceId, this.options.harness, this.options.nativeSessionId, this.options.instanceKey ?? null, key]));
  }
  private receiptPath(id: string) { return join(this.root, "turns", `${id}.json`); }
  private acknowledgementPath(id: string) { return join(this.root, "acknowledged", `${id}.json`); }
  private pendingPath(id: string) { return join(this.root, "pending", `${id}.json`); }
  private requestPath(id: string) { return join(this.root, "requests", `${id}.json`); }
  private cloudBindingPath(id: string) { return join(this.root, "bindings", `${id}.json`); }
  async binding() {
    const value = await readJson<NativeBinding>(this.bindingPath());
    if (value?.version !== 1 || value.identity !== this.options.identity || value.spaceId !== this.options.spaceId || value.nativeSessionId !== this.options.nativeSessionId || value.instanceKey !== this.options.instanceKey || value.harness !== this.options.harness) throw new Error("Native binding mismatch / 原生关联不匹配");
    return value;
  }
  private async initialize(path: string, transcript: NativeTranscript) {
    const existing = await readJson<NativeBinding>(this.bindingPath());
    if (existing) {
      const binding = await this.binding();
      if (binding.path !== path) throw new Error("Native path changed; original binding retained / 原生路径已变化，原关联已保留");
      return binding;
    }
    const managed = await findRuntimeNativeSession(this.options.runtimeRoot, this.options.harness, transcript.nativeSessionId, path);
    let throughBytes = 0;
    const anchors: NativeBinding["anchors"] = [];
    if (managed) {
      if (managed.pendingTurnId) throw new Error("Reconcile the managed Turn before native continuation / 请先确认 Runtime 中尚未确认的 Turn");
      if (managed.throughTurnId) {
        const index = await readJson<HarnessArchiveIndex>(join(this.options.runtimeRoot, "archives", "versions", `${managed.throughTurnId}.json`));
        if (index) {
          const parsed = harnessArchiveIndexSchema.parse(index);
          const checksum = createHash("sha256");
          for await (const bytes of createReadStream(path, { end: parsed.sizeBytes - 1 })) checksum.update(bytes);
          if (checksum.digest("hex") !== parsed.sha256) throw new Error("Runtime history prefix changed / Runtime 历史前缀已变化");
          throughBytes = parsed.sizeBytes;
        } else {
          const checksum = createHash("sha256");
          for await (const bytes of createReadStream(path)) checksum.update(bytes);
          if (checksum.digest("hex") !== managed.checksum) throw new Error("Cannot identify the last complete Runtime Turn / 无法识别 Runtime 最后一个完整 Turn");
          throughBytes = (await stat(path)).size;
          anchors.push({ turnId: managed.throughTurnId, sizeBytes: throughBytes, sha256: managed.checksum });
        }
        const versions = join(this.options.runtimeRoot, "archives", "versions");
        const names = await readdir(versions).catch((error) => { if (missing(error)) return []; throw error; });
        for (const name of names) {
          if (!name.endsWith(".json")) continue;
          const version = harnessArchiveIndexSchema.parse(await readJson(join(versions, name)));
          if (version.sessionId === managed.sessionId && version.harness === managed.harness && version.nativeSessionId === managed.nativeSessionId && version.sizeBytes <= throughBytes) {
            anchors.push({ turnId: version.turnId, sizeBytes: version.sizeBytes, sha256: version.sha256 });
          }
        }
      }
    }
    const binding: NativeBinding = { version: 1, identity: this.options.identity, spaceId: this.options.spaceId, harness: this.options.harness,
      nativeSessionId: transcript.nativeSessionId, instanceKey: this.options.instanceKey, path, originSessionId: nativeStableId(`${this.root}:archive`),
      sessionId: managed?.sessionId ?? transcript.cloudSessionId ?? null, throughTurnId: managed?.throughTurnId ?? null, throughBytes, anchors };
    // A managed Runtime must rebuild a separate projection rather than write into an interactive client's file.
    await atomicRuntimeJson(join(this.options.runtimeRoot, "native-owners", `${hash(path)}.json`), { path, nativeSessionId: binding.nativeSessionId });
    await atomicRuntimeJson(this.bindingPath(), binding);
    return binding;
  }
  async capture(path: string, transcript: NativeTranscript) {
    if (transcript.nativeSessionId !== this.options.nativeSessionId) throw new Error("Native session identity mismatch / 原生会话身份不匹配");
    await withRuntimeSpaceBindingsLock(async () => {
      const binding = await this.initialize(path, transcript);
      if (binding.throughBytes > 0) {
        const anchor = binding.anchors.find((entry) => entry.sizeBytes === binding.throughBytes);
        if (!anchor || transcript.prefixes.get(binding.throughBytes) !== anchor.sha256) throw new Error("Runtime history prefix changed; original binding retained / Runtime 历史前缀已变化，原关联已保留");
      }
      let parentKey: string | null = null;
      let parentCloudTurnId = binding.throughTurnId;
      let knownBoundary = binding.throughBytes === 0;
      for (const turn of transcript.turns) {
        if (turn.startBytes < binding.throughBytes) {
          // Native offsets only validate whole-Turn archive checkpoints; they never become cloud fork anchors.
          const matches = (binding.anchors ?? []).filter((anchor) => anchor.sizeBytes >= turn.contentEndBytes && turn.boundaries[anchor.sizeBytes] === anchor.sha256);
          if (new Set(matches.map((anchor) => anchor.turnId)).size > 1) throw new Error("Ambiguous Runtime Turn boundary / Runtime Turn 边界不明确");
          parentCloudTurnId = matches[0]?.turnId ?? null;
          knownBoundary = matches.length > 0;
          parentKey = null;
          continue;
        }
        if (turn.cloudTurnId) {
          parentCloudTurnId = turn.cloudTurnId;
          knownBoundary = binding.harness === "codex" ? turn.result !== null : !["toolUse", "pending"].includes(turn.messages.at(-1)?.stopReason ?? "pending");
          parentKey = null;
          continue;
        }
        if (!parentKey && !knownBoundary) throw new Error("Native continuation is not at a complete Runtime Turn boundary / 原生续聊不在完整 Runtime Turn 边界上");
        const turnId = this.turnId(turn.key);
        const old = await readJson<NativeTurnReceipt>(this.receiptPath(turnId));
        if (old?.result) {
          if (turn.contentEndBytes < (old.contentEndBytes ?? old.endBytes) || JSON.stringify(turn.userContent) !== JSON.stringify(old.userContent) || turn.result && JSON.stringify(nativeTurnCompleteSchema.parse(turn.result)) !== JSON.stringify(old.result)) {
            throw new Error("Native branch is inside a settled Turn; only whole-Turn forks are supported / 原生分支位于已结束的 Turn 内，仅支持完整 Turn 分支");
          }
          parentKey = turn.key;
          continue;
        }
        const result = turn.result ? nativeTurnCompleteSchema.parse(turn.result) : null;
        const receipt: NativeTurnReceipt = { version: 1, turnId, key: turn.key, parentKey, parentCloudTurnId: parentKey ? null : parentCloudTurnId,
          userContent: turn.userContent, startedAt: turn.startedAt, endBytes: turn.endBytes, contentEndBytes: turn.contentEndBytes, result,
          ...(!result ? { progress: nativeTurnProgressSchema.parse({ revision: turn.endBytes, messages: turn.messages }) } : {}) };
        if (old && (JSON.stringify(old.userContent) !== JSON.stringify(receipt.userContent) || old.parentKey !== receipt.parentKey)) throw new Error("Native Turn changed; original receipt retained / 原生 Turn 已变化，原回执已保留");
        // Capture immutable native bytes before publishing the completed receipt. Subsequent Turns may change the source.
        if (result) await this.archives.stage({ sessionId: binding.originSessionId, harness: binding.harness, nativeSessionId: binding.nativeSessionId, path, sizeBytes: turn.endBytes, expectedChecksum: turn.sha256 }, turnId);
        if (JSON.stringify(old) !== JSON.stringify(receipt)) {
          // The pending index precedes the receipt, so a crash cannot silently strand an unacknowledged Turn.
          await atomicRuntimeJson(this.pendingPath(turnId), { turnId });
          await atomicRuntimeJson(this.receiptPath(turnId), receipt);
        }
        parentKey = turn.key;
      }
    }, { lockPath: join(this.root, "capture.lock") });
  }
  async receipts(pendingOnly = false): Promise<NativeTurnReceipt[]> {
    const names = await readdir(join(this.root, pendingOnly ? "pending" : "turns")).catch((error) => { if (missing(error)) return []; throw error; });
    const receipts: NativeTurnReceipt[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const receipt = await readJson<NativeTurnReceipt>(join(this.root, "turns", name));
      if (pendingOnly && !receipt) {
        // Crash window: the pending index was written but the receipt itself never landed.
        // The pointer carries no data; drop it — the next capture rebuilds the receipt from the transcript.
        await rm(join(this.root, "pending", name), { force: true });
        continue;
      }
      if (receipt?.version !== 1 || receipt.turnId !== this.turnId(receipt.key)) throw new Error("Native receipt is corrupt; original retained / 原生回执损坏，原件已保留");
      receipts.push(receipt);
    }
    return receipts.sort((a, b) => a.endBytes - b.endBytes || a.turnId.localeCompare(b.turnId));
  }
  async status() {
    const binding = await this.binding();
    const receipts = await this.receipts();
    let pendingTurns = 0;
    let sessionId = binding.sessionId;
    for (const receipt of receipts) {
      const remote = await readJson<NativeTurnBinding>(this.cloudBindingPath(receipt.turnId));
      if (remote) sessionId = remote.sessionId;
      if (!await readJson(this.acknowledgementPath(receipt.turnId))) pendingTurns++;
    }
    return { harness: binding.harness, nativeSessionId: binding.nativeSessionId, sessionId, pendingTurns, pendingArchives: await this.archives.pendingCount() };
  }
  async flush(signal: AbortSignal, onAbort?: () => void): Promise<void> {
    const transport = this.options.transport;
    if (!transport) return;
    await withRuntimeSpaceBindingsLock(async () => {
      const binding = await this.binding();
      const pending = new Map((await this.receipts(true)).map((receipt) => [receipt.key, receipt]));
      const processed = new Set<string>();
      const visit = async (receipt: NativeTurnReceipt): Promise<boolean> => {
        signal.throwIfAborted();
        if (await readJson(this.acknowledgementPath(receipt.turnId))) { await rm(this.pendingPath(receipt.turnId), { force: true }); return true; }
        if (processed.has(receipt.key)) return false;
        processed.add(receipt.key);
        let parent: NativeTurnBinding | null = null;
        if (receipt.parentKey) {
          const parentId = this.turnId(receipt.parentKey);
          parent = await readJson<NativeTurnBinding>(this.acknowledgementPath(parentId));
          if (!parent) {
            const predecessor = pending.get(receipt.parentKey);
            if (!predecessor || !await visit(predecessor)) return false;
            parent = await readJson<NativeTurnBinding>(this.acknowledgementPath(parentId));
          }
          if (!parent) throw new Error("Parent binding is missing / 父 Turn 关联缺失");
        }
        let request = await readJson<NativeTurnStart>(this.requestPath(receipt.turnId));
        if (!request) {
          request = nativeTurnStartSchema.parse({ turnId: receipt.turnId, sessionId: parent?.sessionId ?? binding.sessionId, parentTurnId: parent?.turnId ?? receipt.parentCloudTurnId,
            branchSessionId: nativeStableId(`${receipt.turnId}:branch`), harness: binding.harness, nativeSessionId: binding.nativeSessionId, userContent: receipt.userContent, startedAt: receipt.startedAt });
          await atomicRuntimeJson(this.requestPath(receipt.turnId), request);
        }
        let remote = await readJson<NativeTurnBinding>(this.cloudBindingPath(receipt.turnId));
        if (!remote) {
          if (!transport.startNativeTurn) throw new Error("Native Runtime WS is unavailable / 原生 Runtime WS 不可用");
          remote = await transport.startNativeTurn(request, { signal });
          if (remote.turnId !== receipt.turnId) throw new Error("Server Turn identity mismatch / 服务端 Turn 身份不匹配");
          await atomicRuntimeJson(this.cloudBindingPath(receipt.turnId), remote);
        }
        if (!receipt.result) {
          if (receipt.progress?.messages.length && transport.updateNativeTurn) {
            const progressPath = join(this.root, "progress", `${receipt.turnId}.json`);
            const sent = await readJson<{ revision: number }>(progressPath);
            if (!sent || sent.revision < receipt.progress.revision) {
              await transport.updateNativeTurn(remote.sessionId, remote.turnId, receipt.progress, { signal });
              await atomicRuntimeJson(progressPath, { revision: receipt.progress.revision });
            }
          }
          if (onAbort && transport.heartbeatNativeTurn) {
            const status = await transport.heartbeatNativeTurn(remote.sessionId, remote.turnId, { signal });
            if (status.abortRequested) onAbort?.();
          }
          return false;
        }
        if (!transport.completeNativeTurn) throw new Error("Native Runtime WS is unavailable / 原生 Runtime WS 不可用");
        // Artifact retries back off: the terminal state is durable, so hammering the completion
        // endpoint every flush cycle (5s) while object storage is down only adds load.
        const backoffPath = join(this.root, "backoff", `${receipt.turnId}.json`);
        const backoff = await readJson<{ at: number }>(backoffPath);
        if (backoff && Date.now() - backoff.at < 30_000) return false;
        const completion = await transport.completeNativeTurn(remote.sessionId, remote.turnId, receipt.result, { signal });
        if (completion.artifactsPending) {
          // Terminal state is durable; only the artifact snapshot is missing. Keep the receipt pending
          // and retry on the next flush cycle (>= 30s) until artifacts persist.
          await atomicRuntimeJson(backoffPath, { at: Date.now() });
          throw new Error("Native artifacts are pending; completion replays later / 原生产物待生成，稍后重放完成请求");
        }
        await rm(backoffPath, { force: true });
        await atomicRuntimeJson(this.acknowledgementPath(receipt.turnId), remote);
        await rm(this.pendingPath(receipt.turnId), { force: true });
        return true;
      };
      const failures: unknown[] = [];
      for (const receipt of pending.values()) {
        if (!processed.has(receipt.key)) {
          try { await visit(receipt); }
          catch (error) { failures.push(error); }
        }
      }
      // Resolve Session identities before the archive dependency walk. A fork baseline must not
      // wait for an unrelated parent Session's failed upload. Immutable local versions stay untouched.
      const archivePending = join(this.archives.root, "pending");
      const indexes = await readdir(archivePending).catch((error) => { if (missing(error)) return []; throw error; });
      for (const name of indexes) {
        if (!name.endsWith(".json")) continue;
        try {
          const path = join(archivePending, name);
          const index = harnessArchiveIndexSchema.parse(await readJson(path));
          const resolved = await this.cloudArchive(index);
          if (JSON.stringify(index) !== JSON.stringify(resolved)) await atomicRuntimeJson(path, resolved);
        } catch (error) { failures.push(error); }
      }
      this.archiveFailure = undefined;
      await this.archives.flush(signal);
      if (failures.length) throw failures[0];
      if (this.archiveFailure) throw this.archiveFailure;
    }, { lockPath: join(this.root, "flush.lock") });
  }
  private async cloudArchive(index: HarnessArchiveIndex): Promise<HarnessArchiveIndex> {
    const binding = await readJson<NativeTurnBinding>(this.acknowledgementPath(index.turnId));
    if (!binding) throw new Error("Native Turn result is not confirmed / 原生 Turn 结果尚未确认");
    if (index.parentTurnId) {
      const parent = await readJson<NativeTurnBinding>(this.acknowledgementPath(index.parentTurnId));
      if (parent?.sessionId === binding.sessionId) return { ...index, sessionId: binding.sessionId };
      // Cross-Session archive parents are forbidden. Materialize a baseline using existing immutable segments.
      const segments = [...index.segments];
      const visited = new Set([index.turnId]);
      let parentId: string | null = index.parentTurnId;
      while (parentId) {
        if (visited.has(parentId)) throw new Error("Cyclic native archive / 原生归档存在循环");
        visited.add(parentId);
        const previous = harnessArchiveIndexSchema.parse(await readJson(join(this.archives.root, "versions", `${parentId}.json`)));
        segments.unshift(...previous.segments); parentId = previous.parentTurnId;
      }
      return harnessArchiveIndexSchema.parse({ ...index, sessionId: binding.sessionId, parentTurnId: null, segments });
    }
    return { ...index, sessionId: binding.sessionId };
  }
}

export async function listNativeSyncStores(runtimeRoot: string, spaceId: string, identity: string, transport?: NativeSyncTransport) {
  const root = join(runtimeRoot, "native", nativeIdentityHash(identity));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stores: NativeSyncStore[] = [];
  for (const name of await readdir(root)) {
    if (!/^(pi|codex)-[a-f0-9]{64}$/.test(name)) continue;
    const binding = await readJson<NativeBinding>(join(root, name, "binding.json"));
    if (!binding || binding.identity !== identity || binding.spaceId !== spaceId) continue;
    stores.push(new NativeSyncStore({ runtimeRoot, spaceId, identity, harness: binding.harness, nativeSessionId: binding.nativeSessionId, instanceKey: binding.instanceKey, transport }));
  }
  return stores;
}
