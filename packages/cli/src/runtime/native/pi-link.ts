import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { COHUB_PI_PROTOCOL } from "./pi-extension.js";
import type { Version } from "./version.js";

const MAX_LINE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20 * 60_000;
/**
 * Oldest Pi whose extension API Cohub relies on (`agent_settled`, `appendEntry`, steer and follow-
 * up delivery).
 */
export const PI_MIN_VERSION: Version = [0, 85, 1];
/** Delivered to a session's subscribers when its Pi goes away. */
export const PI_DISCONNECTED = "cohub_disconnected";

/** A Pi process that is connected and can be driven: a terminal session or one Cohub started. */
export type PiSessionLink = {
  pid: number;
  cwd: string;
  sessionId: string;
  sessionFile: string | null;
  idle: boolean;
  settledAt: number;
};

type Live = PiSessionLink & { socket: Socket; pending: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> };

/**
 * The Pi half of the control plane. Cohub never instructs Pi through a private channel it owns: the
 * extension inside the running Pi process is the single interface, so a terminal session and one
 * Cohub started behave identically.
 */
export class PiLink {
  private server: Server | null = null;
  unavailable: string | null = null;
  private readonly sessions = new Map<string, Live>();
  private readonly listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  private counter = 0;

  constructor(private readonly options: {
    socketPath: string;
    owns: (cwd: string) => boolean;
    onEvent?: (session: PiSessionLink, event: Record<string, unknown>) => void;
    onConnect?: (session: PiSessionLink) => void;
    onDisconnect?: (session: PiSessionLink) => void;
  }) {}

  get socketPath() { return this.options.socketPath; }

  subscribe(sessionId: string, listener: (event: Record<string, unknown>) => void): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) { set = new Set(); this.listeners.set(sessionId, set); }
    set.add(listener);
    return () => { set?.delete(listener); if (!set?.size) this.listeners.delete(sessionId); };
  }

  async waitFor(match: { sessionId: string; sessionFile: string }, signal: AbortSignal, timeoutMs = 30_000): Promise<PiSessionLink> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const found = this.list().find((session) => session.sessionId === match.sessionId || session.sessionFile === match.sessionFile);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Pi did not attach to the Runtime; check that the Cohub extension loads");
  }

  async idle(sessionId: string, signal: AbortSignal): Promise<void> {
    if (this.sessions.get(sessionId)?.idle !== false) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { off(); signal.removeEventListener("abort", onAbort); if (error) reject(error); else resolve(); };
      const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      const off = this.subscribe(sessionId, (event) => {
        if (event.type === "agent_settled") finish();
        if (event.type === PI_DISCONNECTED) finish(new Error("Pi disconnected"));
      });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async listen(signal: AbortSignal): Promise<void> {
    const { socketPath } = this.options;
    // The socket accepts commands that drive the user's agent: only this user may reach it.
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(dirname(socketPath), 0o700);
    await rm(socketPath, { force: true });
    const server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.removeListener("error", reject); resolve(); });
    });
    if (process.platform !== "win32") await chmod(socketPath, 0o600);
    this.server = server;
    signal.addEventListener("abort", () => {
      for (const session of this.sessions.values()) session.socket.destroy();
      this.sessions.clear();
      server.close();
      void rm(socketPath, { force: true }).catch(() => undefined);
    }, { once: true });
  }

  list(): PiSessionLink[] {
    return [...this.sessions.values()].map(({ socket: _socket, pending: _pending, ...link }) => link);
  }

  find(sessionId: string): PiSessionLink | null {
    const live = this.sessions.get(sessionId);
    if (!live) return null;
    const { socket: _socket, pending: _pending, ...link } = live;
    return link;
  }

  isStreaming(sessionId: string): boolean | null {
    const live = this.sessions.get(sessionId);
    return live ? !live.idle : null;
  }

  async prompt(sessionId: string, input: {
    turnId?: string;
    content: unknown;
    deliverAs?: "steer" | "followUp";
    model?: { provider: string; id: string } | null;
    thinkingLevel?: string | null;
    env?: Record<string, string | null>;
  }): Promise<{ accepted: boolean }> {
    const result = await this.request(sessionId, { type: "prompt", ...input }) as { accepted?: unknown };
    // A Cohub Turn is refused while the terminal runs one of its own; nothing was written then.
    return { accepted: result?.accepted !== false };
  }

  async context(sessionId: string, env: Record<string, string | null>): Promise<void> {
    await this.request(sessionId, { type: "context", env });
  }

  async abort(sessionId: string): Promise<void> {
    await this.request(sessionId, { type: "abort" });
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) session.socket.destroy();
    this.sessions.clear();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  private request(sessionId: string, command: Record<string, unknown>): Promise<unknown> {
    const live = this.sessions.get(sessionId);
    if (!live || live.socket.destroyed) return Promise.reject(new Error("Pi is not connected"));
    const id = `cohub-${++this.counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { live.pending.delete(id); reject(new Error("Pi did not answer in time")); }, REQUEST_TIMEOUT_MS);
      live.pending.set(id, { resolve, reject, timer });
      live.socket.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  private accept(socket: Socket) {
    let buffer = "";
    /** This connection's link; a newer connection for the same session replaces it in the map. */
    let own: Live | null = null;
    socket.setNoDelay?.(true);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      if (!own) return;
      const live = own;
      for (const pending of live.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Pi disconnected")); }
      live.pending.clear();
      if (this.sessions.get(live.sessionId) !== live) return;
      this.sessions.delete(live.sessionId);
      for (const listener of this.listeners.get(live.sessionId) ?? []) listener({ type: PI_DISCONNECTED });
      const { socket: _socket, pending: _pending, ...link } = live;
      this.options.onDisconnect?.(link);
    });
    socket.on("data", (bytes) => {
      buffer += bytes.toString("utf8");
      if (buffer.length > MAX_LINE_BYTES) { socket.destroy(); return; }
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line) continue;
        let message: Record<string, unknown>;
        try { message = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (message.type === "hello") {
          // One session per connection; a Pi that switches sessions reconnects.
          const attached = own ? null : this.hello(socket, message);
          if (!attached) { socket.destroy(); return; }
          own = attached;
          continue;
        }
        const live = own && this.sessions.get(own.sessionId) === own ? own : null;
        if (!live) continue;
        if (message.type === "event") {
          const event = (message.event ?? {}) as Record<string, unknown>;
          if (event.type === "agent_start") live.idle = false;
          if (event.type === "agent_settled") { live.idle = true; live.settledAt = Date.now(); }
          const { socket: _socket, pending: _pending, ...link } = live;
          this.options.onEvent?.(link, event);
          for (const listener of this.listeners.get(live.sessionId) ?? []) listener(event);
          continue;
        }
        const id = typeof message.id === "string" ? message.id : null;
        const pending = id ? live.pending.get(id) : null;
        if (!pending || !id) continue;
        live.pending.delete(id);
        clearTimeout(pending.timer);
        if (message.type === "error") pending.reject(new Error(typeof message.message === "string" ? message.message : "Pi rejected the command"));
        else pending.resolve(message);
      }
    });
  }

  private hello(socket: Socket, message: Record<string, unknown>): Live | null {
    if (message.protocol !== COHUB_PI_PROTOCOL) return null;
    const cwd = typeof message.cwd === "string" ? message.cwd : "";
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
    const pid = typeof message.pid === "number" ? message.pid : 0;
    if (!sessionId || !this.options.owns(cwd)) return null;
    const live: Live = {
      pid, cwd, sessionId,
      sessionFile: typeof message.sessionFile === "string" ? message.sessionFile : null,
      idle: message.idle !== false,
      settledAt: message.idle !== false ? Date.now() : 0,
      socket,
      pending: new Map(),
    };
    // A Pi that reconnects after a Runtime restart replaces its stale link.
    this.sessions.get(sessionId)?.socket.destroy();
    this.sessions.set(sessionId, live);
    const { socket: _socket, pending: _pending, ...link } = live;
    this.options.onConnect?.(link);
    return live;
  }
}
