import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { isUuidLike } from "@cohub/protocol";

export async function resolveWorkspaceScanPath(root: string, spaceId: string) {
  if (!isUuidLike(spaceId)) throw new Error("invalid space ID for a workspace scan");
  const base = await realpath(root);
  const expected = join(base, spaceId, "workspace");
  const stat = await lstat(expected);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("workspace root is not a directory");
  const actual = await realpath(expected);
  if (actual !== resolve(expected) || relative(base, actual).startsWith(`..${sep}`)) {
    throw new Error("workspace path escapes the storage root");
  }
  return actual;
}

export function parsePduOutput(stdout: string, stderr: string, code: number | null) {
  // pdu can return exit 0 with a partial tree after a filesystem error.
  if (code !== 0 || stderr.trim()) throw new Error("pdu did not finish the workspace scan");
  const value = JSON.parse(stdout.trim());
  if (value?.pdu !== "0.24.0" || value?.["schema-version"] !== "2026-04-02" || value?.unit !== "bytes"
      || !Number.isSafeInteger(value?.tree?.size) || value.tree.size < 0) {
    throw new Error("unexpected pdu output");
  }
  return value.tree.size as number;
}

export async function scanWorkspaceUsage(input: {
  path: string; threads: number; timeoutMs: number; signal?: AbortSignal; binary?: string;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let failure: Error | null = null;
    const child = spawn(input.binary ?? process.env.WORKSPACE_USAGE_PDU_PATH ?? "pdu", [
      `--threads=${input.threads}`, "--quantity=block-size", "--deduplicate-hardlinks",
      "--one-file-system", "--json-output", "--max-depth=1", "--no-sort",
      "--omit-json-shared-details", "--omit-json-shared-summary", "--", input.path,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const stop = (message: string) => {
      failure ??= new Error(message);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop("workspace scan timed out"), input.timeoutMs);
    const abort = () => stop("workspace scan lease lost");
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > 64 * 1024) stop("pdu output exceeded 64 KiB");
      else stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 16 * 1024) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => { failure = error; });
    child.on("close", (code) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      if (failure) return reject(failure);
      try { resolve(parsePduOutput(stdout, stderr, code)); } catch (error) { reject(error); }
    });
  });
}
