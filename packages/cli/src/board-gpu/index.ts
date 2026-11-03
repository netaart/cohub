import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { BoardGpuFrame, BoardGpuInit, BoardGpuProfile, BoardGpuProfileInput, BoardGpuResult, BoardGpuShader } from "./protocol.js";

export type { BoardGpuFrame, BoardGpuProfile, BoardGpuProfileInput, BoardGpuResult, BoardGpuShader } from "./protocol.js";

export function findBoardGpuBrowser(env: NodeJS.ProcessEnv = process.env): string | null {
  const named = env.COHUB_CHROME?.trim();
  if (named) return existsSync(named) ? named : null;
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    : process.platform === "win32"
      ? [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].flatMap((root) => root ? [join(root, "Google/Chrome/Application/chrome.exe"), join(root, "Microsoft/Edge/Application/msedge.exe")] : [])
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"].flatMap((name) =>
          (env.PATH ?? "").split(":").filter(Boolean).map((dir) => join(dir, name)));
  return candidates.find((path) => existsSync(path)) ?? null;
}

const CALL_TIMEOUT_MS = 120_000;

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

const PAGE = (fonts: readonly { family: string; file: string }[]) => `<!doctype html><meta charset="utf-8"><style>${fonts
  .map(({ family, file }) => `@font-face{font-family:"${family}";src:url("fonts/${file}") format("woff2");font-weight:100 900}`)
  .join("")}</style><body>${fonts.map(({ family }) => `<span style="font-family:'${family}'">.</span>`).join("")}<script type="module" src="page.js"></script>`;

export type BoardGpuResources = {
  readModule(path: string): Promise<string>;
  readPicture(request: { key: string; edge: number } | { background: true }): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  fonts: readonly { family: string; path: string }[];
};

export type BoardGpuExporter = {
  readonly browser: string;
  init(init: BoardGpuInit): Promise<void>;
  render(frame: BoardGpuFrame): Promise<Omit<BoardGpuResult, "data"> & { bytes: Uint8Array }>;
  compile(shaders: BoardGpuShader[]): Promise<Record<string, string>>;
  profile(input: BoardGpuProfileInput): Promise<BoardGpuProfile>;
  close(): Promise<void>;
};

export async function launchBoardGpuExporter(resources: BoardGpuResources, options: { browser: string; signal?: AbortSignal }): Promise<BoardGpuExporter> {
  const bundle = fileURLToPath(new URL("./page.js", import.meta.url));
  if (!existsSync(bundle)) throw new Error("This CLI build has no GPU exporter; reinstall @neta-art/cohub-cli.");
  const token = randomBytes(16).toString("hex");
  const fonts = resources.fonts.map(({ family, path }) => ({ family, path, file: basename(path) }));
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const [, prefix, ...rest] = url.pathname.split("/");
    const route = rest.join("/");
    try {
      if (prefix !== token) throw Object.assign(new Error("Not found"), { status: 404 });
      if (route === "") return void response.writeHead(200, { "content-type": "text/html" }).end(PAGE(fonts));
      if (route === "page.js") return void response.writeHead(200, { "content-type": "text/javascript" }).end(await readFile(bundle));
      const font = route.startsWith("fonts/") && fonts.find(({ file }) => file === route.slice(6));
      if (font) return void response.writeHead(200, { "content-type": "font/woff2" }).end(await readFile(font.path));
      if (route === "module") {
        const code = await resources.readModule(url.searchParams.get("path") ?? "");
        return void response.writeHead(200, { "content-type": "text/javascript" }).end(code);
      }
      if (route === "asset") {
        const picture = await resources.readPicture(url.searchParams.has("background")
          ? { background: true }
          : { key: url.searchParams.get("key") ?? "", edge: Number(url.searchParams.get("edge")) || 4096 });
        if (!picture) throw Object.assign(new Error("Not found"), { status: 404 });
        return void response.writeHead(200, { "content-type": picture.mimeType }).end(picture.bytes);
      }
      throw Object.assign(new Error("Not found"), { status: 404 });
    } catch (error) {
      response.writeHead((error as { status?: number }).status ?? 500).end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const profile = await mkdtemp(join(tmpdir(), "cohub-board-gpu-"));
  let chrome: ChildProcess | null = null;
  const close = async () => {
    chrome?.kill();
    chrome = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  };
  const start = async (sandbox: boolean) => {
    const child = spawn(options.browser, [
      "--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-background-networking", "--mute-audio", "--hide-scrollbars", "--enable-unsafe-swiftshader",
      ...(sandbox ? [] : ["--no-sandbox"]), "about:blank",
    ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    const [, , , input, output] = child.stdio as [null, null, null, Writable, Readable];
    const protocol = devtools(input, output);
    child.once("exit", () => protocol.fail(new Error("The browser stopped.")));
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
        crashed ??= String((message.params?.exceptionDetails as { exception?: { description?: string } })?.exception?.description ?? "The export page failed.");
    });
    await page("Runtime.enable");
    await page("Page.enable");
    await page("Page.navigate", { url: `http://127.0.0.1:${port}/${token}/` });
    const call = async <T>(expression: string, timeoutMs = CALL_TIMEOUT_MS): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("The GPU exporter stopped responding; a shader may be too heavy to render.")), timeoutMs);
      });
      const reply = await Promise.race([page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }), expired])
        .finally(() => clearTimeout(timer)) as {
        result?: { value?: T };
        exceptionDetails?: { exception?: { description?: string }; text?: string };
      };
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description?.split("\n")[0] ?? reply.exceptionDetails.text ?? "The export page failed.");
      return reply.result?.value as T;
    };
    const loaded = () => call<boolean>("Boolean(globalThis.cohubBoardGpu)", 5_000).catch(() => false);
    for (const started = Date.now(); !(await loaded());) {
      if (crashed || Date.now() - started > 20_000) throw new Error(crashed ?? "The GPU exporter did not start.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return {
      browser: options.browser,
      async init(init) {
        await call(`cohubBoardGpu.init(${JSON.stringify(init)})`);
      },
      compile: (shaders) => call<Record<string, string>>(`cohubBoardGpu.compile(${JSON.stringify(shaders)})`),
      profile: (input) => call<BoardGpuProfile>(`cohubBoardGpu.profile(${JSON.stringify(input)})`),
      async render(frame) {
        const { data, ...rest } = await call<BoardGpuResult>(`cohubBoardGpu.render(${JSON.stringify(frame)})`);
        return { ...rest, bytes: new Uint8Array(Buffer.from(data, "base64")) };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
