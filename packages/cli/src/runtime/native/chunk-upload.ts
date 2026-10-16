import { createHash } from "node:crypto";

const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_BYTES = 256 * 1024 * 1024;
const ACK_TIMEOUT_MS = 30_000;
type ChunkFrame = { type: "runtime.native.chunk"; requestId: string; index: number; totalBytes: number; sha256: string; data: string };
type Pending = { index: number; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** One acknowledged upload per connection; reconnects retry the original durable event. */
export class NativeChunkUploads {
  private tail: Promise<void> = Promise.resolve();
  private pending = new Map<string, Pending>();
  private failures = new Map<string, Error>();
  private requests = new Set<string>();
  private completions = new Map<string, { resolve: () => void; lastIndex: number; acknowledged: boolean }>();
  private closed: Error | null = null;
  constructor(private send: (frame: ChunkFrame) => void, private onInterrupted: () => void) {}

  private interrupt(requestId: string, error: Error): void {
    this.fail(requestId, error);
    // The gateway may still hold a partial upload; only a fresh connection can safely retry it.
    this.onInterrupted();
  }

  upload(requestId: string, bytes: Buffer): Promise<void> {
    if (bytes.length > MAX_BYTES) return Promise.reject(new Error(`Native completion exceeds chunk upload limit (${bytes.length} > ${MAX_BYTES} bytes); original transcript retained`));
    this.requests.add(requestId);
    const transfer = async () => {
      const initialFailure = this.closed ?? this.failures.get(requestId);
      if (initialFailure) throw initialFailure;
      let finish!: () => void;
      const completed = new Promise<void>(resolve => { finish = resolve; });
      this.completions.set(requestId, { resolve: finish, lastIndex: Math.ceil(bytes.length / CHUNK_BYTES) - 1, acknowledged: false });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      for (let from = 0, index = 0; from < bytes.length; from += CHUNK_BYTES, index++) {
        const failure = this.closed ?? this.failures.get(requestId);
        if (failure) throw failure;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => this.interrupt(requestId, new Error("Native chunk acknowledgement timed out")), ACK_TIMEOUT_MS);
          this.pending.set(requestId, { index, resolve, reject, timer });
          try { this.send({ type: "runtime.native.chunk", requestId, index, totalBytes: bytes.length, sha256, data: bytes.subarray(from, from + CHUNK_BYTES).toString("base64") }); }
          catch (error) { this.interrupt(requestId, error instanceof Error ? error : new Error(String(error))); }
        });
      }
      // The gateway processes completions in order; queueing another upload before its durable
      // result would put the next acknowledgement behind a potentially slow database write.
      await completed;
      const failure = this.closed ?? this.failures.get(requestId);
      if (failure) throw failure;
    };
    // A previous caller receives its own failure; that failure must not strand the next request.
    const uploaded = this.tail.then(transfer, transfer).finally(() => { this.requests.delete(requestId); this.failures.delete(requestId); this.completions.delete(requestId); });
    this.tail = uploaded;
    return uploaded;
  }

  acknowledge(requestId: string, index: unknown): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    if (index !== pending.index) { this.interrupt(requestId, new Error("Native chunk acknowledgement index is out of order")); return; }
    const completion = this.completions.get(requestId);
    if (completion && index === completion.lastIndex) completion.acknowledged = true;
    clearTimeout(pending.timer); this.pending.delete(requestId); pending.resolve();
  }

  complete(requestId: string): Error | null {
    if (!this.requests.has(requestId)) return null;
    const completion = this.completions.get(requestId);
    if (!completion?.acknowledged) {
      const error = new Error("Native upload result arrived before all chunk acknowledgements");
      this.interrupt(requestId, error);
      return error;
    }
    completion.resolve();
    return null;
  }

  fail(requestId: string, error: Error): void {
    if (this.requests.has(requestId)) this.failures.set(requestId, error);
    this.completions.get(requestId)?.resolve();
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(requestId); pending.reject(error);
  }

  close(error: Error): void {
    this.closed = error;
    for (const requestId of this.requests) this.fail(requestId, error);
  }
}
