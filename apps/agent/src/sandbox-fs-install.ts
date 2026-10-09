import { posix } from "node:path";
import { randomUUID } from "node:crypto";
import type { Job } from "bullmq";
import { SPACE_FS_STAGING_PREFIX } from "@cohub/core/space-fs";
import type { RpcEventPayload } from "@cohub/protocol/sandbox";
import { getAgentTracer, wrapToolCall } from "@cohub/infra/tracing/agent";
import { SandboxRpcError, type SandboxConnection } from "@cohub/sandbox-client";
import { connectAtomicInstallSandbox } from "./sandbox-atomic-install.js";
import { tracedRpc } from "./sandbox/tools.js";
import { runWithToolExecutionContext } from "./tool-context.js";
import { logger } from "./logger.js";
import type {
  AgentSandboxFsInstallEntry,
  AgentSandboxFsInstallEntryResult,
  AgentSandboxFsInstallJobData,
  AgentSandboxFsInstallJobResult,
} from "./queue.js";

const tracer = getAgentTracer();

// `mv -n` exit codes vary across coreutils versions, so the outcome is read from the filesystem.
const INSTALL_TREE_SCRIPT = [
  '[ -e "$1" ] || [ -L "$1" ] || exit 2',
  'mv -T -n -- "$1" "$2"',
  'if [ -e "$1" ] || [ -L "$1" ]; then if [ -e "$2" ] || [ -L "$2" ]; then exit 3; fi; exit 2; fi',
].join("\n");

const isSafeRelativePath = (path: string) =>
  path.length > 0 && !path.startsWith("/") && !path.includes("\0") && posix.normalize(path) === path &&
  path !== ".." && !path.startsWith("../");

function isValidEntry(entry: AgentSandboxFsInstallEntry) {
  return isSafeRelativePath(entry.path) &&
    isSafeRelativePath(entry.stagingPath) &&
    posix.basename(entry.stagingPath).startsWith(SPACE_FS_STAGING_PREFIX) &&
    posix.dirname(entry.stagingPath) === posix.dirname(entry.path) &&
    (entry.kind === "file" || entry.kind === "tree");
}

async function installFile(connection: SandboxConnection, entry: AgentSandboxFsInstallEntry): Promise<AgentSandboxFsInstallEntryResult> {
  try {
    await tracedRpc(connection, "fs.write", {
      path: entry.path,
      content: "",
      sourcePath: entry.stagingPath,
      ...(entry.expected
        ? { expected: { size: entry.expected.size, mtimeMs: Math.trunc(entry.expected.mtimeMs) } }
        : { exclusive: true }),
    }, undefined, false);
    return { path: entry.path, ok: true };
  } catch (error) {
    if (!(error instanceof SandboxRpcError)) throw error;
    if (error.rpcErrorCode === "ALREADY_EXISTS") {
      return { path: entry.path, ok: false, code: "path_exists", message: "a file appeared at this path while copying" };
    }
    if (error.rpcErrorCode === "CONFLICT") {
      return { path: entry.path, ok: false, code: "file_conflict", message: "the file changed while copying" };
    }
    return { path: entry.path, ok: false, code: "install_failed", message: error.message };
  }
}

async function installTree(connection: SandboxConnection, entry: AgentSandboxFsInstallEntry): Promise<AgentSandboxFsInstallEntryResult> {
  let stderr = "";
  const onEvent = (event: RpcEventPayload) => {
    if (event.type === "stderr") stderr += event.chunk;
  };
  const result = await tracedRpc(connection, "process.start", {
    argv: ["sh", "-c", INSTALL_TREE_SCRIPT, "sh", entry.stagingPath, entry.path],
  }, { onEvent }, false);
  if (result.exitCode === 0) return { path: entry.path, ok: true };
  if (result.exitCode === 3) {
    return { path: entry.path, ok: false, code: "path_exists", message: "a file or directory appeared at this path while copying" };
  }
  return { path: entry.path, ok: false, code: "install_failed", message: stderr.trim() || "failed to install the copied entry" };
}

export async function processSandboxFsInstallJob(job: Job<AgentSandboxFsInstallJobData>): Promise<AgentSandboxFsInstallJobResult> {
  const data = job.data;
  if (!data.spaceId || !data.installId || !Array.isArray(data.entries)) {
    throw new Error("Invalid sandbox_fs_install job payload");
  }
  if (!data.entries.every(isValidEntry)) {
    return { ok: false, status: 400, code: "path_invalid", message: "invalid install entry" };
  }

  const toolCallId = `sandbox_fs_install_${randomUUID()}`;
  return runWithToolExecutionContext({
    spaceId: data.spaceId,
    sessionId: "",
    llmRound: 0,
    toolCallId,
    requestId: data.requestId ?? undefined,
  }, async () => wrapToolCall(tracer, {
    toolName: "sandbox_fs_install",
    input: { installId: data.installId, entries: data.entries.length },
    spaceId: data.spaceId,
    sessionId: "",
    llmRound: 0,
    toolCallId,
    requestId: data.requestId ?? undefined,
  }, async () => {
    const connection = await connectAtomicInstallSandbox(data.spaceId, "copy_requires_atomic_install");
    if (!connection) {
      return { ok: false, status: 503, code: "sandbox_unsupported", message: "sandbox must be upgraded before files can be copied" };
    }
    const results: AgentSandboxFsInstallEntryResult[] = [];
    for (const [index, entry] of data.entries.entries()) {
      try {
        results.push(entry.kind === "file" ? await installFile(connection, entry) : await installTree(connection, entry));
      } catch (error) {
        logger.warn(`[SandboxFsInstall] sandbox unavailable mid-install spaceId=${data.spaceId} installId=${data.installId}`, error);
        for (const pending of data.entries.slice(index)) {
          results.push({ path: pending.path, ok: false, code: "install_failed", message: "the sandbox became unavailable while copying" });
        }
        break;
      }
    }
    const failed = results.filter((result) => !result.ok).length;
    if (failed > 0) {
      logger.warn(`[SandboxFsInstall] entries not installed spaceId=${data.spaceId} installId=${data.installId} failed=${failed}/${results.length}`);
    }
    return { ok: true, results };
  }));
}
