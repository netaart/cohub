import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { isSafeBoardSourcePath } from "@neta-art/cohub/board";
import type {
  BoardBrowserFrame,
  BoardBrowserFrameInfo,
  BoardBrowserInit,
  BoardBrowserProfile,
  BoardBrowserProfileInput,
  BoardBrowserShader,
  BoardBrowserSimulation,
  BoardSimulationResult,
} from "./protocol.js";
import { packagePath } from "../package-paths.js";

export type * from "./protocol.js";

const CALL_TIMEOUT_MS = 120_000;

export type BoardBrowserFont = { family: string; path: string; script?: string };
export type BoardBrowserPicture = { bytes: Uint8Array; mimeType: string };
export type BoardBrowserPictureRequest = { key: string; edge: number } | { background: true };
export type BoardBrowserFrameHandler = (info: BoardBrowserFrameInfo, bytes: Uint8Array) => Promise<void>;

export type BoardBrowserResources = {
  readFile(path: string): Promise<Uint8Array>;
  readPicture(request: BoardBrowserPictureRequest): Promise<BoardBrowserPicture | null>;
  frame: BoardBrowserFrameHandler;
  fonts: readonly BoardBrowserFont[];
};

export type BoardBrowserMethod = "init" | "render" | "compile" | "profile" | "simulate" | "release";

export type BoardBrowserPage = {
  readonly browser: string;
  call<T>(method: BoardBrowserMethod, params?: unknown, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
};

export type BoardBrowser = {
  readonly browser: string;
  init(init: BoardBrowserInit): Promise<void>;
  render(frame: BoardBrowserFrame): Promise<BoardBrowserFrameInfo & { bytes: Uint8Array }>;
  simulate(input: BoardBrowserSimulation, onFrame: BoardBrowserFrameHandler): Promise<BoardSimulationResult>;
  compile(shaders: BoardBrowserShader[]): Promise<Record<string, string>>;
  profile(input: BoardBrowserProfileInput): Promise<BoardBrowserProfile>;
  close(): Promise<void>;
};

export function boardBrowserCalls(page: BoardBrowserPage, receiver: { current: BoardBrowserFrameHandler | null }): BoardBrowser {
  const receiving = async <T>(handler: BoardBrowserFrameHandler, work: () => Promise<T>): Promise<T> => {
    receiver.current = handler;
    try {
      return await work();
    } finally {
      receiver.current = null;
    }
  };
  return {
    browser: page.browser,
    init: (init) => page.call("init", init),
    async render(frame) {
      let bytes: Uint8Array | null = null;
      const info = await receiving(async (_info, received) => { bytes = received; }, () => page.call<BoardBrowserFrameInfo>("render", frame));
      if (!bytes) throw new Error("The browser drew no frame.");
      return { ...info, bytes };
    },
    simulate: (input, onFrame) => receiving(onFrame, () => page.call<BoardSimulationResult>("simulate", input,
      input.timeoutMs + 30_000 + (input.frame ? (input.render?.times?.length ?? 1) * input.frame.timeoutMs : 0))),
    compile: (shaders) => page.call("compile", shaders),
    profile: (input) => page.call("profile", input, Math.max(CALL_TIMEOUT_MS, input.budgetMs * 2 + 60_000)),
    close: () => page.close(),
  };
}

type Message = { id?: number; method?: string; sessionId?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message: string } };

function devtools(input: Writable, output: Readable) {
  let next = 0;
  let buffer = "";
  const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
  const listeners = new Set<(message: Message) => void>();
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\0"); end >= 0; end = buffer.indexOf("\0")) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message: Message;
      try {
        message = JSON.parse(raw) as Message;
      } catch {
        continue;
      }
      const waiting = message.id === undefined ? undefined : pending.get(message.id);
      if (waiting && message.id !== undefined) {
        pending.delete(message.id);
        if (message.error) waiting.reject(new Error(message.error.message));
        else waiting.resolve(message.result ?? {});
      }
      for (const listener of listeners) listener(message);
    }
  });
  const fail = (error: Error) => {
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
  };
  output.on("close", () => fail(new Error("The browser closed.")));
  output.on("error", (error) => fail(error));
  input.on("error", (error) => fail(error));
  return {
    send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
      const id = ++next;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
      });
    },
    listen(listener: (message: Message) => void) {
      listeners.add(listener);
    },
    fail,
  };
}

const PAGE = (fonts: readonly { family: string; file: string; script?: string }[]) => `<!doctype html><meta charset="utf-8"><meta name="cohub-fonts" content="${JSON.stringify(fonts).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"><style>${fonts
  .map(({ family, file }) => `@font-face{font-family:"${family}";src:url("fonts/${file}") format("woff2");font-weight:100 900}`)
  .join("")}</style><body>${fonts.map(({ family }) => `<span style="font-family:'${family}'">.</span>`).join("")}<script type="module" src="page.js"></script>`;

async function body(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const data = Buffer.concat(chunks);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export async function launchBoardBrowser(resources: BoardBrowserResources, options: { browser: string; signal?: AbortSignal }): Promise<BoardBrowserPage> {
  const bundle = packagePath("dist", "board-browser", "page.js");
  if (!existsSync(bundle)) throw new Error("This CLI build has no Board browser page; reinstall @neta-art/cohub-cli.");
  const token = randomBytes(16).toString("hex");
  const fonts = resources.fonts.map(({ family, path, script }) => ({ family, path, file: basename(path), ...(script ? { script } : {}) }));
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const [, prefix, ...rest] = url.pathname.split("/");
    const route = rest.join("/");
    try {
      if (prefix !== token) throw Object.assign(new Error("Not found"), { status: 404 });
      if (route === "") return void response.writeHead(200, { "content-type": "text/html" }).end(PAGE(fonts.map(({ path: _path, ...font }) => font)));
      const send = (type: string, data: Uint8Array) => void response.writeHead(200, { "content-type": type }).end(data);
      if (route === "page.js") return send("text/javascript", await readFile(bundle));
      const font = route.startsWith("fonts/") && fonts.find(({ file }) => file === route.slice(6));
      if (font) return send("font/woff2", await readFile(font.path));
      if (route === "file") {
        const path = url.searchParams.get("path") ?? "";
        if (!isSafeBoardSourcePath(path)) throw Object.assign(new Error("Not found"), { status: 404 });
        return send("application/octet-stream", await resources.readFile(path));
      }
      if (route === "asset") {
        const picture = await resources.readPicture(url.searchParams.has("background")
          ? { background: true }
          : { key: url.searchParams.get("key") ?? "", edge: Number(url.searchParams.get("edge")) || 4096 });
        if (!picture) throw Object.assign(new Error("Not found"), { status: 404 });
        return send(picture.mimeType, picture.bytes);
      }
      if (route === "upload" && request.method === "POST") {
        const data = await body(request);
        const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
        const info = JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + length))) as BoardBrowserFrameInfo;
        await resources.frame(info, data.subarray(4 + length));
        return void response.writeHead(204).end();
      }
      throw Object.assign(new Error("Not found"), { status: 404 });
    } catch (error) {
      if (!response.headersSent) response.writeHead((error as { status?: number }).status ?? 500);
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const profile = await mkdtemp(join(tmpdir(), "cohub-board-browser-"));
  let chrome: ChildProcess | null = null;
  let stderr = "";
  const close = async () => {
    const child = chrome;
    chrome = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      const force = setTimeout(() => child.kill("SIGKILL"), 3_000);
      await exited;
      clearTimeout(force);
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  const start = async (sandbox: boolean) => {
    stderr = "";
    const child = spawn(options.browser, [
      "--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-background-networking", "--mute-audio", "--hide-scrollbars", "--enable-unsafe-swiftshader",
      // An out-of-process script sandbox costs ~40 ms per 1080p frame; its sandbox and CSP still apply.
      "--disable-features=IsolateSandboxedIframes",
      ...(sandbox ? [] : ["--no-sandbox"]), "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    const [, , errors, input, output] = child.stdio as [null, null, Readable, Writable, Readable];
    errors.setEncoding("utf8");
    errors.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    const protocol = devtools(input, output);
    child.once("exit", () => protocol.fail(new Error(`The browser stopped.${stderr.trim() ? `\n${stderr.trim().split("\n").slice(-4).join("\n")}` : ""}`)));
    child.once("error", (error) => protocol.fail(error));
    chrome = child;
    return { protocol, created: await protocol.send("Target.createTarget", { url: "about:blank" }) };
  };
  try {
    const { protocol, created } = await start(true).catch(() => {
      chrome?.kill();
      return start(false);
    });
    options.signal?.addEventListener("abort", () => void close(), { once: true });
    const { targetId } = created;
    const { sessionId } = await protocol.send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string };
    const page = (method: string, params?: Record<string, unknown>) => protocol.send(method, params, sessionId);
    let crashed: string | null = null;
    protocol.listen((message) => {
      if (message.sessionId === sessionId && message.method === "Runtime.exceptionThrown")
        crashed ??= String((message.params?.exceptionDetails as { exception?: { description?: string } })?.exception?.description ?? "The Board page failed.");
    });
    await page("Runtime.enable");
    await page("Page.enable");
    await page("Page.navigate", { url: `http://127.0.0.1:${port}/${token}/` });
    const evaluate = async <T>(expression: string, timeoutMs = CALL_TIMEOUT_MS): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("The browser stopped responding; a script or shader may be too heavy.")), Math.min(timeoutMs, 2 ** 31 - 1));
      });
      const reply = await Promise.race([page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }), expired])
        .finally(() => clearTimeout(timer)) as {
        result?: { value?: T };
        exceptionDetails?: { exception?: { description?: string }; text?: string };
      };
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description?.replace(/^Error: /, "").split("\n    at ")[0] ?? reply.exceptionDetails.text ?? "The Board page failed.");
      return reply.result?.value as T;
    };
    const loaded = () => evaluate<boolean>("Boolean(globalThis.cohubBoard)", 5_000).catch(() => false);
    for (const started = Date.now(); !(await loaded());) {
      if (crashed || Date.now() - started > 20_000) throw new Error(crashed ?? "The Board page did not start.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return {
      browser: options.browser,
      call: (method, params, timeoutMs) => evaluate(`cohubBoard.${method}(${params === undefined ? "" : JSON.stringify(params)})`, timeoutMs),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
