import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { withRuntimeSpaceBindingsLock } from "./space-binding.js";
import type { RuntimeSummary } from "./presentation.js";

type InstanceRecord = { pid: number; nonce: string; socket: string };
const MAX_WATCHERS = 16;

export function runtimeInstancesRoot() {
  return join(homedir(), ".local", "state", "cohub", "instances");
}

export function runtimeInstanceDirectory(identity: string, spaceId: string) {
  const key = createHash("sha256").update(`${identity}\0${spaceId}`).digest("hex").slice(0, 24);
  return join(runtimeInstancesRoot(), key);
}

function alive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function readRecord(directory: string): Promise<InstanceRecord | null> {
  try {
    const value = JSON.parse(await readFile(join(directory, "owner.json"), "utf8")) as InstanceRecord;
    if (!Number.isSafeInteger(value.pid) || typeof value.nonce !== "string" || typeof value.socket !== "string") throw new Error("Invalid Runtime instance record");
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

type Response = { status: RuntimeSummary; result?: unknown };

function request(record: InstanceRecord, action: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(record.socket);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Runtime control timed out")); }, timeoutMs);
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, value?: Response) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else if (value) resolve(value);
    };
    socket.on("connect", () => socket.write(`${JSON.stringify({ ...payload, nonce: record.nonce, action })}\n`));
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("Runtime control closed")));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 64 * 1024) { finish(new Error("Runtime response too large")); return; }
      if (!buffer.includes("\n")) return;
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        if (response.error) finish(new Error(response.error));
        else if (response.nonce !== record.nonce || response.status?.pid !== record.pid) finish(new Error("Runtime identity changed"));
        else finish(undefined, { status: response.status, result: response.result });
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  });
}

export async function requestRuntimeInstance(directory: string, action: "status" | "stop" = "status", force = false) {
  return (await controlRuntimeInstance(directory, action, { force }))?.status ?? null;
}

/** Send a control action to the running Runtime; `null` when none runs. */
export async function controlRuntimeInstance(directory: string, action: string, payload: Record<string, unknown> = {}, timeoutMs = 3000): Promise<Response | null> {
  const record = await readRecord(directory);
  if (!record || !alive(record.pid)) return null;
  try { return await request(record, action, payload, timeoutMs); }
  catch (error) {
    // A reused PID is not proof of ownership. Missing/refused endpoints cannot
    // belong to a serving Runtime; timeouts and permission errors remain uncertain.
    if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

export const UNCONFIRMED_WORK = "Unconfirmed executions remain";

export async function stopRuntimeInstance(directory: string, force = false) {
  const local = await requestRuntimeInstance(directory, "stop", force);
  const until = Date.now() + 15_000;
  let running = Boolean(local);
  while (running && Date.now() < until) {
    await delay(250);
    try { running = Boolean(await requestRuntimeInstance(directory)); }
    catch { running = true; } // An unreachable control socket does not prove the process stopped.
  }
  if (running) throw new Error("Runtime is still stopping; inspect logs");
  return local;
}

export async function watchRuntimeInstance(directory: string, onStatus: (status: RuntimeSummary) => void, signal?: AbortSignal): Promise<boolean> {
  const record = await readRecord(directory).catch(() => null);
  if (!record || !alive(record.pid) || signal?.aborted) return false;
  let streamed = false;
  await new Promise<void>((resolve) => {
    const socket = createConnection(record.socket);
    const abort = () => socket.destroy();
    let buffer = "";
    signal?.addEventListener("abort", abort, { once: true });
    socket.on("connect", () => socket.write(`${JSON.stringify({ action: "watch", nonce: record.nonce })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const response = JSON.parse(line);
          if (response.nonce !== record.nonce || response.status?.pid !== record.pid) { socket.destroy(); return; }
          streamed = true;
          onStatus(response.status);
        } catch { socket.destroy(); return; }
      }
      if (buffer.length > 64 * 1024) socket.destroy();
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => { signal?.removeEventListener("abort", abort); resolve(); });
  });
  return streamed;
}

export type RuntimeInstanceHandle = {
  changed(): void;
  close(): Promise<void>;
};

/** Private local IPC is both the single-instance guard and the control surface. */
export async function ownRuntimeInstance(directory: string, status: () => RuntimeSummary, stop: (force: boolean) => Promise<void>, control: (action: string, message: Record<string, unknown>) => Promise<unknown> = async () => { throw new Error("Unknown Runtime control request"); }): Promise<RuntimeInstanceHandle> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return withRuntimeSpaceBindingsLock(async () => {
    if (await requestRuntimeInstance(directory)) throw new Error("Runtime already running; use status");
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\cohub-${createHash("sha256").update(directory).digest("hex").slice(0, 24)}`
      : join(directory, "control.sock");
    if (process.platform !== "win32") await rm(socketPath, { force: true });
    const record: InstanceRecord = { pid: process.pid, nonce: randomUUID(), socket: socketPath };
    const clients = new Set<Socket>();
    const watchers = new Set<Socket>();
    const statusLine = () => `${JSON.stringify({ nonce: record.nonce, status: status() })}\n`;
    const server = createServer((socket) => {
      clients.add(socket);
      socket.setTimeout(3000, () => socket.destroy());
      socket.on("error", () => socket.destroy());
      socket.on("close", () => { clients.delete(socket); watchers.delete(socket); });
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString();
        if (input.length > 4096) { socket.destroy(); return; }
        if (!input.includes("\n")) return;
        socket.removeAllListeners("data");
        // The request arrived; answering it may take longer than an idle client is allowed.
        socket.setTimeout(0);
        void (async () => {
          const message = JSON.parse(input.slice(0, input.indexOf("\n")));
          if (message.nonce !== record.nonce) { socket.destroy(); return; }
          if (message.action === "watch") {
            if (watchers.size >= MAX_WATCHERS) { socket.destroy(); return; }
            watchers.add(socket);
            socket.write(statusLine());
            return;
          }
          let result: unknown;
          if (message.action === "stop") await stop(message.force === true);
          else if (message.action !== "status") result = await control(String(message.action), message);
          socket.end(`${JSON.stringify({ nonce: record.nonce, status: status(), ...(result === undefined ? {} : { result }) })}\n`);
        })().catch((error) => socket.end(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => { server.removeListener("error", reject); resolve(); });
    });
    try {
      if (process.platform !== "win32") await chmod(socketPath, 0o600);
      const temporary = join(directory, `${record.nonce}.tmp`);
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await rename(temporary, join(directory, "owner.json"));
    } catch (error) { server.close(); throw error; }
    return {
      changed: () => {
        if (!watchers.size) return;
        const line = statusLine();
        for (const watcher of watchers) watcher.write(line);
      },
      close: async () => {
        for (const client of clients) client.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        // Never remove a replacement owner's files.
        if ((await readRecord(directory))?.nonce === record.nonce) await rm(join(directory, "owner.json"));
      },
    };
  }, { path: join(directory, "owner.json") });
}
