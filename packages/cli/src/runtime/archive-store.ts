import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, link } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  RUNTIME_ARCHIVE_SEGMENT_BYTES, harnessArchiveIndexSchema, validateArchiveBoundary,
  type HarnessArchive, type HarnessArchiveIndex, type RuntimeArchivePage, type RuntimeArchiveUpload,
} from "@neta-art/cohub";

export type ArchiveTransport = {
  fetchObject?: typeof fetch;
  prepareRuntimeArchive(index: HarnessArchiveIndex, options?: { signal?: AbortSignal }): Promise<{ uploads: RuntimeArchiveUpload[] }>;
  commitRuntimeArchive(index: HarnessArchiveIndex, options?: { signal?: AbortSignal }): Promise<{ ready: true }>;
  getRuntimeArchive(sessionId: string, turnId: string, options?: { signal?: AbortSignal }): Promise<RuntimeArchivePage>;
};
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const hash = (bytes: Uint8Array, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
export async function checksumNativeFile(path: string) {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest("hex");
}

export async function atomicRuntimeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await rm(temporary, { force: true }); }
}

/** Immutable local segments are the outbox. Model acknowledgements never remove them. */
export class RuntimeArchiveStore {
  private flushing: Promise<void> | null = null;
  private readonly capturing = new Map<string, Promise<HarnessArchive>>();
  private errorReporter: ((error: unknown, index?: HarnessArchiveIndex) => void) | null = null;
  constructor(readonly root: string, private readonly transport?: ArchiveTransport) {}
  setErrorReporter(reporter: ((error: unknown, index?: HarnessArchiveIndex) => void) | null): void {
    this.errorReporter = reporter;
  }
  async pendingCount() {
    const pending = new Set<string>();
    for (const directory of ["pending", "captures"]) {
      const names = await readdir(join(this.root, directory)).catch((error) => { if (missing(error)) return []; throw error; });
      for (const name of names) if (name.endsWith(".json")) pending.add(name);
    }
    return pending.size;
  }
  async failedCaptureCount() {
    const names = await readdir(join(this.root, "failed", "captures")).catch((error) => { if (missing(error)) return []; throw error; });
    return names.filter((name) => name.endsWith(".json")).length;
  }
  async hasCapture(turnId: string) { return Boolean(await this.readIndex(this.version(turnId))); }
  private version(turnId: string) { return join(this.root, "versions", `${turnId}.json`); }
  private blob(sha: string) { return join(this.root, "objects", sha); }
  private async saveBlob(sha: string, bytes: Uint8Array) {
    await mkdir(join(this.root, "objects"), { recursive: true, mode: 0o700 });
    const target = this.blob(sha), temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const output = await open(temporary, "wx", 0o600);
      try { await output.writeFile(bytes); await output.sync(); } finally { await output.close(); }
      await link(temporary, target).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    } finally { await rm(temporary, { force: true }); }
  }
  private async readIndex(path: string) {
    try { return harnessArchiveIndexSchema.parse(JSON.parse(await readFile(path, "utf8"))); }
    catch (error) { if (missing(error)) return null; throw error; }
  }
  stage(state: { sessionId: string; harness: "pi" | "codex"; nativeSessionId: string; path: string; sizeBytes?: number; expectedChecksum?: string }, turnId: string): Promise<HarnessArchive> {
    const existing = this.capturing.get(turnId);
    if (existing) return existing;
    const task = this.capture(state, turnId).finally(() => this.capturing.delete(turnId));
    this.capturing.set(turnId, task);
    return task;
  }
  private async capture(state: { sessionId: string; harness: "pi" | "codex"; nativeSessionId: string; path: string; sizeBytes?: number; expectedChecksum?: string }, turnId: string): Promise<HarnessArchive> {
    const identity = { sessionId: state.sessionId, turnId, harness: state.harness };
    const headPath = join(this.root, "heads", `${state.sessionId}.${state.harness}.json`);
    const saved = await this.readIndex(this.version(turnId));
    if (saved) {
      if (saved.sessionId !== state.sessionId || saved.harness !== state.harness) throw new Error("Archive identity mismatch");
      if (state.expectedChecksum && state.expectedChecksum !== saved.sha256) throw new Error("Native Turn bytes changed; original archive retained");
      const committed = await stat(join(this.root, "ready", `${turnId}.json`)).catch((error) => { if (missing(error)) return null; throw error; });
      if (!committed) await atomicRuntimeJson(join(this.root, "pending", `${turnId}.json`), saved);
      if (!await this.readIndex(headPath)) await atomicRuntimeJson(headPath, saved);
      return identity;
    }
    const previous = await this.readIndex(headPath);
    const file = await open(state.path, "r");
    let index: HarnessArchiveIndex;
    try {
      const before = await file.stat();
      if (!before.isFile() || !before.size) throw new Error("Native archive is empty");
      const sizeBytes = state.sizeBytes ?? before.size;
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > before.size) throw new Error("Native archive boundary is unavailable");
      const buffer = Buffer.alloc(RUNTIME_ARCHIVE_SEGMENT_BYTES);
      let offset = 0;
      let digest = createHash("sha256");
      let parent: HarnessArchiveIndex | null = null;
      // Hash the old prefix, not just its size: equal-size and growing rewrites are valid.
      if (previous && previous.nativeSessionId === state.nativeSessionId && previous.sizeBytes <= sizeBytes) {
        while (offset < previous.sizeBytes) {
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, previous.sizeBytes - offset), offset);
          if (!bytesRead) throw new Error("Native file changed during capture");
          digest.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
        }
        if (digest.copy().digest("hex") === previous.sha256) parent = previous;
      }
      if (!parent) { offset = 0; digest = createHash("sha256"); }
      const segments: HarnessArchiveIndex["segments"] = [];
      await mkdir(join(this.root, "objects"), { recursive: true, mode: 0o700 });
      while (offset < sizeBytes) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, sizeBytes - offset), offset);
        if (!bytesRead) throw new Error("Native file changed during capture");
        const bytes = buffer.subarray(0, bytesRead);
        digest.update(bytes);
        const segment = { offset, sizeBytes: bytesRead, sha256: hash(bytes), md5: hash(bytes, "md5") };
        await this.saveBlob(segment.sha256, bytes);
        segments.push(segment); offset += bytesRead;
      }
      const after = await stat(state.path);
      if (before.ino !== after.ino || after.size < sizeBytes || state.sizeBytes === undefined && (before.size !== after.size || before.mtimeMs !== after.mtimeMs)) throw new Error("Native file changed during capture");
      if (state.sizeBytes !== undefined) {
        // Native clients may append while an earlier Turn is captured. Validate the exact prefix twice.
        const verified = createHash("sha256");
        for await (const bytes of createReadStream(state.path, { end: sizeBytes - 1 })) verified.update(bytes);
        if (verified.digest("hex") !== digest.copy().digest("hex")) throw new Error("Native prefix changed during capture");
      }
      if (process.platform !== "win32") {
        const directory = await open(join(this.root, "objects"), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
      index = harnessArchiveIndexSchema.parse({ ...identity, version: 1, nativeSessionId: state.nativeSessionId,
        nativeFormat: state.harness === "pi" ? "pi.jsonl" : "codex.rollout", parentTurnId: parent?.turnId ?? null,
        sizeBytes, sha256: digest.digest("hex"), segments });
      validateArchiveBoundary(index, parent);
      if (state.expectedChecksum && index.sha256 !== state.expectedChecksum) throw new Error("Native Turn bytes changed during capture; original retained");
    } finally { await file.close(); }
    // Publish the outbox before advancing the local head. Neither points at mutable files.
    await atomicRuntimeJson(join(this.root, "pending", `${turnId}.json`), index);
    await atomicRuntimeJson(this.version(turnId), index);
    await atomicRuntimeJson(headPath, index);
    return identity;
  }
  async flush(signal: AbortSignal) {
    if (!this.transport) return;
    if (this.flushing) return this.flushing;
    this.flushing = this.drain(signal).finally(() => { this.flushing = null; });
    return this.flushing;
  }
  private async drain(signal: AbortSignal) {
    const transport = this.transport;
    if (!transport) return;
    const names = await readdir(join(this.root, "pending")).catch((error) => { if (missing(error)) return []; throw error; });
    const pending = new Map<string, HarnessArchiveIndex>();
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const index = await this.readIndex(join(this.root, "pending", name));
      if (index) pending.set(index.turnId, index);
    }
    const children = new Map<string, HarnessArchiveIndex[]>();
    const queue: HarnessArchiveIndex[] = [];
    for (const index of pending.values()) {
      if (index.parentTurnId && pending.has(index.parentTurnId)) {
        const siblings = children.get(index.parentTurnId) ?? [];
        siblings.push(index); children.set(index.parentTurnId, siblings);
      } else queue.push(index);
    }
    if (pending.size && !queue.length) throw new Error("Cyclic archive outbox");
    for (let cursor = 0; cursor < queue.length; cursor++) {
      signal.throwIfAborted();
      const index = queue[cursor];
      if (!index) continue;
      try {
        const { uploads } = await transport.prepareRuntimeArchive(index, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
        if (uploads.length > index.segments.length) throw new Error("Upload plan mismatch");
        const expected = new Set(index.segments.map((segment) => JSON.stringify(segment)));
        for (const { segment, uploadUrl, headers } of uploads) {
          if (!expected.has(JSON.stringify(segment))) throw new Error("Upload segment mismatch");
          signal.throwIfAborted();
          const bytes = await readFile(this.blob(segment.sha256));
          if (bytes.length !== segment.sizeBytes || hash(bytes) !== segment.sha256) throw new Error("Local archive segment is corrupt");
          const response = await (transport.fetchObject ?? fetch)(uploadUrl, { method: "PUT", headers, body: bytes, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
          // An immutable segment may already exist after a lost acknowledgement. Commit verifies it.
          if (!response.ok && ![409, 412].includes(response.status)) throw new Error(`Archive upload failed: ${response.status}`);
        }
        await transport.commitRuntimeArchive(index, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
        await atomicRuntimeJson(join(this.root, "ready", `${index.turnId}.json`), { turnId: index.turnId, sha256: index.sha256 });
        await rm(join(this.root, "pending", `${index.turnId}.json`), { force: true });
        queue.push(...children.get(index.turnId) ?? []);
      } catch (error) {
        if (!signal.aborted) {
          this.errorReporter?.(error, index);
        }
      }
    }
  }
  async restore(reference: HarnessArchive, target: string, signal?: AbortSignal): Promise<HarnessArchiveIndex> {
    if (!this.transport) throw new Error("Archive transport unavailable");
    const timeout = (ms: number) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
    const pages: RuntimeArchivePage[] = [];
    const visited = new Set<string>();
    let turnId: string | null = reference.turnId;
    while (turnId) {
      signal?.throwIfAborted();
      if (visited.has(turnId)) throw new Error("Cyclic archive");
      visited.add(turnId);
      const page = await this.transport.getRuntimeArchive(reference.sessionId, turnId, { signal: timeout(30_000) });
      const index = harnessArchiveIndexSchema.parse(page.index);
      if (index.turnId !== turnId || index.sessionId !== reference.sessionId || index.harness !== reference.harness) throw new Error("Archive identity mismatch");
      pages.push({ ...page, index }); turnId = index.parentTurnId;
    }
    const head = pages[0]?.index;
    if (!head) throw new Error("Archive missing");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.restoring`;
    const file = await open(temporary, "wx", 0o600);
    try {
      let parent: HarnessArchiveIndex | null = null;
      const digest = createHash("sha256");
      for (const page of pages.reverse()) {
        validateArchiveBoundary(page.index, parent);
        if (page.segments.length !== page.index.segments.length) throw new Error("Missing archive segments");
        for (const [ordinal, expected] of page.index.segments.entries()) {
          signal?.throwIfAborted();
          const cached = await readFile(this.blob(expected.sha256)).catch((error) => { if (missing(error)) return null; throw error; });
          if (cached) {
            if (cached.length !== expected.sizeBytes || hash(cached) !== expected.sha256) throw new Error("Cached archive segment is corrupt");
            digest.update(cached); await file.writeFile(cached); continue;
          }
          let link = page.segments[ordinal];
          if (!link || JSON.stringify(link.segment) !== JSON.stringify(expected)) throw new Error("Archive segment identity mismatch");
          let response = await (this.transport.fetchObject ?? fetch)(link.downloadUrl, { redirect: "error", signal: timeout(60_000) });
          if ([401, 403].includes(response.status)) {
            const refreshed = await this.transport.getRuntimeArchive(reference.sessionId, page.index.turnId, { signal: timeout(30_000) });
            link = refreshed.segments[ordinal];
            if (!link || JSON.stringify(link.segment) !== JSON.stringify(expected)) throw new Error("Archive segment missing");
            response = await (this.transport.fetchObject ?? fetch)(link.downloadUrl, { redirect: "error", signal: timeout(60_000) });
          }
          if (!response.ok || !response.body) throw new Error(`Archive download failed: ${response.status}`);
          const segmentHash = createHash("sha256"); let size = 0;
          const chunks: Uint8Array[] = [];
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > expected.sizeBytes) throw new Error("Archive size mismatch");
            chunks.push(chunk);
            segmentHash.update(chunk); digest.update(chunk); await file.writeFile(chunk);
          }
          if (size !== expected.sizeBytes || segmentHash.digest("hex") !== expected.sha256) throw new Error("Archive checksum mismatch");
          await this.saveBlob(expected.sha256, Buffer.concat(chunks));
        }
        if (digest.copy().digest("hex") !== page.index.sha256) throw new Error("Archive version checksum mismatch");
        parent = page.index;
      }
      if ((await file.stat()).size !== head.sizeBytes) throw new Error("Archive length mismatch");
      await file.sync(); await file.close();
      await link(temporary, target);
      if (process.platform !== "win32") {
        const directory = await open(dirname(target), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
      return head;
    } finally { await file.close(); await rm(temporary, { force: true }); }
  }
}
