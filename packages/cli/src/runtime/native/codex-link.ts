import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { harnessEnvironment, type JsonRpcProcess, record, type JsonRecord } from "../json-rpc.js";
import { atLeast, harnessVersion, type Version } from "./version.js";

/** First Codex release whose terminal client attaches to a shared app-server by default. */
export const CODEX_SHARED_MIN_VERSION: Version = [0, 156, 0];

const REQUEST_TIMEOUT_MS = 60_000;
const JOIN_ATTEMPTS = 20;
const JOIN_RETRY_MS = 100;
/** `codex app-server daemon start` returns once the server listens; anything slower has failed. */
const DAEMON_START_TIMEOUT_MS = 30_000;

export type CodexEvent = { method: string; params: JsonRecord };

/** One JSON-RPC peer of an app-server, over either a shared control socket or a private stdio process. */
export interface CodexChannel {
  request(method: string, params?: JsonRecord, timeoutMs?: number): Promise<JsonRecord>;
  refuse(id: string | number, message: string): void;
  onEvent(listener: (event: CodexEvent & { id?: string | number }) => void): () => void;
  onClose(listener: (error: Error) => void): () => void;
  close(): Promise<void>;
  readonly shared: boolean;
  readonly closed: boolean;
}

const codexHome = () => process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
/** The socket every Codex client on this machine discovers; a terminal `codex` attaches to it. */
const codexControlSocket = () => join(codexHome(), "app-server-control", "app-server-control.sock");

export const supportsSharedServer = (version: Version | null) => atLeast(version, CODEX_SHARED_MIN_VERSION);

/** Start the shared app-server when none is running. */
async function ensureSharedServer(binary: string, cwd: string): Promise<boolean> {
  if (existsSync(codexControlSocket()) && await probe()) return true;
  const child = spawn(binary, ["app-server", "daemon", "start"], { cwd, env: harnessEnvironment(), stdio: ["ignore", "pipe", "ignore"], detached: true });
  let output = "";
  child.stdout.on("data", (bytes: Buffer) => { output += bytes.toString("utf8"); });
  // `exit`, not `close`: the server it forks may inherit stdout and keep the pipe open for good.
  const timer = setTimeout(() => child.kill(), DAEMON_START_TIMEOUT_MS);
  const ended = new Promise<void>((resolve) => child.stdout.once("end", resolve));
  const code = await new Promise<number | null>((resolve) => { child.once("exit", resolve); child.once("error", () => resolve(null)); })
    .finally(() => clearTimeout(timer));
  // Its last output may still be buffered when it exits; a pipe that stays open is let go.
  await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 1_000).unref())]);
  child.stdout.destroy();
  if (code !== 0) return false;
  try { return ["started", "alreadyRunning", "already_running"].includes(String(JSON.parse(output.trim().split("\n").at(-1) ?? "{}").status)) && await probe(); }
  catch { return false; }
}

async function probe(): Promise<boolean> {
  try {
    const channel = await openShared();
    await channel.close();
    return true;
  } catch { return false; }
}

async function openShared(): Promise<CodexChannel> {
  const socket = new WebSocket(`ws+unix://${codexControlSocket()}:/`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const channel = new SocketChannel(socket);
  await initialize(channel);
  return channel;
}

/** A private app-server over stdio, used when no shared one is available; it lives for one Turn. */
export async function openPrivateServer(rpc: JsonRpcProcess): Promise<CodexChannel> {
  const channel = new StdioChannel(rpc);
  await initialize(channel);
  return channel;
}

/** The Runtime's connection to the shared app-server. */
export class CodexShared {
  private channel: CodexChannel | null = null;
  private opening: Promise<CodexChannel | null> | null = null;
  private ensured = false;
  private readonly connectListeners = new Set<(channel: CodexChannel) => void>();
  readonly driving = new Set<string>();

  constructor(private readonly binary: string, private readonly cwd: string, public enabled: boolean) {}

  async get(): Promise<CodexChannel | null> {
    if (!this.enabled) return null;
    if (this.channel && !this.channel.closed) return this.channel;
    this.opening ??= (async () => {
      if (!this.ensured) {
        this.ensured = true;
        if (!supportsSharedServer(await harnessVersion(this.binary)) || !await ensureSharedServer(this.binary, this.cwd)) return null;
      }
      const channel = await openShared();
      this.channel = channel;
      for (const listener of this.connectListeners) listener(channel);
      return channel;
    })().catch(() => null).finally(() => { this.opening = null; });
    return await this.opening;
  }

  onConnect(listener: (channel: CodexChannel) => void): () => void {
    this.connectListeners.add(listener);
    return () => { this.connectListeners.delete(listener); };
  }

  async join(threadId: string): Promise<JsonRecord | null> {
    const channel = await this.get();
    return channel ? await joinThread(channel, threadId) : null;
  }

  async interrupt(threadId: string, turnId: string): Promise<boolean> {
    const channel = await this.get();
    if (!channel) return false;
    await joinThread(channel, threadId);
    await channel.request("turn/interrupt", { threadId, turnId });
    return true;
  }

  async close(): Promise<void> {
    await this.channel?.close();
    this.channel = null;
  }
}

async function initialize(channel: CodexChannel) {
  await channel.request("initialize", { clientInfo: { name: "cohub-runtime", title: "Cohub", version: "1" }, capabilities: { experimentalApi: true } });
  // The notification completes the handshake; responses are not expected.
  (channel as SocketChannel | StdioChannel).notify("initialized");
}

class SocketChannel implements CodexChannel {
  readonly shared = true;
  private readonly pending = new Map<string, { resolve: (value: JsonRecord) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners = new Set<(event: CodexEvent & { id?: string | number }) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private counter = 0;
  private closedError: Error | null = null;

  constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      let message: JsonRecord;
      try { message = record(JSON.parse(String(data))); } catch { return; }
      const id = message.id;
      if (id != null && ("result" in message || "error" in message)) {
        const pending = this.pending.get(String(id));
        if (!pending) return;
        this.pending.delete(String(id));
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(String(record(message.error).message ?? "Codex request failed")));
        else pending.resolve(record(message.result));
        return;
      }
      if (typeof message.method !== "string") return;
      const event = { method: message.method, params: record(message.params), ...(id != null ? { id: id as string | number } : {}) };
      for (const listener of this.listeners) listener(event);
    });
    socket.on("close", () => this.fail(new Error("Codex app-server disconnected")));
    socket.on("error", (error) => this.fail(error instanceof Error ? error : new Error(String(error))));
  }

  get closed() { return this.closedError !== null; }

  private fail(error: Error) {
    if (this.closedError) return;
    this.closedError = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
  }

  request(method: string, params: JsonRecord = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<JsonRecord> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = `cohub-${++this.counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  notify(method: string, params: JsonRecord = {}) { this.socket.send(JSON.stringify({ method, params })); }
  refuse(id: string | number, message: string) { if (!this.closedError) this.socket.send(JSON.stringify({ id, error: { code: -32000, message } })); }
  onEvent(listener: (event: CodexEvent & { id?: string | number }) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onClose(listener: (error: Error) => void) {
    if (this.closedError) { const error = this.closedError; queueMicrotask(() => listener(error)); return () => undefined; }
    this.closeListeners.add(listener);
    return () => { this.closeListeners.delete(listener); };
  }
  async close() { this.fail(new Error("Codex app-server connection closed")); this.socket.close(); }
}

class StdioChannel implements CodexChannel {
  readonly shared = false;
  private failed = false;
  constructor(private readonly rpc: JsonRpcProcess) { rpc.onFailure(() => { this.failed = true; }); }
  get closed() { return this.failed; }
  request(method: string, params: JsonRecord = {}, timeoutMs?: number) { return this.rpc.request(method, params, timeoutMs); }
  notify(method: string, params: JsonRecord = {}) { this.rpc.write({ method, params }); }
  refuse(id: string | number, message: string) { try { this.rpc.write({ id, error: { code: -32000, message } }); } catch { /* The process is gone. */ } }
  onClose(listener: (error: Error) => void) { return this.rpc.onFailure(listener); }
  onEvent(listener: (event: CodexEvent & { id?: string | number }) => void) {
    return this.rpc.onEvent((event) => {
      if (typeof event.method !== "string") return;
      listener({ method: event.method, params: record(event.params), ...(event.id != null ? { id: event.id as string | number } : {}) });
    });
  }
  async close() { await this.rpc.close(); }
}

/**
 * Join a thread that another client runs. A thread's rollout is written when its first Turn starts,
 * so a join that arrives a moment early is retried briefly instead of failing the observation.
 */
async function joinThread(channel: CodexChannel, threadId: string): Promise<JsonRecord> {
  let lastError: unknown;
  for (let attempt = 0; attempt < JOIN_ATTEMPTS; attempt += 1) {
    try { return await channel.request("thread/resume", { threadId }); }
    catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, JOIN_RETRY_MS)); }
  }
  throw lastError instanceof Error ? lastError : new Error("Cannot join the Codex thread");
}
