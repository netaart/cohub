import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { withRuntimeSpaceBindingsLock } from "./space-binding.js";
import type { RuntimeSummary } from "./presentation.js";

type InstanceRecord = { pid: number; nonce: string; socket: string };
export function runtimeInstanceDirectory(identity: string, spaceId: string) {
  const key = createHash("sha256").update(`${identity}\0${spaceId}`).digest("hex").slice(0, 24);
  return join(homedir(), ".local", "state", "cohub", "instances", key);
}

function alive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function readRecord(directory: string): Promise<InstanceRecord | null> {
  try {
    const value = JSON.parse(await readFile(join(directory, "owner.json"), "utf8")) as InstanceRecord;
    if (!Number.isSafeInteger(value.pid) || typeof value.nonce !== "string" || typeof value.socket !== "string") throw new Error("Invalid Runtime instance record / Runtime 实例记录无效");
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

function request(record: InstanceRecord, action: "status" | "stop", force = false): Promise<RuntimeSummary> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(record.socket);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Runtime control timed out / Runtime 控制连接超时")); }, 3000);
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, value?: RuntimeSummary) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else if (value) resolve(value);
    };
    socket.on("connect", () => socket.write(`${JSON.stringify({ nonce: record.nonce, action, force })}\n`));
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("Runtime control closed / Runtime 控制连接已关闭")));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 64 * 1024) { finish(new Error("Runtime response too large")); return; }
      if (!buffer.includes("\n")) return;
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        if (response.error) finish(new Error(response.error));
        else if (response.nonce !== record.nonce || response.status?.pid !== record.pid) finish(new Error("Runtime identity changed / Runtime 身份已变化"));
        else finish(undefined, response.status);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  });
}

export async function requestRuntimeInstance(directory: string, action: "status" | "stop" = "status", force = false) {
  const record = await readRecord(directory);
  if (!record || !alive(record.pid)) return null;
  try { return await request(record, action, force); }
  catch (error) {
    // A reused PID is not proof of ownership. Missing/refused endpoints cannot
    // belong to a serving Runtime; timeouts and permission errors remain uncertain.
    if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

/** Private local IPC is both the single-instance guard and the control surface. */
export async function ownRuntimeInstance(directory: string, status: () => RuntimeSummary, stop: (force: boolean) => Promise<void>) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return withRuntimeSpaceBindingsLock(async () => {
    if (await requestRuntimeInstance(directory)) throw new Error("Runtime already running; use status / Runtime 已在运行，请使用 status");
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\cohub-${createHash("sha256").update(directory).digest("hex").slice(0, 24)}`
      : join(directory, "control.sock");
    if (process.platform !== "win32") await rm(socketPath, { force: true });
    const record: InstanceRecord = { pid: process.pid, nonce: randomUUID(), socket: socketPath };
    const clients = new Set<Socket>();
    const server = createServer((socket) => {
      clients.add(socket);
      socket.setTimeout(3000, () => socket.destroy());
      socket.on("error", () => socket.destroy());
      socket.on("close", () => clients.delete(socket));
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString();
        if (input.length > 4096) { socket.destroy(); return; }
        if (!input.includes("\n")) return;
        socket.removeAllListeners("data");
        void (async () => {
          const message = JSON.parse(input.slice(0, input.indexOf("\n")));
          if (message.nonce !== record.nonce) { socket.destroy(); return; }
          if (message.action === "stop") await stop(message.force === true);
          else if (message.action !== "status") throw new Error("Unknown Runtime control request");
          socket.end(`${JSON.stringify({ nonce: record.nonce, status: status() })}\n`);
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
    return async () => {
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Never remove a replacement owner's files.
      if ((await readRecord(directory))?.nonce === record.nonce) await rm(join(directory, "owner.json"));
    };
  }, { path: join(directory, "owner.json") });
}
