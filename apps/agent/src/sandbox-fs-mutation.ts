import { randomUUID } from "node:crypto";
import type { Job } from "bullmq";
import { spaceFsVersionMatches } from "@cohub/protocol/fs";
import type { RpcEventPayload, RpcMethod, RpcRequestMap } from "@cohub/protocol/sandbox";
import { SandboxRpcError, type SandboxConnection } from "@cohub/sandbox-client";
import { getAgentTracer, wrapToolCall } from "@cohub/infra/tracing/agent";
import { ensureSandboxConnection } from "./sandbox-pool.js";
import { tracedRpc } from "./sandbox/tools.js";
import { runWithToolExecutionContext } from "./tool-context.js";
import { logger } from "./logger.js";
import type {
  AgentSandboxFsMutationJobData,
  AgentSandboxFsMutationJobResult,
  AgentSandboxFsMutationOperation,
} from "./queue.js";

const tracer = getAgentTracer();

type RpcOptions = { onEvent?: (event: RpcEventPayload) => void };

/**
 * Run a sandbox RPC without transparent retry. Mutations are not idempotent:
 * if the operation may have already executed but the response was lost, a
 * retry after infra recovery would re-apply it (duplicate write, move failure,
 * ALREADY_EXISTS on exclusive create). Surface the error instead and let the
 * caller decide through the mutationId idempotency window.
 */
function rpc<M extends RpcMethod>(
  connection: SandboxConnection,
  method: M,
  params: RpcRequestMap[M]["params"],
  options?: RpcOptions,
) {
  return tracedRpc(connection, method, params, options, false);
}

const parentPath = (path: string) => {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
};

async function statOrNull(connection: SandboxConnection, path: string) {
  return rpc(connection, "fs.stat", { path });
}

async function runProcess(connection: SandboxConnection, argv: string[]) {
  let stderr = "";
  const onEvent = (event: RpcEventPayload) => {
    if (event.type === "stderr") stderr += event.chunk;
  };
  const result = await rpc(connection, "process.start", { argv }, { onEvent });
  return { exitCode: result.exitCode, stderr: stderr.trim() };
}

/** Collect workspace-relative directories that do not exist yet, outermost first. */
async function collectMissingDirectories(connection: SandboxConnection, targetDir: string) {
  if (!targetDir) return [];
  const parts = targetDir.split("/").filter(Boolean);
  const missing: string[] = [];
  let prefix = "";
  for (let index = 0; index < parts.length; index += 1) {
    prefix = prefix ? `${prefix}/${parts[index]}` : (parts[index] as string);
    if (missing.length > 0) {
      missing.push(prefix);
      continue;
    }
    const stats = await statOrNull(connection, prefix);
    if (!stats.exists) missing.push(prefix);
  }
  return missing;
}

async function writeMutation(connection: SandboxConnection, mutation: Extract<AgentSandboxFsMutationOperation, { operation: "write" }>): Promise<AgentSandboxFsMutationJobResult> {
  const supportsDisposition = connection.capabilities?.fsWriteDisposition === true;
  const current = mutation.expected || !supportsDisposition
    ? await statOrNull(connection, mutation.path)
    : null;
  if (mutation.expected) {
    if (!spaceFsVersionMatches(current, mutation.expected)) {
      return { ok: false, status: 409, code: "file_conflict", message: "File changed since it was opened." };
    }
  }
  const legacyCreatedDirs = supportsDisposition
    ? []
    : await collectMissingDirectories(connection, parentPath(mutation.path));
  // Pass expected through to the sandbox: the version check and the write run
  // atomically under the sandbox's per-path lock, closing the TOCTOU window
  // between the stat above and the write. mtimeMs is truncated to whole
  // milliseconds to match the Go RPC's int64 field (see matchesSpaceFsVersion).
  // Only forwarded when the sandbox advertises fsWriteExpected: older sandboxes
  // silently ignore unknown fields, which would downgrade a conditional write
  // to an unconditional one.
  const result = await rpc(connection, "fs.write", {
    path: mutation.path,
    content: mutation.content,
    ...(mutation.encoding ? { encoding: mutation.encoding } : {}),
    ...(mutation.exclusive ? { exclusive: true } : {}),
    ...(mutation.expected && connection.capabilities?.fsWriteExpected === true
      ? { expected: { size: mutation.expected.size, mtimeMs: Math.trunc(mutation.expected.mtimeMs) } }
      : {}),
  });
  return {
    ok: true,
    result: {
      path: mutation.path,
      size: result.bytesWritten,
      mtimeMs: result.mtimeMs ?? Date.now(),
      created: mutation.exclusive
        ? true
        : (supportsDisposition ? result.created === true : !current?.exists),
      createdDirs: supportsDisposition ? result.createdDirs ?? [] : legacyCreatedDirs,
    },
  };
}

async function mkdirMutation(connection: SandboxConnection, mutation: Extract<AgentSandboxFsMutationOperation, { operation: "mkdir" }>): Promise<AgentSandboxFsMutationJobResult> {
  if (connection.capabilities?.fsMkdir === true) {
    const result = await rpc(connection, "fs.mkdir", { path: mutation.path });
    return {
      ok: true,
      result: {
        path: mutation.path,
        mtimeMs: result.mtimeMs ?? Date.now(),
        created: result.createdDirs.includes(mutation.path),
        createdDirs: result.createdDirs,
      },
    };
  }
  const createdDirs = await collectMissingDirectories(connection, mutation.path);
  const { exitCode, stderr } = await runProcess(connection, ["mkdir", "-p", "--", mutation.path]);
  if (exitCode !== 0) {
    return { ok: false, status: 400, code: "mkdir_failed", message: stderr || "failed to create directory" };
  }
  const stats = await statOrNull(connection, mutation.path);
  return {
    ok: true,
    result: {
      path: mutation.path,
      mtimeMs: stats?.mtimeMs ?? Date.now(),
      created: createdDirs.includes(mutation.path),
      createdDirs,
    },
  };
}

async function deleteMutation(connection: SandboxConnection, mutation: Extract<AgentSandboxFsMutationOperation, { operation: "delete" }>): Promise<AgentSandboxFsMutationJobResult> {
  const stat = await statOrNull(connection, mutation.path);
  if (!stat?.exists) {
    return { ok: false, status: 404, code: "path_not_found", message: "File or directory not found." };
  }
  const nodeType = stat.isDirectory ? "dir" : "file";
  const argv = stat.isDirectory
    ? (mutation.recursive ? ["rm", "-rf", "--", mutation.path] : ["rmdir", "--", mutation.path])
    : ["rm", "-f", "--", mutation.path];
  const { exitCode, stderr } = await runProcess(connection, argv);
  if (exitCode !== 0) {
    if (/not empty|directory not empty/i.test(stderr)) {
      return { ok: false, status: 400, code: "directory_not_empty", message: "Directory is not empty." };
    }
    return { ok: false, status: 400, code: "delete_failed", message: stderr || "failed to delete" };
  }
  return { ok: true, result: { path: mutation.path, deleted: true, nodeType } };
}

async function moveMutation(connection: SandboxConnection, mutation: Extract<AgentSandboxFsMutationOperation, { operation: "move" }>): Promise<AgentSandboxFsMutationJobResult> {
  const fromStat = await statOrNull(connection, mutation.fromPath);
  if (!fromStat?.exists) {
    return { ok: false, status: 404, code: "path_not_found", message: "File or directory not found." };
  }
  const nodeType = fromStat.isDirectory ? "dir" : "file";
  const targetParent = parentPath(mutation.toPath);
  let createdDirs: string[] = [];
  if (targetParent) {
    if (connection.capabilities?.fsMkdir === true) {
      const directoryResult = await rpc(connection, "fs.mkdir", { path: targetParent });
      createdDirs = directoryResult.createdDirs;
    } else {
      createdDirs = await collectMissingDirectories(connection, targetParent);
      const { exitCode, stderr } = await runProcess(connection, ["mkdir", "-p", "--", targetParent]);
      if (exitCode !== 0) {
        return { ok: false, status: 400, code: "mkdir_failed", message: stderr || "failed to create directory" };
      }
    }
  }
  // Sandbox images use GNU coreutils. -T preserves the API's exact-target
  // rename semantics instead of treating an existing destination as a folder.
  const { exitCode, stderr } = await runProcess(connection, ["mv", "-T", "--", mutation.fromPath, mutation.toPath]);
  if (exitCode !== 0) {
    return { ok: false, status: 400, code: "move_failed", message: stderr || "failed to move" };
  }
  return {
    ok: true,
    result: { fromPath: mutation.fromPath, toPath: mutation.toPath, nodeType, createdDirs },
  };
}

/**
 * Convert sandbox RPC business errors into a structured result. Connection and
 * infrastructure errors return null so the caller lets the job fail; the API
 * then surfaces a retryable error instead of misreporting a completed write.
 */
function mapMutationRpcError(error: unknown): AgentSandboxFsMutationJobResult | null {
  if (error instanceof SandboxRpcError) {
    switch (error.rpcErrorCode) {
      case "NOT_FOUND":
        return { ok: false, status: 404, code: "path_not_found", message: "File or directory not found." };
      case "ALREADY_EXISTS":
        return { ok: false, status: 409, code: "path_exists", message: "A file already exists at this path." };
      case "NOT_DIRECTORY":
        return { ok: false, status: 400, code: "not_a_directory", message: "The selected path is not a directory." };
      case "INVALID_PATH":
      case "ACCESS_DENIED":
        return { ok: false, status: 400, code: "path_invalid", message: "Invalid path." };
      case "READ_ONLY_FILESYSTEM":
        return { ok: false, status: 403, code: "read_only", message: "This path is read-only." };
      case "CONFLICT":
        return { ok: false, status: 409, code: "file_conflict", message: "File changed since it was opened." };
      case "IO_ERROR":
        return null;
      default:
        return { ok: false, status: 500, code: "space_fs_error", message: error.message };
    }
  }
  return null;
}

export async function redactSandboxFsMutationJobPayload(job: Job<AgentSandboxFsMutationJobData>) {
  const data = job.data;
  if (data.mutation.operation !== "write" || data.mutation.content.length === 0) return;
  await job.updateData({
    ...data,
    mutation: { ...data.mutation, content: "" },
  });
}

export async function processSandboxFsMutationJob(job: Job<AgentSandboxFsMutationJobData>): Promise<AgentSandboxFsMutationJobResult> {
  const data = job.data;
  if (!data.spaceId || !data.mutationId || !data.mutation) {
    throw new Error("Invalid sandbox_fs_mutation job payload");
  }

  const toolCallId = `sandbox_fs_mutation_${randomUUID()}`;
  const logMeta = {
    jobId: job.id,
    spaceId: data.spaceId,
    mutationId: data.mutationId,
    operation: data.mutation.operation,
    requestId: data.requestId ?? undefined,
  };

  await job.updateProgress({ stage: "running", ...logMeta }).catch(() => undefined);

  return runWithToolExecutionContext({
    spaceId: data.spaceId,
    sessionId: "",
    llmRound: 0,
    toolCallId,
    requestId: data.requestId ?? undefined,
  }, async () => wrapToolCall(tracer, {
    toolName: "sandbox_fs_mutation",
    input: { operation: data.mutation.operation, mutationId: data.mutationId },
    spaceId: data.spaceId,
    sessionId: "",
    llmRound: 0,
    toolCallId,
    requestId: data.requestId ?? undefined,
  }, async () => {
    const connection = await ensureSandboxConnection(data.spaceId);
    try {
      let result: AgentSandboxFsMutationJobResult;
      switch (data.mutation.operation) {
        case "write":
          result = await writeMutation(connection, data.mutation);
          break;
        case "mkdir":
          result = await mkdirMutation(connection, data.mutation);
          break;
        case "delete":
          result = await deleteMutation(connection, data.mutation);
          break;
        case "move":
          result = await moveMutation(connection, data.mutation);
          break;
      }
      await job.updateProgress({ stage: "completed", ...logMeta }).catch(() => undefined);
      return result;
    } catch (error) {
      const mapped = mapMutationRpcError(error);
      if (mapped) return mapped;
      logger.warn(`[SandboxFsMutation] failed spaceId=${data.spaceId} mutationId=${data.mutationId} operation=${data.mutation.operation}`, error);
      throw error;
    }
  }));
}
