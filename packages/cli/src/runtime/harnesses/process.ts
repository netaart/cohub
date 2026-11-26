import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import type { ContentBlock, RuntimeTurnInput } from "@neta-art/cohub";
import { RpcProcessClosedError, type JsonRpcProcess } from "../json-rpc.js";
import { ProcessCleanupUncertainError } from "../process-group.js";
import { downloadPublicImage } from "../../safe-remote-image.js";
import { serializeDiagnosticError, type RuntimeDiagnosticContext, type RuntimeDiagnostics } from "../diagnostics.js";
import type { HarnessResult } from "./types.js";

export const text = (value: unknown) => typeof value === "string" ? value : "";
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
/** Epoch seconds; larger values (milliseconds) are rejected. */
export const epochSecondsIso = (value: unknown) => typeof value === "number" && value > 0 && value < 253_402_300_800 ? new Date(value * 1000).toISOString() : null;

/** Aborted streams leave tool calls with an empty id or name. */
export const identifiable = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export function harnessExecutableCandidates(binary: string, cwd: string, path: string, platform = process.platform, pathExt = process.env.PATHEXT): string[] {
  const windows = platform === "win32";
  const paths = windows ? win32 : { delimiter, join, resolve };
  // Windows runs only PATHEXT names; npm/pnpm also write an extensionless sh script beside the .cmd shim.
  const extensions = windows && !win32.extname(binary)
    ? (pathExt || ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => /^\.[a-z0-9]+$/i.test(ext))
    : [""];
  const roots = binary.includes("/") || binary.includes("\\")
    ? [paths.resolve(cwd, binary)]
    : path.split(paths.delimiter).map((directory) => directory.replace(/^"(.*)"$/, "$1")).filter(Boolean).map((directory) => paths.resolve(cwd, directory, binary));
  return roots.flatMap((root) => extensions.map((ext) => `${root}${ext}`));
}

/**
 * Windows npm/pnpm installs expose harnesses as .cmd shims, which cannot be spawned
 * without a shell. Run an .exe directly, or the shim's Node entry with this Node.
 */
export function harnessCommand(binary: string, args: string[], cwd: string): [string, string[]] {
  if (process.platform !== "win32") return [binary, args];
  const path = harnessExecutableCandidates(binary, cwd, process.env.PATH ?? "").find((candidate) => statSync(candidate, { throwIfNoEntry: false })?.isFile());
  if (!path) throw new Error(`${binary} was not found on PATH`);
  const extension = win32.extname(path).toLowerCase();
  if (extension === ".exe" || extension === ".com") return [path, args];
  if ([".js", ".mjs", ".cjs"].includes(extension)) return [process.execPath, [path, ...args]];
  if (extension === ".cmd") {
    // npm (cmd-shim): SET "_prog=node" … "%dp0%\entry" %*; pnpm (@zkochan/cmd-shim): node  "%~dp0\entry" %*
    const shim = readFileSync(path, "utf8");
    const runsNode = /SET "_prog=node"/i.test(shim) || /^\s*node\s+"%~dp0\\/im.test(shim);
    const entry = runsNode ? /"%~?dp0%?\\([^"]+)"\s+%\*/i.exec(shim)?.[1] : undefined;
    if (entry) return [process.execPath, [win32.join(win32.dirname(path), entry), ...args]];
  }
  throw new Error(`Cannot run ${path} without a shell; pass its executable option with an .exe or Node script`);
}

const execute = promisify(execFile);

/** A discovery command: mise shims never install tools for it, and it is killed at its timeout. */
export function probe(command: [string, string[]], cwd: string, timeout: number, env: NodeJS.ProcessEnv = process.env) {
  return execute(...command, { cwd, encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...env, MISE_OFFLINE: "1" } });
}

type ToolUse = Extract<ContentBlock, { type: "tool_use" }>;

export const runningTool = (block: ToolUse, startedAt = new Date().toISOString()): ToolUse => ({ ...block, _meta: { ...block._meta, toolStatus: "running", timing: { startedAt } } });

export function toolTiming(startedAt: unknown, completedAt: unknown = new Date().toISOString()): { _meta?: { timing: { startedAt: string; completedAt: string; durationMs: number } } } {
  const start = typeof startedAt === "string" ? Date.parse(startedAt) : Number.NaN;
  const end = typeof completedAt === "string" ? Date.parse(completedAt) : Number.NaN;
  if (!(end >= start)) return {};
  return { _meta: { timing: { startedAt: new Date(start).toISOString(), completedAt: new Date(end).toISOString(), durationMs: end - start } } };
}

/** Private per-user state shared by this machine's Runtimes, outside any harness's own data. */
export const localStateDirectory = () => join(process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state"), "cohub");

/** Variables a Turn's tools see, so a `cohub` call inside a tool knows where it runs. */
export const turnEnvironment = (input: RuntimeTurnInput) => ({ COHUB_SPACE_ID: input.spaceId, COHUB_SESSION_ID: input.sessionId, COHUB_TURN_ID: input.turnId });

export async function inlineImage(block: Extract<ContentBlock, { type: "image" }>) {
  if (block.source.type === "base64") return { type: "image" as const, data: block.source.data, mimeType: block.source.media_type };
  const image = await downloadPublicImage(block.source.url);
  return { type: "image" as const, data: Buffer.from(image.bytes).toString("base64"), mimeType: image.mimeType };
}

export type ImageBlock = Extract<ContentBlock, { type: "image" }>;
const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** An image as a private file `<name>.<ext>` in `directory`, for CLIs that take images by path. */
export async function writeImage(block: ImageBlock, directory: string, name: string): Promise<string> {
  const image = await inlineImage(block);
  const path = join(directory, `${name}.${IMAGE_EXTENSIONS[image.mimeType] ?? "png"}`);
  await writeFile(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
  return path;
}

export function watchHost(host: JsonRpcProcess, diagnostics: RuntimeDiagnostics | undefined, context: RuntimeDiagnosticContext | undefined): () => void {
  if (!diagnostics) return () => undefined;
  const offFailure = host.onFailure((error) => {
    if (!(error instanceof RpcProcessClosedError)) diagnostics.log("error", "harness.rpc_process_failed", { error: serializeDiagnosticError(error) }, { ...context, component: "harness" });
  });
  const offTimeout = host.onTimeout((method, timeoutMs) => diagnostics.log("error", "harness.rpc_timeout", { method, timeoutMs }, { ...context, component: "harness" }));
  return () => { offFailure(); offTimeout(); };
}

/** Close a harness process Cohub started. An unconfirmable cleanup marks the result uncertain; it never masks it. */
export async function closeHost(host: JsonRpcProcess, executionError: string | null | undefined): Promise<HarnessResult["uncertainCleanup"]> {
  return await host.close().then(
    () => undefined,
    (cleanupError: unknown) => {
      const processGroupId = host.processGroupId;
      if (!(cleanupError instanceof ProcessCleanupUncertainError) || processGroupId == null) throw cleanupError;
      const detail = executionError ? `; execution error: ${executionError}` : "";
      return { processGroupId, error: `${cleanupError.message}${detail}` };
    },
  );
}
