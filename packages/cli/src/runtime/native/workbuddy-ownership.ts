import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workbuddyHomeDirectory } from "./workbuddy-transcript.js";

const digest = (value: string, size: number) => createHash("sha1").update(value).digest("hex").slice(0, size);

/** WorkBuddy's own sidecar address; querying it never launches or stops the app. */
export async function workbuddySidecarPath(home = workbuddyHomeDirectory()): Promise<string> {
  const token = digest(home, 12);
  if (process.platform === "win32") return `\\\\.\\pipe\\workbuddy-${token}-sidecar-control`;
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("WorkBuddy sidecar requires the current user identity");
  if (process.platform === "linux") {
    for (const candidate of [process.env.XDG_RUNTIME_DIR, `/run/user/${uid}`]) {
      if (!candidate) continue;
      try { await access(candidate, constants.W_OK); return join(candidate, "workbuddy", token, "sidecar.sock"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  return join(tmpdir(), `wb-${digest(String(uid), 6)}`, token, "sidecar.sock");
}

/** Only a missing socket proves no sidecar owns the source; broken IPC is an error. */
export async function assertWorkBuddySessionAvailable(nativeSessionId: string, options: { home?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<void> {
  options.signal?.throwIfAborted();
  const path = await workbuddySidecarPath(options.home);
  const sessions = await new Promise<string[]>((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => finish(new Error("WorkBuddy sidecar session.list timed out")), options.timeoutMs ?? 2_000);
    let finished = false, buffer = "";
    const abort = () => finish(options.signal?.reason ?? new Error("WorkBuddy ownership check aborted"));
    const finish = (error?: unknown, result: string[] = []) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    socket.on("error", (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? finish() : finish(error));
    socket.on("connect", () => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.list" })}\n`));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { finish(new Error("WorkBuddy sidecar response is too large")); return; }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response: unknown = JSON.parse(buffer.slice(0, newline));
        if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("Invalid WorkBuddy sidecar response");
        const row = response as Record<string, unknown>;
        if (row.jsonrpc !== "2.0" || row.id !== 1 || row.error != null || !Array.isArray(row.result)) throw new Error("Invalid WorkBuddy sidecar session.list response");
        const ids = row.result.map((entry: unknown) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof (entry as { sessionId?: unknown }).sessionId !== "string" || !(entry as { sessionId: string }).sessionId) throw new Error("Invalid WorkBuddy sidecar session identity");
          return (entry as { sessionId: string }).sessionId;
        });
        finish(undefined, ids);
      } catch (error) { finish(error); }
    });
    socket.on("end", () => finish(new Error("WorkBuddy sidecar closed before returning session.list")));
    socket.on("close", () => { if (!finished) finish(new Error("WorkBuddy sidecar connection closed unexpectedly")); });
  });
  if (sessions.includes(nativeSessionId)) throw new Error("Close the WorkBuddy session before continuing in Cohub");
}
