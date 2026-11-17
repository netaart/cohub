// Cohub control bridge for Pi. Self-contained: Node built-ins only, so it installs as one file.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
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
/** A prompt whose run never starts (an input handler took it) stops holding the session after this. */
const START_GRACE_MS = 10_000;

const MESSAGE_FIELDS = ["message", "assistantMessageEvent"];
const TOOL_FIELDS = ["toolCallId", "toolName", "args", "result", "partialResult", "isError"];
/**
 * Streamed events the daemon uses, with the fields it reads; everything else Pi emits stays local.
 * An allowlist, since Pi adds fields across versions, some with the whole context (`turn_end`).
 */
const FORWARDED: Record<string, string[]> = {
  agent_start: [], agent_end: ["willRetry"], agent_settled: [], turn_start: [], turn_end: ["message", "toolResults"],
  message_start: MESSAGE_FIELDS, message_update: MESSAGE_FIELDS, message_end: MESSAGE_FIELDS,
  tool_execution_start: TOOL_FIELDS, tool_execution_update: TOOL_FIELDS, tool_execution_end: TOOL_FIELDS,
};

export function forwardedEvent(name: string, event: unknown): Record<string, unknown> {
  const source = (event ?? {}) as Record<string, unknown>;
  const forwarded: Record<string, unknown> = { type: name };
  for (const field of FORWARDED[name] ?? []) if (field in source) forwarded[field] = source[field];
  return forwarded;
}

/** Pi calls this with its extension API only; `open` is for tests. */
export default function cohub(pi: Pi, open: (endpoint: string) => Socket = connect) {
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
  // `sendUserMessage` starts its run asynchronously and reports a refusal to Pi, not here. Until
  // `agent_start` Pi still reports idle, so a second prompt would be accepted and then dropped.
  let starting: ReturnType<typeof setTimeout> | null = null;
  const hold = () => { starting = setTimeout(started, START_GRACE_MS); starting.unref?.(); };
  const started = () => { if (starting) clearTimeout(starting); starting = null; };
  const busy = (ctx: PiContext) => starting !== null || !ctx.isIdle();
  const send = (message: unknown) => { if (socket && !socket.destroyed) socket.write(`${JSON.stringify(message)}\n`); };

  const run = async (command: Command) => {
    if (!context) throw new Error("Pi session is not ready");
    if (command.type === "abort") { context.abort(); return { idle: context.isIdle() }; }
    if (command.type === "context") { applyEnvironment(command.env); return { idle: context.isIdle() }; }
    const idle = !busy(context);
    // A Cohub Turn is a Turn of its own. If the terminal user started one first, nothing is written
    // and Cohub waits for it to settle: queued behind it, the marker and the events would
    // interleave.
    if (command.turnId && !idle) return { idle, accepted: false };
    // Claim the session before the first await, so a Turn arriving meanwhile cannot switch this
    // run's model and is refused instead.
    const claimed = Boolean(command.turnId) && idle;
    if (claimed) hold();
    try {
      if (idle && command.model && context.modelRegistry && pi.setModel) {
        const model = context.modelRegistry.find(command.model.provider, command.model.id);
        if (!model || !await pi.setModel(model)) throw new Error("Model is unavailable in this Pi");
      }
      if (idle && command.thinkingLevel && pi.setThinkingLevel) pi.setThinkingLevel(command.thinkingLevel);
      // Choosing the model awaited; the terminal may have started meanwhile. Our own claim is not a
      // reason to refuse.
      if (command.turnId && !context.isIdle()) {
        if (claimed) started();
        return { idle: false, accepted: false };
      }
      // The marker precedes the user message, so the transcript itself records which cloud Turn it is.
      applyEnvironment(command.env);
      if (command.turnId) pi.appendEntry("cohub.turn", { turnId: command.turnId });
      const startsRun = claimed || !busy(context);
      if (startsRun && !claimed) hold();
      pi.sendUserMessage(command.content, startsRun ? undefined : { deliverAs: command.deliverAs ?? "followUp" });
      return { idle, accepted: true };
    } catch (error) {
      if (claimed) started();
      throw error;
    }
  };

  const attach = (ctx: PiContext) => {
    context = ctx;
    if (socket && !socket.destroyed) return;
    if (Date.now() - probedAt < RECONNECT_MS) return;
    probedAt = Date.now();
    const path = locateSocket(ctx.cwd);
    if (!path) return;
    // On Windows the socket file names the Runtime's private named pipe.
    let endpoint = path;
    if (process.platform === "win32") {
      try { endpoint = readFileSync(path, "utf8").trim(); } catch { return; }
    }
    const current = open(endpoint);
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
  pi.on("agent_start", started);
  for (const name of Object.keys(FORWARDED)) {
    pi.on(name, (event, ctx) => {
      context = ctx;
      if (!socket) attach(ctx);
      send({ type: "event", sessionId: ctx.sessionManager.getSessionId(), event: forwardedEvent(name, event) });
    });
  }
  // Pi replaces this instance on /new, /resume, /fork and /reload, and loads the next one only
  // after this shutdown; the next instance attaches with its own session.
  pi.on("session_shutdown", () => {
    if (retry) clearTimeout(retry);
    retry = null;
    started();
    socket?.end();
    socket = null;
    context = null;
    globals[marker] = false;
  });
}
