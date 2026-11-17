import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { mimeTypeForPath } from "@neta-art/cohub";
import { isBoardPath } from "@neta-art/cohub/board";
import { localBoardFiles } from "./board-files.js";
import { applyLocalBoard, localBoardChange, localBoardReadResult, readLocalBoard, storeLocalBoardImage } from "./board-local.js";
import { packagePath } from "./package-paths.js";
import { CLI_VERSION } from "./version.js";

/**
 * One viewer server per user serves every local Board opened on this machine.
 * Every URL carries the key, so other local pages and DNS rebinding reach nothing.
 */
const PORTS = [7417, 7418, 7419, 7420];
const IDLE_MS = 60 * 60_000;
const BODY_MAX_BYTES = 16 * 1024 * 1024;
const IMAGE_MAX_BYTES = 64 * 1024 * 1024;

type ViewerState = { port: number; key: string; pid: number; version: string; boards: Record<string, string> };

function stateDir(): string {
  const { uid } = userInfo();
  const dir = join(process.env.XDG_RUNTIME_DIR || tmpdir(), `cohub-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || (process.platform !== "win32" && (info.uid !== uid || (info.mode & 0o077) !== 0)))
    throw new Error(`${dir} is not private to this user.`);
  return dir;
}

const statePath = () => join(stateDir(), "board-viewer.json");

async function readState(): Promise<ViewerState | null> {
  try {
    return JSON.parse(await readFile(statePath(), "utf8")) as ViewerState;
  } catch {
    return null;
  }
}

const writeState = (state: ViewerState) => writeFile(statePath(), JSON.stringify(state), { mode: 0o600 });

const viewerDir = () => packagePath("board-viewer");

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBytes(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const bytes = await readBytes(req, BODY_MAX_BYTES);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be JSON."), { status: 400 });
  }
}

/** `sandboxed` files are the Board's own: opened directly, they run no script on the viewer's origin. */
async function sendFile(req: IncomingMessage, res: ServerResponse, file: string, cache: string, sandboxed = false) {
  const info = await stat(file);
  const type = mimeTypeForPath(file) ?? (extname(file) === ".woff2" ? "font/woff2" : "application/octet-stream");
  const headers: Record<string, string | number> = {
    "Content-Type": type,
    "Cache-Control": cache,
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff",
    ...(sandboxed ? { "Content-Security-Policy": "sandbox" } : {}),
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${info.size}` });
    return req.method === "HEAD" ? res.end() : createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "Content-Length": info.size });
  return req.method === "HEAD" ? res.end() : createReadStream(file).pipe(res);
}

type Room = { clients: Set<ServerResponse>; version: number; watcher: FSWatcher; timer: ReturnType<typeof setTimeout> | null };

export async function serveBoardViewer(): Promise<void> {
  const previous = await readState();
  const key = previous?.key ?? randomBytes(18).toString("base64url");
  const boards = new Map(Object.entries(previous?.boards ?? {}));
  const rooms = new Map<string, Room>();
  const applied = new Map<string, unknown>();
  let idle: ReturnType<typeof setTimeout> | null = null;
  let port = 0;

  const touch = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      if ([...rooms.values()].some((room) => room.clients.size)) return touch();
      process.exit(0);
    }, IDLE_MS);
  };

  const persist = () => writeState({ port, key, pid: process.pid, version: CLI_VERSION, boards: Object.fromEntries(boards) });

  const broadcast = (room: Room, event: string, data: unknown) => {
    for (const client of room.clients) client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const notice = (id: string, path: string) => {
    const room = rooms.get(id);
    if (!room) return;
    if (room.timer) clearTimeout(room.timer);
    room.timer = setTimeout(async () => {
      room.timer = null;
      const change = await localBoardChange(path).catch(() => null);
      if (change && change.version === room.version) return;
      if (change && change.version === room.version + 1) {
        broadcast(room, "changed", { mutationId: change.mutationId ?? "", baseVersion: room.version, version: change.version, after: change.after });
        room.version = change.version;
        return;
      }
      room.version = change?.version ?? (await readLocalBoard(path).catch(() => null))?.version ?? room.version;
      broadcast(room, "resync", {});
    }, 40);
  };

  const subscribe = async (id: string, path: string, res: ServerResponse) => {
    let room = rooms.get(id);
    if (!room) {
      const name = basename(path);
      const history = `.${name}.history.jsonl`;
      const watcher = watch(dirname(path), (_event, file) => {
        if (file === name || file === history) notice(id, path);
      });
      room = { clients: new Set(), version: (await readLocalBoard(path)).version, watcher, timer: null };
      rooms.set(id, room);
    }
    const current = room;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(": open\n\n");
    current.clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    res.on("close", () => {
      clearInterval(ping);
      current.clients.delete(res);
      if (current.clients.size) return;
      current.watcher.close();
      if (current.timer) clearTimeout(current.timer);
      rooms.delete(id);
    });
  };

  const register = async (path: string) => {
    if (!isBoardPath(path)) throw Object.assign(new Error(`${path} is not a .board file.`), { status: 400 });
    const file = await realpath(resolve(path));
    await readLocalBoard(file);
    const id = createHmac("sha256", key).update(file).digest("base64url").slice(0, 16);
    boards.set(id, file);
    await persist();
    return id;
  };

  const route = async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { message: "Unknown host." });
    const url = new URL(req.url ?? "/", `http://${host}`);
    const parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
    if (parts[0] !== "k" || parts[1] !== key) return send(res, 404, { message: "Not found." });
    touch();
    const [, , area, ...rest] = parts;
    if (area === "b" && rest[0] === "assets" && rest.length > 1) {
      const root = join(viewerDir(), "assets");
      const file = resolve(root, rest.slice(1).join("/"));
      if (!file.startsWith(`${root}${sep}`) || !existsSync(file)) return send(res, 404, { message: "Not found." });
      return sendFile(req, res, file, "public, max-age=31536000, immutable");
    }
    if (area === "b" && rest.length === 1 && boards.has(rest[0] as string)) {
      const index = join(viewerDir(), "index.html");
      if (!existsSync(index)) return send(res, 500, { message: "This CLI build has no Board viewer; reinstall @neta-art/cohub-cli." });
      return sendFile(req, res, index, "no-cache");
    }
    if (area === "f" && rest.length > 1) {
      const path = boards.get(rest[0] as string);
      if (!path) return send(res, 404, { message: "Not found." });
      if (rest.slice(1).some((part) => part.startsWith("."))) return send(res, 404, { message: "Not found." });
      const file = localBoardFiles(dirname(path)).local(rest.slice(1).join("/"));
      if (!file) return send(res, 404, { message: "Not found." });
      const [real, top] = await Promise.all([realpath(file).catch(() => null), realpath(dirname(path))]);
      if (!real?.startsWith(`${top}${sep}`)) return send(res, 404, { message: "Not found." });
      return sendFile(req, res, real, "no-cache", true);
    }
    if (area !== "api") return send(res, 404, { message: "Not found." });
    if (rest[0] === "health") return send(res, 200, { version: CLI_VERSION });
    if (rest[0] === "stop" && req.method === "POST") {
      send(res, 200, {});
      return setTimeout(() => process.exit(0), 50);
    }
    if (rest[0] === "register" && req.method === "POST") {
      const body = (await readBody(req)) as { path?: unknown };
      if (typeof body?.path !== "string") return send(res, 400, { message: "path is required." });
      return send(res, 200, { id: await register(body.path) });
    }
    const id = rest[1] ?? "";
    const path = rest[0] === "b" ? boards.get(id) : undefined;
    if (!path) return send(res, 404, { message: "Not found." });
    if (rest.length === 2 && req.method === "GET") return send(res, 200, localBoardReadResult(id, path, await readLocalBoard(path)));
    if (rest[2] === "events" && req.method === "GET") return subscribe(id, path, res);
    if (rest[2] === "assets" && req.method === "POST") {
      const name = decodeURIComponent(String(req.headers["x-file-name"] ?? "")).slice(0, 240);
      const type = String(req.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "";
      return send(res, 200, await storeLocalBoardImage(path, await readBytes(req, IMAGE_MAX_BYTES), type, name));
    }
    if (rest[2] === "apply" && req.method === "POST") {
      const body = (await readBody(req)) as { patch?: unknown; mutationId?: unknown };
      if (!body?.patch || typeof body.patch !== "object") return send(res, 400, { message: "patch is required." });
      const mutationId = typeof body.mutationId === "string" ? body.mutationId : undefined;
      const replayed = mutationId && applied.get(mutationId);
      if (replayed) return send(res, 200, { ...(replayed as object), replayed: true });
      const write = await applyLocalBoard(path, body.patch as never, { by: "viewer", ...(mutationId ? { mutationId } : {}) });
      if (mutationId) {
        applied.set(mutationId, write.result);
        if (applied.size > 500) applied.delete(applied.keys().next().value as string);
      }
      const room = rooms.get(id);
      if (room && write.after && write.baseVersion === room.version) {
        broadcast(room, "changed", { mutationId: write.result.mutationId, baseVersion: write.baseVersion, version: write.result.version, after: write.after });
        room.version = write.result.version;
      }
      return send(res, 200, write.result);
    }
    return send(res, 404, { message: "Not found." });
  };

  const server = createServer((req, res) => {
    route(req, res).catch((cause: Error & { status?: number }) => {
      if (res.headersSent) return res.end();
      send(res, cause.status ?? 500, { message: cause.message });
    });
  });
  const candidates = previous?.port ? [previous.port, ...PORTS.filter((port) => port !== previous.port)] : PORTS;
  for (const candidate of [...candidates, 0]) {
    const bound = await new Promise<boolean>((done) => {
      server.once("error", () => done(false));
      server.listen(candidate, "127.0.0.1", () => done(true));
    });
    if (bound) break;
  }
  port = (server.address() as { port: number }).port;
  await persist();
  touch();
}

async function runningVersion(state: ViewerState): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/k/${state.key}/api/health`, { signal: AbortSignal.timeout(1_000) });
    return response.ok ? (((await response.json()) as { version?: string }).version ?? null) : null;
  } catch {
    return null;
  }
}

async function ensureServer(): Promise<ViewerState> {
  const current = await readState();
  const running = current && (await runningVersion(current));
  if (current && running === CLI_VERSION) return current;
  if (current && running) {
    await fetch(`http://127.0.0.1:${current.port}/k/${current.key}/api/stop`, { method: "POST" }).catch(() => undefined);
    await new Promise((done) => setTimeout(done, 200));
  }
  const entry = process.argv[1];
  if (!entry) throw new Error("The CLI entry point is unknown.");
  spawn(process.execPath, [...process.execArgv, entry, "boards", "viewer-daemon"], { detached: true, stdio: "ignore", env: process.env }).unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 100));
    const next = await readState();
    if (next && next.pid !== current?.pid && (await runningVersion(next)) === CLI_VERSION) return next;
  }
  throw new Error("The Board viewer did not start; run cohub boards viewer-daemon to see why.");
}

export async function openBoardViewer(path: string): Promise<string> {
  if (!existsSync(join(viewerDir(), "index.html"))) throw new Error("This CLI build has no Board viewer; reinstall @neta-art/cohub-cli.");
  await readLocalBoard(path);
  const state = await ensureServer();
  const base = `http://127.0.0.1:${state.port}/k/${state.key}`;
  const response = await fetch(`${base}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: resolve(path) }),
  });
  const body = (await response.json()) as { id?: string; message?: string };
  if (!response.ok || !body.id) throw new Error(body.message ?? "The Board viewer refused the file.");
  return `${base}/b/${body.id}`;
}

export function canOpenBrowser(): boolean {
  return process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

export function openInBrowser(url: string): void {
  const [command, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  spawn(command, args as string[], { detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
}
