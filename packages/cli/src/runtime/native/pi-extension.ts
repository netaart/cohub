// Cohub control bridge for Pi. Self-contained: Node built-ins only, so it installs as one file.
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Bumped when the daemon and the extension must be installed together. */
export const COHUB_PI_PROTOCOL = 1;

type PiContext = {
  cwd: string;
  sessionManager: { getSessionFile(): string | undefined; getSessionId(): string };
  isIdle(): boolean;
  abort(): void;
  modelRegistry?: { find(provider: string, id: string): unknown };
};
type Content = string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
type Pi = {
  on(event: string, handler: (event: unknown, context: PiContext) => unknown): void;
  sendUserMessage(content: Content, options?: { deliverAs?: "steer" | "followUp" }): void;
  appendEntry(customType: string, data?: unknown): void;
  setModel?(model: unknown): Promise<boolean> | boolean;
  setThinkingLevel?(level: string): void;
};

/** Variables a tool call sees; `null` removes one. Set per Turn, since this Pi runs many. */
type Environment = Record<string, string | null>;
type Command =
  | { type: "prompt"; id: string; turnId?: string; content: Content; deliverAs?: "steer" | "followUp"; model?: { provider: string; id: string } | null; thinkingLevel?: string | null; env?: Environment }
  | { type: "context"; id: string; env: Environment }
  | { type: "abort"; id: string };

/** Pi's tools read the process environment when they run, so this reaches the next tool call. */
function applyEnvironment(env: Environment | undefined) {
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!key.startsWith("COHUB_")) continue;
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
}

/** Runtime directory shared with the CLI; one socket per bound directory, hashed to stay short. */
export function controlSocketPath(root: string): string {
  const state = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(state, "cohub", "control", `${createHash("sha256").update(root).digest("hex").slice(0, 32)}.sock`);
}

/** The nearest bound ancestor of `cwd`: a Runtime bound to a parent directory owns its subdirectories. */
function locateSocket(cwd: string): string | null {
  let directory: string;
  try { directory = realpathSync(cwd); } catch { return null; }
  for (;;) {
    const socket = controlSocketPath(directory);
    if (existsSync(socket)) return socket;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** How often a missing or lost Runtime is looked for again. */
const RECONNECT_MS = 3_000;

/** Streamed events the daemon uses; everything else Pi emits stays local. */
const FORWARDED = new Set(["agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end"]);

export default function cohub(pi: Pi) {
  // Cohub may load this file explicitly into a Pi it starts; never attach twice.
  const marker = Symbol.for("cohub.pi.control");
  const globals = globalThis as Record<symbol, boolean>;
  if (globals[marker]) return;
  globals[marker] = true;

  let socket: Socket | null = null;
  let context: PiContext | null = null;
  let buffer = "";
  let retry: ReturnType<typeof setTimeout> | null = null;
  let probedAt = 0;
  const send = (message: unknown) => { if (socket && !socket.destroyed) socket.write(`${JSON.stringify(message)}\n`); };

  const run = async (command: Command) => {
    if (!context) throw new Error("Pi session is not ready");
    if (command.type === "abort") { context.abort(); return { idle: context.isIdle() }; }
    if (command.type === "context") { applyEnvironment(command.env); return { idle: context.isIdle() }; }
    const idle = context.isIdle();
    // A Cohub Turn is a Turn of its own. If the terminal user started one first, nothing is written
    // and Cohub waits for it to settle: queued behind it, the marker and the events would
    // interleave.
    if (command.turnId && !idle) return { idle, accepted: false };
    if (idle && command.model && context.modelRegistry && pi.setModel) {
      const model = context.modelRegistry.find(command.model.provider, command.model.id);
      if (!model || !await pi.setModel(model)) throw new Error("Model is unavailable in this Pi");
    }
    if (idle && command.thinkingLevel && pi.setThinkingLevel) pi.setThinkingLevel(command.thinkingLevel);
    // Choosing the model awaited; the terminal may have started meanwhile.
    if (command.turnId && !context.isIdle()) return { idle: false, accepted: false };
    // The marker precedes the user message, so the transcript itself records which cloud Turn it is.
    applyEnvironment(command.env);
    if (command.turnId) pi.appendEntry("cohub.turn", { turnId: command.turnId });
    pi.sendUserMessage(command.content, idle ? undefined : { deliverAs: command.deliverAs ?? "followUp" });
    return { idle, accepted: true };
  };

  const attach = (ctx: PiContext) => {
    context = ctx;
    if (socket && !socket.destroyed) return;
    if (Date.now() - probedAt < RECONNECT_MS) return;
    probedAt = Date.now();
    const path = locateSocket(ctx.cwd);
    if (!path) return;
    const current = connect(path);
    socket = current;
    buffer = "";
    current.on("connect", () => send({
      type: "hello", protocol: COHUB_PI_PROTOCOL, pid: process.pid, cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() ?? null, idle: ctx.isIdle(),
    }));
    current.on("data", (bytes) => {
      buffer += bytes.toString("utf8");
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line) continue;
        let command: Command;
        try { command = JSON.parse(line) as Command; } catch { continue; }
        run(command).then((result) => send({ type: "result", id: command.id, ...result }), (error: unknown) => send({ type: "error", id: command.id, message: error instanceof Error ? error.message : String(error) }));
      }
    });
    // A Runtime that restarts is reached again on the next event; nothing is buffered meanwhile.
    current.on("error", () => undefined);
    current.on("close", () => {
      if (socket === current) socket = null;
      retry ??= setTimeout(() => { retry = null; if (context) attach(context); }, RECONNECT_MS);
      retry.unref?.();
    });
  };

  pi.on("session_start", (_event, ctx) => attach(ctx));
  for (const name of FORWARDED) {
    pi.on(name, (event, ctx) => {
      context = ctx;
      if (!socket) attach(ctx);
      send({ type: "event", sessionId: ctx.sessionManager.getSessionId(), event: { ...(event as object), type: name } });
    });
  }
  // Pi replaces this instance on /new, /resume, /fork and /reload, and loads the next one only
  // after this shutdown; the next instance attaches with its own session.
  pi.on("session_shutdown", () => {
    if (retry) clearTimeout(retry);
    retry = null;
    socket?.end();
    socket = null;
    context = null;
    globals[marker] = false;
  });
}
