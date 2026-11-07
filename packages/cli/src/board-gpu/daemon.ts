import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { type BoardGpuExporter, type BoardGpuResources, launchBoardGpuExporter } from "./index.js";
import type { BoardGpuResult } from "./protocol.js";
import { CLI_VERSION } from "../version.js";
import { packagePath } from "../package-paths.js";


const IDLE_MS = 5 * 60_000;
const CONNECT_MS = 20_000;
const TURN_MS = 20_000;

type Picture = { bytes: Uint8Array; mimeType: string } | null;
type Ask = { kind: "module"; path: string } | { kind: "picture"; request: Parameters<BoardGpuResources["readPicture"]>[0] };
type Message =
  | { id: number; method: Method; params?: unknown }
  | { id: number; result?: unknown; error?: string }
  | { ask: number; request: Ask }
  | { answer: number; text?: string; bytes?: string; mimeType?: string; missing?: boolean; error?: string }
  | { granted: true };
type Method = "init" | "render" | "compile" | "profile";

function lines(socket: Socket, handle: (message: Message) => void) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        continue;
      }
      handle(message);
    }
  });
  return (message: Message) => socket.write(`${JSON.stringify(message)}\n`);
}

export function boardGpuSocket(browser: string): string {
  let page = 0;
  try {
    page = statSync(packagePath("dist", "board-gpu", "page.js")).mtimeMs;
  } catch {}
  const { uid } = userInfo();
  const key = createHash("sha256").update(`${CLI_VERSION}\0${browser}\0${page}\0${uid}`).digest("hex").slice(0, 16);
  if (process.platform === "win32") return join("\\\\.\\pipe", `cohub-board-gpu-${key}`);
  const dir = join(process.env.XDG_RUNTIME_DIR || tmpdir(), `cohub-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) throw new Error(`${dir} is not private to this user.`);
  return join(dir, `board-gpu-${key}.sock`);
}

export async function serveBoardGpu(browser: string): Promise<void> {
  const path = boardGpuSocket(browser);
  type Caller = {
    send: (message: Message) => void;
    asks: Map<number, (message: Extract<Message, { answer: number }>) => void>;
    running: number;
    gone: boolean;
  };
  const queue: Caller[] = [];
  let exporter: Promise<BoardGpuExporter> | null = null;
  let nextAsk = 0;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const active = () => queue[0] ?? null;

  const ask = (request: Ask) => new Promise<Extract<Message, { answer: number }>>((resolve, reject) => {
    const caller = active();
    if (!caller || caller.gone) return reject(new Error("The caller left."));
    const id = ++nextAsk;
    caller.asks.set(id, resolve);
    caller.send({ ask: id, request });
  });
  const resources: BoardGpuResources = {
    fonts: [],
    async readModule(path) {
      const answer = await ask({ kind: "module", path });
      if (answer.error !== undefined || answer.text === undefined) throw new Error(answer.error ?? `${path} is not available.`);
      return answer.text;
    },
    async readPicture(request) {
      const answer = await ask({ kind: "picture", request });
      if (answer.error !== undefined) throw new Error(answer.error);
      return answer.bytes === undefined ? null : { bytes: Buffer.from(answer.bytes, "base64"), mimeType: answer.mimeType ?? "application/octet-stream" };
    },
  };
  const { resolveBundledFonts } = await import("../board-export.js");
  resources.fonts = resolveBundledFonts().flatMap(({ path, family }) => (family ? [{ path, family }] : []));

  const browserFor = () => (exporter ??= launchBoardGpuExporter(resources, { browser }).catch((error: unknown) => {
    exporter = null;
    throw error;
  }));
  const reset = async () => {
    const current = exporter;
    exporter = null;
    await current?.then((value) => value.close(), () => {});
  };
  const shutdown = async () => {
    await reset();
    server.close();
    process.exit(0);
  };
  const schedule = () => {
    if (idle) clearTimeout(idle);
    idle = queue.length ? null : setTimeout(() => void shutdown(), IDLE_MS);
  };
  const advance = () => {
    active()?.send({ granted: true });
    schedule();
  };
  const release = (caller: Caller) => {
    if (!caller.gone || caller.running) return;
    const index = queue.indexOf(caller);
    if (index < 0) return;
    queue.splice(index, 1);
    if (index === 0) advance();
  };

  const server = createServer((socket) => {
    const caller: Caller = { send: () => {}, asks: new Map(), running: 0, gone: false };
    caller.send = lines(socket, (message) => {
      if ("answer" in message) {
        caller.asks.get(message.answer)?.(message);
        caller.asks.delete(message.answer);
        return;
      }
      if (!("method" in message) || active() !== caller) return;
      caller.running++;
      void browserFor()
        .then((gpu) => call(gpu, message.method, message.params))
        .then((result) => caller.send({ id: message.id, result }), async (error: unknown) => {
          const text = error instanceof Error ? error.message : String(error);
          if (/stopped responding|browser (stopped|closed)|did not start/i.test(text)) await reset();
          caller.send({ id: message.id, error: text });
        })
        .finally(() => {
          caller.running--;
          release(caller);
        });
    });
    const leave = () => {
      if (caller.gone) return;
      caller.gone = true;
      for (const resolve of caller.asks.values()) resolve({ answer: -1, error: "The caller left." });
      caller.asks.clear();
      release(caller);
    };
    socket.on("close", leave);
    socket.on("error", leave);
    queue.push(caller);
    if (queue.length === 1) advance();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EADDRINUSE") return reject(error);
      const alive = await new Promise<boolean>((done) => {
        const probe = createConnection(path, () => { probe.destroy(); done(true); });
        probe.once("error", () => done(false));
      });
      if (alive) return process.exit(0);
      try { unlinkSync(path); } catch {}
      server.listen(path, resolve);
    });
    server.listen(path, resolve);
  });
  process.on("SIGTERM", () => void shutdown());
  schedule();
}

function call(gpu: BoardGpuExporter, method: Method, params: unknown): Promise<unknown> {
  switch (method) {
    case "init": return gpu.init(params as Parameters<BoardGpuExporter["init"]>[0]);
    case "compile": return gpu.compile(params as Parameters<BoardGpuExporter["compile"]>[0]);
    case "profile": return gpu.profile(params as Parameters<BoardGpuExporter["profile"]>[0]);
    case "render": return gpu.render(params as Parameters<BoardGpuExporter["render"]>[0]).then(({ bytes, ...rest }) => ({ ...rest, data: Buffer.from(bytes).toString("base64") }));
  }
}

function startDaemon(browser: string) {
  const entry = process.argv[1];
  if (!entry) throw new Error("The CLI entry point is unknown.");
  spawn(process.execPath, [...process.execArgv, entry, "boards", "gpu-daemon", "--browser", browser], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  }).unref();
}

function connect(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path, () => resolve(socket));
    socket.once("error", reject);
  });
}

export async function connectBoardGpu(resources: BoardGpuResources, options: { browser: string; signal?: AbortSignal }): Promise<BoardGpuExporter | null> {
  if (process.env.COHUB_BOARD_GPU_DAEMON === "0") return null;
  const path = boardGpuSocket(options.browser);
  let socket = await connect(path).catch(() => null);
  if (!socket) {
    try {
      startDaemon(options.browser);
    } catch {
      return null;
    }
    for (const started = Date.now(); !socket && Date.now() - started < CONNECT_MS;) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      socket = await connect(path).catch(() => null);
    }
    if (!socket) return null;
  }
  const connected = socket;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let next = 0;
  let granted: (ok: boolean) => void = () => {};
  const turn = new Promise<boolean>((resolve) => { granted = resolve; });
  const fail = (error: Error) => {
    granted(false);
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
  };
  const send = lines(connected, (message) => {
    if ("granted" in message) return granted(true);
    if ("ask" in message) {
      void answer(message.request).then((reply) => send({ answer: message.ask, ...reply }));
      return;
    }
    if ("id" in message && !("method" in message)) {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.error !== undefined) waiting?.reject(new Error(message.error));
      else waiting?.resolve(message.result);
    }
  });
  connected.on("close", () => fail(new Error("The shared browser closed.")));
  connected.on("error", (error) => fail(error));
  options.signal?.addEventListener("abort", () => connected.destroy(), { once: true });
  const timer = setTimeout(() => granted(false), TURN_MS);
  const ours = await turn;
  clearTimeout(timer);
  if (!ours) {
    connected.destroy();
    return null;
  }

  async function answer(request: Ask): Promise<Omit<Extract<Message, { answer: number }>, "answer">> {
    try {
      if (request.kind === "module") return { text: await resources.readModule(request.path) };
      const picture: Picture = await resources.readPicture(request.request);
      return picture ? { bytes: Buffer.from(picture.bytes).toString("base64"), mimeType: picture.mimeType } : { missing: true };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  const request = <T>(method: Method, params: unknown): Promise<T> => {
    if (connected.destroyed) return Promise.reject(new Error("The shared browser closed."));
    const id = ++next;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      send({ id, method, params });
    });
  };
  return {
    browser: options.browser,
    init: (init) => request("init", init),
    compile: (shaders) => request("compile", shaders),
    profile: (input) => request("profile", input),
    async render(frame) {
      const { data, ...rest } = await request<BoardGpuResult>("render", frame);
      return { ...rest, bytes: new Uint8Array(Buffer.from(data, "base64")) };
    },
    async close() {
      connected.end();
    },
  };
}

export async function openBoardGpu(resources: BoardGpuResources, options: { browser: string; signal?: AbortSignal }): Promise<BoardGpuExporter> {
  const shared = await connectBoardGpu(resources, options).catch(() => null);
  if (shared) return shared;
  options.signal?.throwIfAborted();
  return launchBoardGpuExporter(resources, options);
}
