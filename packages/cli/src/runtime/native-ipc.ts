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
  sessionStartedAt?: string;
  origin?: "local_import";
};
export type NativeIpcResponse = { ok: true; pendingTurns: number } | { ok: false; skipped?: true; message: string };

/**
 * `store: null` means the request was valid but nothing was applicable yet (an unbound
 * workspace, or a transcript a harness has not written). That is not a sync failure, so
 * clients stay silent instead of warning about it.
 */
export async function nativeCaptureResponse(result: { store: NativeSyncStore | null }): Promise<NativeIpcResponse> {
  if (!result.store) return { ok: false, skipped: true, message: "No native capture is pending" };
  return { ok: true, pendingTurns: (await result.store.status()).pendingTurns };
}

const parse = (raw: string): NativeIpcRequest => {
  const value = JSON.parse(raw) as NativeIpcRequest;
  if (value?.type !== "native.capture" || !["pi", "codex"].includes(value.harness)
    || typeof value.cwd !== "string" || typeof value.path !== "string" || typeof value.nativeSessionId !== "string"
    || value.origin !== undefined && value.origin !== "local_import"
    || value.sessionStartedAt !== undefined && typeof value.sessionStartedAt !== "string") {
    throw new Error("Invalid native daemon request");
  }
  return value;
};

export async function nativeDaemonSocketFor(cwd: string): Promise<string | null> {
  const identity = currentIdentityKey();
  if (!identity) return null;
  // A vanished workspace is unbound, not an error; the terminal has nothing left to sync.
  const root = await canonicalRuntimeRoot(cwd).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
  if (!root) return null;
  const binding = await getRuntimeSpaceBinding(root, identity);
  return binding ? socketPath(nativeRuntimeRoot(binding.spaceId)) : null;
}

export async function requestNativeDaemon(input: Omit<NativeIpcRequest, "type">): Promise<NativeIpcResponse> {
  const path = await nativeDaemonSocketFor(input.cwd);
  // An unbound workspace is a normal state, not an error the terminal should surface.
  if (!path) return { ok: false, skipped: true, message: "Native Runtime is not bound" };
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Native Runtime daemon timed out")); }, 15_000);
    const finish = (error?: Error, result?: NativeIpcResponse) => {
      clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(result ?? { ok: false, message: "Empty daemon response" });
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
        respond(await nativeCaptureResponse(result));
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
