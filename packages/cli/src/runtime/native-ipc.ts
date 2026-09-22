import { createConnection, createServer, type Server } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nativeRuntimeRoot } from "./native-sync.js";
import { currentIdentityKey } from "../space.js";
import { canonicalRuntimeRoot, getRuntimeSpaceBinding } from "./space-binding.js";
import type { NativeSyncStore } from "./native-sync-store.js";

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const socketPath = (runtimeRoot: string) => join(runtimeRoot, "native", "daemon.sock");
type NativeIpcRequest = {
  type: "native.capture";
  harness: "pi" | "codex";
  cwd: string;
  path: string;
  nativeSessionId: string;
  settled?: boolean;
  leafId?: string | null;
};
type NativeIpcResponse = { ok: true; pendingTurns: number } | { ok: false; message: string };

const parse = (raw: string): NativeIpcRequest => {
  const value = JSON.parse(raw) as NativeIpcRequest;
  if (value?.type !== "native.capture" || !["pi", "codex"].includes(value.harness)
    || typeof value.cwd !== "string" || typeof value.path !== "string" || typeof value.nativeSessionId !== "string") {
    throw new Error("Invalid native daemon request / 原生 Daemon 请求无效");
  }
  return value;
};

export async function nativeDaemonSocketFor(cwd: string): Promise<string | null> {
  const identity = currentIdentityKey();
  if (!identity) return null;
  const root = await canonicalRuntimeRoot(cwd);
  const binding = await getRuntimeSpaceBinding(root, identity);
  return binding ? socketPath(nativeRuntimeRoot(binding.spaceId)) : null;
}

export async function requestNativeDaemon(input: Omit<NativeIpcRequest, "type">): Promise<NativeIpcResponse> {
  const path = await nativeDaemonSocketFor(input.cwd);
  if (!path) return { ok: false, message: "Native Runtime is not bound / 原生 Runtime 未绑定" };
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Native Runtime daemon timed out / 原生 Runtime Daemon 超时")); }, 15_000);
    const finish = (error?: Error, result?: NativeIpcResponse) => {
      clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(result ?? { ok: false, message: "Empty daemon response / Daemon 返回为空" });
    };
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) { finish(new Error("Native daemon response too large")); return; }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try { finish(undefined, JSON.parse(buffer.slice(0, newline)) as NativeIpcResponse); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ type: "native.capture", ...input })}\n`));
  });
}

export async function serveNativeDaemon(input: {
  runtimeRoot: string;
  handle: (request: NativeIpcRequest) => Promise<{ store: NativeSyncStore | null }>;
}): Promise<() => Promise<void>> {
  const path = socketPath(input.runtimeRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await rm(path, { force: true });
  const server: Server = createServer((socket) => {
    let buffer = "";
    let closed = false;
    const respond = (value: NativeIpcResponse) => {
      if (closed) return;
      closed = true;
      socket.end(`${JSON.stringify(value)}\n`);
    };
    socket.setTimeout(20_000, () => socket.destroy());
    socket.once("error", () => { closed = true; });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) { socket.destroy(); return; }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.removeAllListeners("data");
      void (async () => {
        const request = parse(buffer.slice(0, newline));
        const result = await input.handle(request);
        respond({ ok: true, pendingTurns: result.store ? (await result.store.status()).pendingTurns : 0 });
      })().catch((error) => respond({ ok: false, message: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.removeListener("error", reject); resolve(); });
  });
  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(path, { force: true });
  };
}
