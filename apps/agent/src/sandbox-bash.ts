import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { UnrecoverableError, type Job } from "bullmq";
import { recordJobFailure } from "@cohub/infra/bullmq";
import { getAgentTracer, wrapToolCall } from "@cohub/infra/tracing/agent";
import { SandboxRpcError, type SandboxConnection } from "@cohub/sandbox-client";
import { createSandboxCodingTools, tracedRpc } from "./sandbox/tools.js";
import { connectAtomicInstallSandbox } from "./sandbox-atomic-install.js";
import {
  sandboxUploadUnsupportedErrorMessage,
  supportsAtomicUpload,
} from "./sandbox-upload-capabilities.js";
import { runWithToolExecutionContext } from "./tool-context.js";
import { logger } from "./logger.js";
import { AGENT_SANDBOX_BASH_ATOMIC_JOB_NAME, type AgentSandboxBashUploadJobData } from "./queue.js";
import { loadSpaceEnvSnapshot } from "./runtime/env-cache.js";
import { ensureSandboxConnection } from "./sandbox-pool.js";

const SCRIPT_PATH = new URL("./jobs/sandbox-bash/upload-files.sh", import.meta.url);
const tools = createSandboxCodingTools();
const tracer = getAgentTracer();

async function loadScript() {
  return readFile(SCRIPT_PATH, "utf8");
}

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function toBase64(value: string) {
  return Buffer.from(value, "utf8").toString("base64");
}

function buildManifest(data: AgentSandboxBashUploadJobData) {
  return data.files
    .map((file) => [toBase64(file.relativePath), String(file.size), toBase64(file.downloadUrl)].join("\t"))
    .join("\n");
}

async function buildUploadCommand(data: AgentSandboxBashUploadJobData) {
  const script = await loadScript();
  const manifest = buildManifest(data);
  return [
    "set -euo pipefail",
    "script_path=$(mktemp /tmp/cohub-upload-files.XXXXXX.sh)",
    "trap 'rm -f \"$script_path\"' EXIT",
    "cat > \"$script_path\" <<'COHUB_UPLOAD_SCRIPT'",
    script.trimEnd(),
    "COHUB_UPLOAD_SCRIPT",
    "chmod +x \"$script_path\"",
    `MATERIALIZE_MODE=${shellSingleQuote(data.materialize === "atomic" ? "stage" : "replace")} UPLOAD_ROOT=${shellSingleQuote(data.destinationRoot)} bash "$script_path" <<'COHUB_UPLOAD_MANIFEST'`,
    manifest,
    "COHUB_UPLOAD_MANIFEST",
  ].join("\n");
}

function extractResultText(result: unknown) {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "text"
      ? String((item as { text?: unknown }).text ?? "")
      : "")
    .join("");
}

function getExitCode(result: unknown) {
  if (!result || typeof result !== "object") return null;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return null;
  const exitCode = (details as { exitCode?: unknown }).exitCode;
  return typeof exitCode === "number" ? exitCode : null;
}

function extractRawOutput(result: unknown) {
  if (!result || typeof result !== "object") return "";
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return "";
  const rawOutput = (details as { rawOutput?: unknown }).rawOutput;
  return typeof rawOutput === "string" ? rawOutput : "";
}

type UploadedFile = {
  path: string;
  name: string;
  size: number;
  mimeType: string | null;
  mtimeMs: number;
};

type StagedFile = {
  file: AgentSandboxBashUploadJobData["files"][number];
  targetPath: string;
  sourcePath: string;
};

function parseUploadedLines(output: string, data: AgentSandboxBashUploadJobData): UploadedFile[] {
  const expected = new Map(data.files.map((file) => [file.relativePath, file]));
  const uploaded = new Map<string, UploadedFile>();

  for (const line of output.split(/\r?\n/)) {
    const [kind, relativePath, targetPath] = line.split("\t");
    if (kind !== "uploaded" || !relativePath || !targetPath) continue;
    const file = expected.get(relativePath);
    if (!file) continue;
    uploaded.set(relativePath, {
      path: targetPath,
      name: file.name,
      size: file.size,
      mimeType: file.mimeType,
      mtimeMs: Date.now(),
    });
  }

  if (uploaded.size !== data.files.length) {
    throw new Error(`Uploaded file count mismatch: expected ${data.files.length}, got ${uploaded.size}`);
  }

  return [...uploaded.values()];
}

function parseStagedLines(output: string, data: AgentSandboxBashUploadJobData): StagedFile[] {
  const expected = new Map(data.files.map((file) => [file.relativePath, file]));
  const staged = new Map<string, StagedFile>();

  for (const line of output.split(/\r?\n/)) {
    const [kind, relativePath, targetPath, sourcePath] = line.split("\t");
    if (kind !== "staged" || !relativePath || !targetPath || !sourcePath) continue;
    const file = expected.get(relativePath);
    if (!file) continue;
    staged.set(relativePath, { file, targetPath, sourcePath });
  }

  if (staged.size !== data.files.length) {
    throw new Error(`Staged file count mismatch: expected ${data.files.length}, got ${staged.size}`);
  }

  return [...staged.values()];
}

function stagedSourcePaths(output: string) {
  return output.split(/\r?\n/).flatMap((line) => {
    const [kind, , , sourcePath] = line.split("\t");
    return kind === "staged" && sourcePath ? [sourcePath] : [];
  });
}

function stagedPathBatches(paths: string[]) {
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const pathBytes = Buffer.byteLength(path, "utf8") + 16;
    if (batch.length > 0 && (batch.length >= 200 || bytes + pathBytes > 48 * 1024)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(path);
    bytes += pathBytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

async function cleanupStagedFiles(spaceId: string, paths: string[]) {
  const uniquePaths = [...new Set(paths)];
  if (uniquePaths.length === 0) return;
  let connection: SandboxConnection;
  try {
    connection = await ensureSandboxConnection(spaceId);
  } catch (error) {
    logger.warn("[SandboxBash] failed to connect while cleaning staged upload files", {
      spaceId,
      fileCount: uniquePaths.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  for (const batch of stagedPathBatches(uniquePaths)) {
    try {
      const result = await tracedRpc(connection, "process.start", {
        argv: ["rm", "-f", "--", ...batch],
        cwd: "/workspace",
        timeoutSecs: 60,
      }, undefined, false);
      if (result.exitCode !== 0) {
        logger.warn("[SandboxBash] staged upload cleanup command failed", {
          spaceId,
          fileCount: batch.length,
          exitCode: result.exitCode,
        });
      }
    } catch (error) {
      logger.warn("[SandboxBash] failed to clean staged upload files", {
        spaceId,
        fileCount: batch.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function throwSandboxUploadUnsupported(): never {
  throw new UnrecoverableError(sandboxUploadUnsupportedErrorMessage());
}

async function ensureAtomicUploadConnection(spaceId: string) {
  return await connectAtomicInstallSandbox(spaceId, "upload_requires_atomic_materialization")
    ?? throwSandboxUploadUnsupported();
}

async function materializeAtomicUpload(data: AgentSandboxBashUploadJobData, output: string): Promise<UploadedFile[]> {
  const staged = parseStagedLines(output, data);
  const sources = staged.map((item) => item.sourcePath);
  const connection = await ensureSandboxConnection(data.spaceId);
  if (!supportsAtomicUpload(connection.capabilities)) {
    throwSandboxUploadUnsupported();
  }

  const uploaded: UploadedFile[] = [];
  try {
    for (const item of staged) {
      const targetVersion = item.file.targetVersion;
      if (!targetVersion) {
        throw new UnrecoverableError(`upload_conflict: missing upload target version for ${item.file.relativePath}`);
      }
      const result = await tracedRpc(connection, "fs.write", {
        path: item.targetPath,
        content: "",
        sourcePath: item.sourcePath,
        ...(targetVersion.exists
          ? { expected: { size: targetVersion.size, mtimeMs: targetVersion.mtimeMs } }
          : { exclusive: true }),
      }, undefined, false);
      uploaded.push({
        path: item.targetPath,
        name: item.file.name,
        size: result.bytesWritten,
        mimeType: item.file.mimeType,
        mtimeMs: result.mtimeMs ?? Date.now(),
      });
    }
    await cleanupStagedFiles(data.spaceId, sources);
    return uploaded;
  } catch (error) {
    if (error instanceof SandboxRpcError && (error.rpcErrorCode === "CONFLICT" || error.rpcErrorCode === "ALREADY_EXISTS" || error.rpcErrorCode === "NOT_DIRECTORY")) {
      const conflict = staged[uploaded.length]?.file.relativePath ?? "unknown";
      throw new UnrecoverableError(`upload_conflict: ${conflict}`);
    }
    throw error;
  }
}

export async function processSandboxBashJob(job: Job<AgentSandboxBashUploadJobData>) {
  const data = job.data;
  if (!data.spaceId || !data.sessionId || !data.uploadId || !data.destinationRoot || !Array.isArray(data.files)) {
    throw new Error("Invalid sandbox_bash upload job payload");
  }
  if (job.name === AGENT_SANDBOX_BASH_ATOMIC_JOB_NAME && data.materialize !== "atomic") {
    throw new Error("Atomic sandbox upload job is missing its materialization mode");
  }
  if (data.materialize === "atomic" && data.files.some((file) => !file.targetVersion)) {
    throw new UnrecoverableError("upload_conflict: upload target version is unavailable");
  }
  if (data.materialize === "atomic") {
    await ensureAtomicUploadConnection(data.spaceId);
  }

  const bashTool = tools.find((tool) => tool.name === "bash");
  if (!bashTool) throw new Error("bash tool is not available");

  const command = await buildUploadCommand(data);
  const toolCallId = `sandbox_bash_${randomUUID()}`;
  const totalBytes = data.files.reduce((sum, file) => sum + file.size, 0);
  const logMeta = {
    jobId: job.id,
    spaceId: data.spaceId,
    sessionId: data.sessionId,
    uploadId: data.uploadId,
    destinationRoot: data.destinationRoot,
    fileCount: data.files.length,
    totalBytes,
    firstFile: data.files[0]?.relativePath,
    requestId: data.requestId ?? undefined,
  };
  let latestOutput = "";

  await job.updateProgress({
    stage: "running",
    ...logMeta,
  });

  const spaceEnv = await loadSpaceEnvSnapshot(data.spaceId);
  const executionContext = {
    spaceId: data.spaceId,
    sessionId: data.sessionId,
    spaceEnv,
    llmRound: 0,
    toolCallId,
    requestId: data.requestId ?? undefined,
  };
  await runWithToolExecutionContext(executionContext, async () => wrapToolCall(tracer, {
    toolName: "sandbox_bash",
    input: { task: "upload_files", uploadId: data.uploadId, files: data.files.length },
    spaceId: data.spaceId,
    sessionId: data.sessionId,
    llmRound: 0,
    toolCallId,
    requestId: data.requestId ?? undefined,
  }, async () => {
    const result = await bashTool.execute(
      toolCallId,
      { command, timeout: 3600 } as never,
      undefined,
      (partial) => {
        const text = extractResultText(partial);
        if (text) latestOutput = text;
      },
    );
    latestOutput = extractRawOutput(result) || extractResultText(result) || latestOutput;
    const exitCode = getExitCode(result);
    if (exitCode !== 0) {
      if (data.materialize === "atomic") {
        await cleanupStagedFiles(data.spaceId, stagedSourcePaths(latestOutput));
      }
      const error = new Error(latestOutput || `sandbox_bash upload_files failed with exit code ${exitCode ?? "unknown"}`);
      const failure = await recordJobFailure(job, error, {
        reason: "sandbox_bash_command_failed",
        meta: {
          ...logMeta,
          exitCode,
          outputTail: latestOutput.slice(-2000),
        },
      });
      logger.error("[SandboxBash] upload command failed", failure);
      if (exitCode === 3) throw new UnrecoverableError(`upload_size_mismatch: ${error.message}`);
      if (exitCode === 2 || exitCode === 127) throw new UnrecoverableError(error.message);
      throw error;
    }
  }));

  try {
    const uploaded = data.materialize === "atomic"
      ? await runWithToolExecutionContext(executionContext, () => materializeAtomicUpload(data, latestOutput))
      : parseUploadedLines(latestOutput, data);
    await job.updateProgress({
      stage: "completed",
      ...logMeta,
      uploadedCount: uploaded.length,
      firstUploadedPath: uploaded[0]?.path,
    });
    return { ok: true, uploaded, output: latestOutput };
  } catch (error) {
    if (data.materialize === "atomic") {
      await runWithToolExecutionContext(executionContext, () =>
        cleanupStagedFiles(data.spaceId, stagedSourcePaths(latestOutput)),
      );
    }
    const failure = await recordJobFailure(job, error, {
      reason: data.materialize === "atomic" ? "sandbox_bash_materialize_failed" : "sandbox_bash_result_parse_failed",
      meta: {
        ...logMeta,
        outputTail: latestOutput.slice(-2000),
      },
    });
    logger.error("[SandboxBash] upload result parse failed", error, failure);
    throw error;
  }
}
