import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { HarnessArchiveIndex, NativeTurnBinding, NativeTurnComplete, NativeTurnStart, NativeTurnProgress } from "@neta-art/cohub";
import { nativeTurnCompleteSchema, nativeTurnStartSchema, nativeTurnProgressSchema, harnessArchiveIndexSchema } from "@neta-art/cohub";
import { ArchiveCaptureIntegrityError, RuntimeArchiveStore, atomicRuntimeJson, type ArchiveTransport } from "./archive-store.js";
import { codexRolloutCachePath, codexRolloutIdOf, codexRolloutBytes, ensurePlainCodexRollout } from "./native-transcript.js";
import { findRuntimeNativeSession } from "./session-store.js";
import { withRuntimeSpaceBindingsLock } from "./space-binding.js";
import type { NativeTranscript, NativeTranscriptTurn } from "./native-transcript.js";

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
  /** After a Codex rollover: the superseded rollout's settled boundary, addressed by rollout id. */
  ancestor?: { rolloutId: string; throughBytes: number; anchors: Array<{ turnId: string; sizeBytes: number; sha256: string }> };
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
  sessionStartedAt?: string;
  origin?: "local_import";
  progress?: NativeTurnProgress;
  /** Merged lineage order across Codex rollout files. */
  sequence?: number;
};
export type NativeSyncTransport = ArchiveTransport & {
  startNativeTurn?(input: NativeTurnStart, options?: { signal?: AbortSignal }): Promise<NativeTurnBinding>;
  completeNativeTurn?(sessionId: string, turnId: string, input: NativeTurnComplete, options?: { signal?: AbortSignal }): Promise<{ completed: true; artifactsPending?: boolean }>;
  heartbeatNativeTurn?(sessionId: string, turnId: string, options?: { signal?: AbortSignal }): Promise<{ abortRequested: boolean; status: string }>;
  updateNativeTurn?(sessionId: string, turnId: string, input: NativeTurnProgress, options?: { signal?: AbortSignal }): Promise<{ accepted: boolean }>;
};
export type NativeSyncOptions = { runtimeRoot: string; spaceId: string; identity: string; harness: "pi" | "codex"; nativeSessionId: string; instanceKey?: string; transport?: NativeSyncTransport };

type NativeAnchor = { turnId: string; sizeBytes: number; sha256: string };

/** Whole-Turn archive checkpoints only; native offsets never become cloud fork anchors. */
function matchAnchor(turn: Pick<NativeTranscriptTurn, "contentEndBytes" | "boundaries">, anchors: readonly NativeAnchor[]): NativeAnchor[] {
  return anchors.filter((anchor) => anchor.sizeBytes >= turn.contentEndBytes && turn.boundaries[anchor.sizeBytes] === anchor.sha256);
}

/** Archive checkpoints of one managed session, optionally bounded by a byte prefix. */
async function collectArchiveAnchors(runtimeRoot: string, managed: { sessionId: string; harness: "pi" | "codex"; nativeSessionId: string }, throughBytes = Number.POSITIVE_INFINITY): Promise<NativeAnchor[]> {
  const anchors: NativeAnchor[] = [];
  const versions = join(runtimeRoot, "archives", "versions");
  const names = await readdir(versions).catch((error) => { if (missing(error)) return []; throw error; });
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const version = harnessArchiveIndexSchema.parse(await readJson(join(versions, name)));
    if (version.sessionId === managed.sessionId && version.harness === managed.harness && version.nativeSessionId === managed.nativeSessionId && version.sizeBytes <= throughBytes) {
      anchors.push({ turnId: version.turnId, sizeBytes: version.sizeBytes, sha256: version.sha256 });
    }
  }
  return anchors;
}

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
  private retryPath(id: string) { return join(this.root, "retries", `${id}.json`); }
  private cloudBindingPath(id: string) { return join(this.root, "bindings", `${id}.json`); }
  async binding() {
    const value = await readJson<NativeBinding>(this.bindingPath());
    if (value?.version !== 1 || value.identity !== this.options.identity || value.spaceId !== this.options.spaceId || value.nativeSessionId !== this.options.nativeSessionId || value.instanceKey !== this.options.instanceKey || value.harness !== this.options.harness) throw new Error("Native binding mismatch");
    return value;
  }
  private async initialize(path: string, transcript: NativeTranscript, signal?: AbortSignal) {
    const existing = await readJson<NativeBinding>(this.bindingPath());
    if (existing) {
      const binding = await this.binding();
      // Codex rollover keeps the thread id but moves appends to a fresh rollout that references
      // the old one as its history base. Follow the reference instead of failing — matched by
      // rollout id, so archiving or compressing the ancestor still migrates cleanly. When the
      // previous rollout is the leaf itself (the same file merely moved or compressed), the
      // byte boundary stays valid: only the path changes.
      const previousRolloutId = codexRolloutIdOf(basename(binding.path));
      const lineageRolloutIds = transcript.lineageRolloutIds ?? [];
      if (binding.path !== path && previousRolloutId && lineageRolloutIds.includes(previousRolloutId)) {
        const sameRollout = lineageRolloutIds.at(-1) === previousRolloutId;
        let moved: NativeBinding = { ...binding, path };
        if (!sameRollout) {
          // Byte offsets from the old rollout no longer address the new one; the settled
          // boundary moves into the ancestor record and the binding restarts at the leaf.
          moved = { ...moved, throughBytes: 0, anchors: [] };
          if (binding.throughBytes > 0) moved.ancestor = { rolloutId: previousRolloutId, throughBytes: binding.throughBytes, anchors: binding.anchors };
        }
        await atomicRuntimeJson(join(this.options.runtimeRoot, "native-owners", `${hash(path)}.json`), { path, nativeSessionId: binding.nativeSessionId });
        await atomicRuntimeJson(this.bindingPath(), moved);
        return moved;
      }
      if (binding.path !== path) throw new Error("Native path changed; original binding retained");
      return binding;
    }
    const managed = await findRuntimeNativeSession(this.options.runtimeRoot, this.options.harness, transcript.nativeSessionId, path);
    let throughBytes = 0;
    const anchors: NativeBinding["anchors"] = [];
    if (managed) {
      if (managed.pendingTurnId) throw new Error("Reconcile the managed Turn before native continuation");
      // A Codex rollover before the first native capture: the managed projection lives on an
      // ancestor rollout now. Its byte boundary addresses the ancestor, so express it as the
      // ancestor record instead of validating it against the new leaf.
      const managedRolloutId = codexRolloutIdOf(basename(managed.path));
      const lineageRolloutIds = transcript.lineageRolloutIds ?? [];
      const managedInLineage = this.options.harness === "codex" && managedRolloutId != null && lineageRolloutIds.slice(0, -1).includes(managedRolloutId);
      if (managedInLineage && managed.throughTurnId) {
        anchors.push(...await collectArchiveAnchors(this.options.runtimeRoot, managed));
        // The managed projection is the whole ancestor rollout: verify its bytes still match the
        // recorded checksum, measured on the logical JSONL (decompressed when the file is cold).
        const ancestorIndex = lineageRolloutIds.indexOf(managedRolloutId);
        const ancestorPath = transcript.lineagePaths?.[ancestorIndex] ?? managed.path;
        const checksum = createHash("sha256");
        let ancestorBytes = 0;
        for await (const bytes of codexRolloutBytes(ancestorPath, null, signal)) { checksum.update(bytes); ancestorBytes += bytes.length; }
        if (!managed.checksum) throw new Error("Managed rollout has no checksum to validate its settled boundary");
        if (checksum.digest("hex") !== managed.checksum) throw new Error("Runtime history prefix changed");
        // The verified whole-file boundary is a synthetic anchor, mirroring the regular first
        // binding: trailing records after the last Turn (e.g. usage) make contentEndBytes
        // undershoot the file size, and matchAnchor resolves through `boundaries`.
        anchors.push({ turnId: managed.throughTurnId, sizeBytes: ancestorBytes, sha256: managed.checksum });
        const binding: NativeBinding = { version: 1, identity: this.options.identity, spaceId: this.options.spaceId, harness: this.options.harness,
          nativeSessionId: transcript.nativeSessionId, instanceKey: this.options.instanceKey, path, originSessionId: nativeStableId(`${this.root}:archive`),
          sessionId: managed.sessionId, throughTurnId: managed.throughTurnId, throughBytes: 0, anchors: [],
          ancestor: { rolloutId: managedRolloutId, throughBytes: ancestorBytes, anchors } };
        // Persist like any first binding: the owner marker keeps the managed Runtime out of this
        // leaf file, and flush/status read binding.json before touching any receipt.
        await atomicRuntimeJson(join(this.options.runtimeRoot, "native-owners", `${hash(path)}.json`), { path, nativeSessionId: binding.nativeSessionId });
        await atomicRuntimeJson(this.bindingPath(), binding);
        return binding;
      }
      if (managed.throughTurnId) {
        const index = await readJson<HarnessArchiveIndex>(join(this.options.runtimeRoot, "archives", "versions", `${managed.throughTurnId}.json`));
        if (index) {
          const parsed = harnessArchiveIndexSchema.parse(index);
          const checksum = createHash("sha256");
          for await (const bytes of createReadStream(path, { end: parsed.sizeBytes - 1 })) checksum.update(bytes);
          if (checksum.digest("hex") !== parsed.sha256) throw new Error("Runtime history prefix changed");
          throughBytes = parsed.sizeBytes;
        } else {
          const checksum = createHash("sha256");
          for await (const bytes of createReadStream(path)) checksum.update(bytes);
          if (checksum.digest("hex") !== managed.checksum) throw new Error("Cannot identify the last complete Runtime Turn");
          throughBytes = (await stat(path)).size;
          anchors.push({ turnId: managed.throughTurnId, sizeBytes: throughBytes, sha256: managed.checksum });
        }
        anchors.push(...await collectArchiveAnchors(this.options.runtimeRoot, managed, throughBytes));
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
  async capture(path: string, transcript: NativeTranscript, context: { sessionStartedAt?: string; origin?: "local_import"; signal?: AbortSignal } = {}) {
    const signal = context.signal;
    if (transcript.nativeSessionId !== this.options.nativeSessionId) throw new Error("Native session identity mismatch");
    await withRuntimeSpaceBindingsLock(async () => {
      const binding = await this.initialize(path, transcript, signal);
      if (binding.throughBytes > 0) {
        const anchor = binding.anchors.find((entry) => entry.sizeBytes === binding.throughBytes);
        if (!anchor || transcript.prefixes.get(binding.throughBytes) !== anchor.sha256) throw new Error("Runtime history prefix changed; original binding retained");
      }
      let parentKey: string | null = null;
      let parentCloudTurnId = binding.throughTurnId;
      let knownBoundary = binding.throughBytes === 0;
      const ancestor = binding.ancestor;
      const leafRolloutId = transcript.lineageRolloutIds?.at(-1);
      for (const turn of transcript.turns) {
        // Lineage Turns keep their own rollout's offsets; only Turns from the binding's rollout
        // (the leaf, however it is now represented on disk) address the binding's byte boundary.
        const inLeafRollout = !turn.rolloutId || turn.rolloutId === leafRolloutId;
        if (inLeafRollout && turn.startBytes < binding.throughBytes) {
          const matches = matchAnchor(turn, binding.anchors ?? []);
          if (new Set(matches.map((anchor) => anchor.turnId)).size > 1) throw new Error("Ambiguous Runtime Turn boundary");
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
        const turnId = this.turnId(turn.key);
        const old = await readJson<NativeTurnReceipt>(this.receiptPath(turnId));
        if (old?.result) {
          if (turn.contentEndBytes < (old.contentEndBytes ?? old.endBytes) || JSON.stringify(turn.userContent) !== JSON.stringify(old.userContent) || turn.result && JSON.stringify(nativeTurnCompleteSchema.parse(turn.result)) !== JSON.stringify(old.result)) {
            throw new Error("Native branch is inside a settled Turn; only whole-Turn forks are supported");
          }
          // Receipts written before lineage support lack the merged order; backfill it from the immutable chain.
          if (turn.sequence != null && old.sequence == null) await atomicRuntimeJson(this.receiptPath(turnId), { ...old, sequence: turn.sequence });
          parentKey = turn.key;
          continue;
        }
        // After a rollover, ancestor Turns below the superseded rollout's settled boundary are
        // already durable cloud history (the retained ancestor record); anything above it is
        // new native work — including Turns whose pending receipts still need finishing.
        if (ancestor && turn.rolloutId === ancestor.rolloutId && turn.contentEndBytes <= ancestor.throughBytes) {
          const matches = matchAnchor(turn, ancestor.anchors);
          if (new Set(matches.map((anchor) => anchor.turnId)).size > 1) throw new Error("Ambiguous Runtime Turn boundary");
          parentCloudTurnId = matches[0]?.turnId ?? null;
          knownBoundary = matches.length > 0;
          parentKey = null;
          continue;
        }
        if (!parentKey && !knownBoundary) throw new Error("Native continuation is not at a complete Runtime Turn boundary");
        const result = turn.result ? nativeTurnCompleteSchema.parse(turn.result) : null;
        const receipt: NativeTurnReceipt = { version: 1, turnId, key: turn.key, parentKey, parentCloudTurnId: parentKey ? null : parentCloudTurnId,
          userContent: turn.userContent, startedAt: turn.startedAt, endBytes: turn.endBytes, contentEndBytes: turn.contentEndBytes, result,
          ...(turn.sequence != null ? { sequence: turn.sequence } : {}),
          ...(context.sessionStartedAt ? { sessionStartedAt: context.sessionStartedAt } : {}),
          ...(context.origin ? { origin: context.origin } : {}),
          ...(!result ? { progress: nativeTurnProgressSchema.parse({ revision: turn.endBytes, messages: turn.messages }) } : {}) };
        if (old && (JSON.stringify(old.userContent) !== JSON.stringify(receipt.userContent) || old.parentKey !== receipt.parentKey)) throw new Error("Native Turn changed; original receipt retained");
        // Capture immutable native bytes before publishing the completed receipt. Subsequent Turns may change the source.
        if (result) {
          const cache = join(this.options.runtimeRoot, "native", "cache", "rollouts");
          const source = turn.path ?? path;
          const state = { sessionId: binding.originSessionId, harness: binding.harness, nativeSessionId: binding.nativeSessionId, sizeBytes: turn.endBytes, expectedChecksum: turn.sha256 };
          const stage = async () => this.archives.stage({ ...state, path: await ensurePlainCodexRollout(source, cache, signal) }, turnId);
          try {
            await stage();
          } catch (error) {
            // A corrupted `.zst` cache copy (bad checksum, truncation) is rebuilt once. A
            // mismatch against an already-saved index is not a cache problem: that index is
            // immutable, so rebuilding would only repeat a full decompression before failing.
            if (!source.endsWith(".zst") || !(error instanceof ArchiveCaptureIntegrityError)) throw error;
            const savedIndex = await readJson(join(this.archives.root, "versions", `${turnId}.json`)).catch(() => { throw error; });
            if (!savedIndex) {
              await rm(codexRolloutCachePath(source, cache), { force: true });
              await stage();
            } else throw error;
          }
        }
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
      if (receipt?.version !== 1 || receipt.turnId !== this.turnId(receipt.key)) throw new Error("Native receipt is corrupt; original retained");
      receipts.push(receipt);
    }
    return receipts.sort((a, b) => (a.sequence ?? Infinity) - (b.sequence ?? Infinity) || a.endBytes - b.endBytes || a.turnId.localeCompare(b.turnId));
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
        const retry = await readJson<{ nextAt: number }>(this.retryPath(receipt.turnId));
        if (retry && retry.nextAt > Date.now()) return false;
        let parent: NativeTurnBinding | null = null;
        if (receipt.parentKey) {
          const parentId = this.turnId(receipt.parentKey);
          parent = await readJson<NativeTurnBinding>(this.acknowledgementPath(parentId));
          if (!parent) {
            const predecessor = pending.get(receipt.parentKey);
            if (!predecessor || !await visit(predecessor)) return false;
            parent = await readJson<NativeTurnBinding>(this.acknowledgementPath(parentId));
          }
          if (!parent) throw new Error("Parent binding is missing");
        }
        let request = await readJson<NativeTurnStart>(this.requestPath(receipt.turnId));
        if (!request) {
          request = nativeTurnStartSchema.parse({ turnId: receipt.turnId, sessionId: parent?.sessionId ?? binding.sessionId, parentTurnId: parent?.turnId ?? receipt.parentCloudTurnId,
            branchSessionId: nativeStableId(`${receipt.turnId}:branch`), harness: binding.harness, nativeSessionId: binding.nativeSessionId, userContent: receipt.userContent, startedAt: receipt.startedAt,
            ...(receipt.sessionStartedAt ? { sessionStartedAt: receipt.sessionStartedAt } : {}), ...(receipt.origin ? { origin: receipt.origin } : {}) });
          await atomicRuntimeJson(this.requestPath(receipt.turnId), request);
        }
        let remote = await readJson<NativeTurnBinding>(this.cloudBindingPath(receipt.turnId));
        if (!remote) {
          if (!transport.startNativeTurn) throw new Error("Native Runtime WS is unavailable");
          remote = await transport.startNativeTurn(request, { signal });
          if (remote.turnId !== receipt.turnId) throw new Error("Server Turn identity mismatch");
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
        if (!transport.completeNativeTurn) throw new Error("Native Runtime WS is unavailable");
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
          throw new Error("Native artifacts are pending; completion replays later");
        }
        await rm(backoffPath, { force: true });
        await rm(this.retryPath(receipt.turnId), { force: true });
        await atomicRuntimeJson(this.acknowledgementPath(receipt.turnId), remote);
        await rm(this.pendingPath(receipt.turnId), { force: true });
        return true;
      };
      const failures: unknown[] = [];
      for (const receipt of pending.values()) {
        if (!processed.has(receipt.key)) {
          try { await visit(receipt); }
          catch (error) {
            const previous = await readJson<{ attempt: number }>(this.retryPath(receipt.turnId));
            const attempt = Math.min((previous?.attempt ?? 0) + 1, 6);
            const base = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
            const jitter = base * (0.8 + Math.random() * 0.4);
            await atomicRuntimeJson(this.retryPath(receipt.turnId), { attempt, nextAt: Date.now() + Math.round(jitter) });
            failures.push(error);
          }
        }
      }
      // Resolve Session identities before the archive dependency walk. A fork baseline must not
      // wait for an unrelated parent Session's failed upload. Immutable local versions stay untouched.
      const archivePending = join(this.archives.root, "pending");
      let archiveBlocked = false;
      const indexes = await readdir(archivePending).catch((error) => { if (missing(error)) return []; throw error; });
      for (const name of indexes) {
        if (!name.endsWith(".json")) continue;
        try {
          const path = join(archivePending, name);
          const index = harnessArchiveIndexSchema.parse(await readJson(path));
          const retry = await readJson<{ nextAt: number }>(this.retryPath(index.turnId));
          if (retry && retry.nextAt > Date.now()) { archiveBlocked = true; continue; }
          const resolved = await this.cloudArchive(index);
          if (JSON.stringify(index) !== JSON.stringify(resolved)) await atomicRuntimeJson(path, resolved);
        } catch (error) { failures.push(error); }
      }
      this.archiveFailure = undefined;
      if (!archiveBlocked) await this.archives.flush(signal);
      if (failures.length) throw failures[0];
      if (this.archiveFailure) throw this.archiveFailure;
    }, { lockPath: join(this.root, "flush.lock") });
  }
  private async cloudArchive(index: HarnessArchiveIndex): Promise<HarnessArchiveIndex> {
    const binding = await readJson<NativeTurnBinding>(this.acknowledgementPath(index.turnId));
    if (!binding) throw new Error("Native Turn result is not confirmed");
    if (index.parentTurnId) {
      const parent = await readJson<NativeTurnBinding>(this.acknowledgementPath(index.parentTurnId));
      if (parent?.sessionId === binding.sessionId) return { ...index, sessionId: binding.sessionId };
      // Cross-Session archive parents are forbidden. Materialize a baseline using existing immutable segments.
      const segments = [...index.segments];
      const visited = new Set([index.turnId]);
      let parentId: string | null = index.parentTurnId;
      while (parentId) {
        if (visited.has(parentId)) throw new Error("Cyclic native archive");
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
