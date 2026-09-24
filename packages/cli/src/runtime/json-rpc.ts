import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { RUNTIME_MAX_FRAME_BYTES } from "@neta-art/cohub";
import { stopProcessGroup } from "./process-group.js";

export type JsonRecord = Record<string, unknown>;
export const record = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};

/** LF framing without rescanning the accumulated record on every pipe chunk. */
export class JsonLineDecoder {
  private decoder = new StringDecoder("utf8");
  private fragments: string[] = [];
  private bytes = 0;
  constructor(private onValue: (value: JsonRecord) => void, private maxBytes = RUNTIME_MAX_FRAME_BYTES) {}
  private append(fragment: string) {
    this.bytes += Buffer.byteLength(fragment);
    if (this.bytes > this.maxBytes) throw new Error("RPC frame is too large");
    this.fragments.push(fragment);
  }
  private emit() {
    const line = this.fragments.join("");
    this.fragments = []; this.bytes = 0;
    if (!line.trim()) return;
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RPC frame must be an object");
    this.onValue(value as JsonRecord);
  }
  push(chunk: Buffer) {
    const text = this.decoder.write(chunk);
    let start = 0;
    for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n", start)) {
      this.append(text.slice(start, end)); this.emit(); start = end + 1;
    }
    if (start < text.length) this.append(text.slice(start));
  }
  end() { this.append(this.decoder.end()); this.emit(); }
}

export function harnessEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COHUB_") && !["WORKER_SECRET", "DATABASE_URL", "REDIS_URL"].includes(key)));
}

export class JsonRpcProcess {
  private child: ChildProcessWithoutNullStreams;
  /** Process-group id of the harness process, for deferred cleanup confirmation. */
  get processGroupId(): number | null { return this.child.pid ?? null; }
  private pending = new Map<string, { resolve: (value: JsonRecord) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(event: JsonRecord) => void>();
  private failureListeners = new Set<(error: Error) => void>();
  private timeoutListeners = new Set<(method: string, timeoutMs: number) => void>();
  private failure: Error | null = null;
  private nextId = 0;
  private stderr = "";
  private closed: Promise<void>;
  private closing: Promise<void> | null = null;
  /** An exit the host initiated itself is an orderly end, never a failure broadcast. */
  private stopping = false;
  constructor(binary: string, args: string[], cwd: string, private mode: "pi" | "codex", context: Record<string, string> = {}) {
    this.child = spawn(binary, args, { cwd, env: { ...harnessEnvironment(), ...context }, stdio: "pipe", detached: process.platform !== "win32" });
    this.closed = new Promise((resolve) => this.child.once("close", () => resolve()));
    const decoder = new JsonLineDecoder((value) => this.receive(value));
    this.child.stdout.on("data", (chunk: Buffer) => { try { decoder.push(chunk); } catch (error) { this.fail(error); } });
    this.child.stdout.on("end", () => { try { decoder.end(); } catch (error) { this.fail(error); } });
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-8192); });
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.once("close", (code, signal) => { if (!this.stopping) this.fail(new Error(signal ? `${binary} terminated by ${signal}: ${this.stderr}` : `${binary} exited (${code}): ${this.stderr}`)); });
  }
  private fail(value: unknown) {
    if (this.failure) return;
    this.failure = value instanceof Error ? value : new Error(String(value));
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(this.failure); }
    this.pending.clear();
    for (const listener of this.failureListeners) listener(this.failure);
  }
  private receive(value: JsonRecord) {
    const key = value.id == null ? null : String(value.id);
    const response = this.mode === "pi" ? value.type === "response" : "result" in value || "error" in value;
    if (key && response) {
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key); clearTimeout(pending.timer);
      if (value.error || value.success === false) pending.reject(new Error(typeof value.error === "string" ? value.error : String(record(value.error).message ?? "RPC request failed")));
      else pending.resolve(record(this.mode === "pi" ? value.data : value.result));
      return;
    }
    for (const listener of this.listeners) listener(value);
  }
  write(value: unknown) {
    if (this.failure) throw this.failure;
    const data = `${JSON.stringify(value)}\n`;
    if (this.child.stdin.writableLength + Buffer.byteLength(data) > RUNTIME_MAX_FRAME_BYTES) throw new Error("RPC input backpressure limit exceeded");
    this.child.stdin.write(data);
  }
  request(method: string, params: JsonRecord = {}, timeoutMs = 30_000): Promise<JsonRecord> {
    if (this.failure) return Promise.reject(this.failure);
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        for (const listener of this.timeoutListeners) listener(method, timeoutMs);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write(this.mode === "pi" ? { ...params, id, type: method } : { id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  onEvent(listener: (event: JsonRecord) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onFailure(listener: (error: Error) => void) {
    this.failureListeners.add(listener);
    if (this.failure) queueMicrotask(() => { if (this.failure && this.failureListeners.has(listener)) listener(this.failure); });
    return () => this.failureListeners.delete(listener);
  }
  onTimeout(listener: (method: string, timeoutMs: number) => void) {
    this.timeoutListeners.add(listener);
    return () => this.timeoutListeners.delete(listener);
  }
  close(): Promise<void> {
    this.closing ??= this.closeProcessGroup();
    return this.closing;
  }
  private async closeProcessGroup() {
    this.stopping = true;
    try {
      if (this.child.pid) await stopProcessGroup(this.child.pid);
    } finally {
      this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
      this.fail(new Error("RPC process closed"));
      this.listeners.clear(); this.failureListeners.clear(); this.timeoutListeners.clear();
    }
    await this.closed;
  }
}
