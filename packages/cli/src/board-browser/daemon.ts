import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { isSafeBoardSourcePath } from "@neta-art/cohub/board";
import { boardBrowser } from "./chrome.js";
import {
  type BoardBrowser,
  type BoardBrowserFrameHandler,
  type BoardBrowserFrameInfo,
  type BoardBrowserMethod,
  type BoardBrowserPage,
  type BoardBrowserPictureRequest,
  type BoardBrowserResources,
  boardBrowserCalls,
  launchBoardBrowser,
} from "./index.js";
import { CLI_VERSION } from "../version.js";
import { packagePath } from "../package-paths.js";

const IDLE_MS = 5 * 60_000;
const CONNECT_MS = 20_000;
const TURN_MS = 20_000;

type Ask = { kind: "file"; path: string } | { kind: "picture"; request: BoardBrowserPictureRequest } | { kind: "frame"; info: BoardBrowserFrameInfo };
type Header =
  | { id: number; method: BoardBrowserMethod; params?: unknown; timeoutMs?: number }
  | { id: number; result?: unknown; error?: string }
  | { ask: number; request: Ask }
  | { answer: number; mimeType?: string; missing?: boolean; error?: string }
  | { granted: true };
type Packet = { header: Header; body: Uint8Array | null };

function channel(socket: Socket, handle: (packet: Packet) => void) {
  const chunks: Buffer[] = [];
  let size = 0;
  let lengths: { header: number; body: number } | null = null;
  const take = (count: number): Buffer => {
    size -= count;
    const first = chunks[0] as Buffer;
    if (first.length >= count) {
      if (first.length === count) chunks.shift();
      else chunks[0] = first.subarray(count);
      return first.subarray(0, count);
    }
    const out = Buffer.allocUnsafe(count);
    for (let offset = 0; offset < count;) {
      const chunk = chunks[0] as Buffer;
      const length = Math.min(chunk.length, count - offset);
      chunk.copy(out, offset, 0, length);
      offset += length;
      if (length === chunk.length) chunks.shift();
      else chunks[0] = chunk.subarray(length);
    }
    return out;
  };
  socket.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    size += chunk.length;
    for (;;) {
      if (!lengths) {
        if (size < 8) return;
        const prefix = take(8);
        lengths = { header: prefix.readUInt32LE(0), body: prefix.readUInt32LE(4) };
      }
      if (size < lengths.header + lengths.body) return;
      const text = take(lengths.header).toString("utf8");
      const body = lengths.body ? new Uint8Array(take(lengths.body)) : null;
      lengths = null;
      let header: Header;
      try {
        header = JSON.parse(text) as Header;
      } catch {
        continue;
      }
      handle({ header, body });
    }
  });
  return (header: Header, body?: Uint8Array) => {
    const json = Buffer.from(JSON.stringify(header));
    const prefix = Buffer.alloc(8);
    prefix.writeUInt32LE(json.length, 0);
    prefix.writeUInt32LE(body?.byteLength ?? 0, 4);
    socket.write(Buffer.concat([prefix, json]));
    if (body?.byteLength) socket.write(body);
  };
}

export function boardBrowserSocket(browser: string): string {
  let page = 0;
  try {
    page = statSync(packagePath("dist", "board-browser", "page.js")).mtimeMs;
  } catch {}
  const { uid } = userInfo();
  const key = createHash("sha256").update(`${CLI_VERSION}\0${browser}\0${page}\0${uid}`).digest("hex").slice(0, 16);
  if (process.platform === "win32") return join("\\\\.\\pipe", `cohub-board-browser-${key}`);
  const dir = join(process.env.XDG_RUNTIME_DIR || tmpdir(), `cohub-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) throw new Error(`${dir} is not private to this user.`);
  return join(dir, `board-browser-${key}.sock`);
}

export async function serveBoardBrowser(browser: string): Promise<void> {
  const path = boardBrowserSocket(browser);
  type Caller = {
    send: (header: Header, body?: Uint8Array) => void;
    asks: Map<number, (packet: Packet) => void>;
    running: number;
    gone: boolean;
  };
  const queue: Caller[] = [];
  let page: Promise<BoardBrowserPage> | null = null;
  let nextAsk = 0;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let releasing = Promise.resolve();
  const active = () => queue[0] ?? null;

  const ask = (request: Ask, body?: Uint8Array) => new Promise<Packet>((resolve, reject) => {
    const caller = active();
    if (!caller || caller.gone) return reject(new Error("The caller left."));
    const id = ++nextAsk;
    caller.asks.set(id, resolve);
    caller.send({ ask: id, request }, body);
  });
  const answered = async (request: Ask, body?: Uint8Array) => {
    const { header, body: bytes } = await ask(request, body);
    if (!("answer" in header)) throw new Error("The caller answered out of turn.");
    if (header.error !== undefined) throw new Error(header.error);
    return { header, bytes };
  };
  const { boardBrowserFonts } = await import("../board-export.js");
  const resources: BoardBrowserResources = {
    fonts: boardBrowserFonts(),
    async readFile(path) {
      const { bytes } = await answered({ kind: "file", path });
      return bytes ?? new Uint8Array();
    },
    async readPicture(request) {
      const { header, bytes } = await answered({ kind: "picture", request });
      return header.missing || !bytes ? null : { bytes, mimeType: header.mimeType ?? "application/octet-stream" };
    },
    async frame(info, bytes) {
      await answered({ kind: "frame", info }, bytes);
    },
  };

  const pageFor = () => (page ??= launchBoardBrowser(resources, { browser }).catch((error: unknown) => {
    page = null;
    throw error;
  }));
  const reset = async () => {
    const current = page;
    page = null;
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
    if (!queue.length && page) releasing = page.then((current) => current.call("release")).then(() => {}, () => {});
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
    caller.send = channel(socket, (packet) => {
      const { header } = packet;
      if ("answer" in header) {
        caller.asks.get(header.answer)?.(packet);
        caller.asks.delete(header.answer);
        return;
      }
      if (!("method" in header) || active() !== caller) return;
      caller.running++;
      void releasing.then(pageFor)
        .then((current) => current.call(header.method, header.params, header.timeoutMs))
        .then((result) => caller.send({ id: header.id, result }), async (error: unknown) => {
          const text = error instanceof Error ? error.message : String(error);
          // A call given up on may still be working; a fresh page keeps it from reaching the next caller.
          if (/stopped responding|did not finish|browser (stopped|closed)|did not start/i.test(text)) await reset();
          caller.send({ id: header.id, error: text });
        })
        .finally(() => {
          caller.running--;
          release(caller);
        });
    });
    const leave = () => {
      if (caller.gone) return;
      caller.gone = true;
      for (const resolve of caller.asks.values()) resolve({ header: { answer: -1, error: "The caller left." }, body: null });
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

function startDaemon(browser: string) {
  const entry = process.argv[1];
  if (!entry) throw new Error("The CLI entry point is unknown.");
  spawn(process.execPath, [...process.execArgv, entry, "boards", "browser-daemon", "--browser", browser], {
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

async function connectBoardBrowser(resources: BoardBrowserResources, options: { browser: string; signal?: AbortSignal }): Promise<BoardBrowserPage | null> {
  if (process.env.COHUB_BOARD_BROWSER_DAEMON === "0") return null;
  const path = boardBrowserSocket(options.browser);
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
  const send = channel(connected, ({ header, body }) => {
    if ("granted" in header) return granted(true);
    if ("ask" in header) {
      void answer(header.request, body).then(({ reply, bytes }) => send({ answer: header.ask, ...reply }, bytes));
      return;
    }
    if ("id" in header && !("method" in header)) {
      const waiting = pending.get(header.id);
      pending.delete(header.id);
      if (header.error !== undefined) waiting?.reject(new Error(header.error));
      else waiting?.resolve(header.result);
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

  type Reply = { reply: { mimeType?: string; missing?: boolean; error?: string }; bytes?: Uint8Array };
  async function answer(request: Ask, body: Uint8Array | null): Promise<Reply> {
    try {
      if (request.kind === "file") {
        if (!isSafeBoardSourcePath(request.path)) throw new Error(`${request.path} is not a Space path.`);
        return { reply: {}, bytes: await resources.readFile(request.path) };
      }
      if (request.kind === "frame") {
        await resources.frame(request.info, body ?? new Uint8Array());
        return { reply: {} };
      }
      const picture = await resources.readPicture(request.request);
      return picture ? { reply: { mimeType: picture.mimeType }, bytes: picture.bytes } : { reply: { missing: true } };
    } catch (error) {
      return { reply: { error: error instanceof Error ? error.message : String(error) } };
    }
  }
  return {
    browser: options.browser,
    call<T>(method: BoardBrowserMethod, params?: unknown, timeoutMs?: number): Promise<T> {
      if (connected.destroyed) return Promise.reject(new Error("The shared browser closed."));
      const id = ++next;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        send({ id, method, ...(params === undefined ? {} : { params }), ...(timeoutMs ? { timeoutMs } : {}) });
      });
    },
    async close() {
      connected.end();
    },
  };
}

export async function openBoardBrowser(resources: Omit<BoardBrowserResources, "frame">, options: { signal?: AbortSignal } = {}): Promise<BoardBrowser> {
  const browser = await boardBrowser(options.signal);
  const receiver: { current: BoardBrowserFrameHandler | null } = { current: null };
  const withFrames: BoardBrowserResources = {
    ...resources,
    frame: async (info, bytes) => {
      if (!receiver.current) throw new Error("No call is waiting for frames.");
      await receiver.current(info, bytes);
    },
  };
  const shared = await connectBoardBrowser(withFrames, { browser, signal: options.signal }).catch(() => null);
  options.signal?.throwIfAborted();
  return boardBrowserCalls(shared ?? await launchBoardBrowser(withFrames, { browser, signal: options.signal }), receiver);
}
