import { createHash, randomUUID } from "node:crypto";
import { createLogger } from "@cohub/infra/logging";
import * as direct from "./space-fs.js";
import * as remote from "./space-fs-remote.js";
import { getSpaceSandboxBySpaceId } from "./space-sandboxes.js";
import { isSandboxDialable } from "@cohub/sandbox-controller";
import type { AgentSandboxFsMutationOperation } from "@cohub/infra/agent-queue";
import type { SpaceFsUploadResponse } from "@cohub/protocol/fs";
import { enqueueSandboxFsMutationJob, SandboxFsMutationTimeoutError } from "./sandbox-fs-mutation-queue.js";
import { SpaceFsError, assertSafeRelativePath } from "./space-fs.js";
import { writeUploadsThroughSandbox } from "./space-fs-upload.js";

const logger = createLogger({ serviceName: "cohub-api" });

// Provider-aware facade over the space filesystem. Cloud spaces read/write the
// shared PVC directly (the existing implementation); local spaces are served
// over the sandbox RPC relay against the user's machine. Routes depend on this
// module so they stay provider-agnostic.
//
// Mutations carry an internal event-ownership outcome: cloud sandbox changes
// are observed by the agent watcher, while direct PVC and local relay changes
// are published by the API route.

const PROVIDER_CACHE_TTL_MS = 30_000;
const providerCache = new Map<string, { provider: "cloud" | "local"; expiresAt: number }>();

async function isLocal(spaceId: string): Promise<boolean> {
  const now = Date.now();
  const cached = providerCache.get(spaceId);
  if (cached && cached.expiresAt > now) return cached.provider === "local";
  const sandbox = await getSpaceSandboxBySpaceId(spaceId);
  const provider = sandbox?.provider === "local" ? "local" : "cloud";
  providerCache.set(spaceId, { provider, expiresAt: now + PROVIDER_CACHE_TTL_MS });
  return provider === "local";
}

type Visibility = Parameters<typeof direct.listSpaceDirectory>[2];

/** Internal event ownership marker stripped by routes before responding. */
type ApiEventOutcome<T> = T & { executedBy: "api" };
type SandboxEventOutcome<T> = T & { executedBy: "sandbox" };

/** Exact success shapes returned by the sandbox mutation agent job. */
type SandboxWriteResult = { path: string; size: number; mtimeMs: number; created: boolean; createdDirs: string[] };
type SandboxMkdirResult = { path: string; mtimeMs: number; created: boolean; createdDirs: string[] };
type SandboxDeleteResult = { path: string; deleted: boolean; nodeType: "file" | "dir" | "unknown" };
type SandboxMoveResult = { fromPath: string; toPath: string; nodeType: "file" | "dir" | "unknown"; createdDirs: string[] };

type SandboxMutationResultFor<Op extends AgentSandboxFsMutationOperation> =
  Op extends { operation: "write" } ? SandboxWriteResult
    : Op extends { operation: "mkdir" } ? SandboxMkdirResult
      : Op extends { operation: "delete" } ? SandboxDeleteResult
        : SandboxMoveResult;

/** True when a cloud space's sandbox is currently dialable (ready + endpoint). */
async function isCloudSandboxDialable(spaceId: string): Promise<boolean> {
  const sandbox = await getSpaceSandboxBySpaceId(spaceId);
  return isSandboxDialable(sandbox);
}

/**
 * Sandbox mutations bypass the direct PVC backend's path guards, so every path
 * must be re-validated here before it reaches the agent (process.start has no
 * cwd constraint on absolute paths and could escape the workspace).
 */
function validateSandboxMutationPaths(mutation: AgentSandboxFsMutationOperation): AgentSandboxFsMutationOperation {
  switch (mutation.operation) {
    case "write":
      return { ...mutation, path: assertSafeRelativePath(mutation.path) };
    case "mkdir":
      return { ...mutation, path: assertSafeRelativePath(mutation.path) };
    case "delete":
      return { ...mutation, path: assertSafeRelativePath(mutation.path) };
    case "move":
      return {
        ...mutation,
        fromPath: assertSafeRelativePath(mutation.fromPath),
        toPath: assertSafeRelativePath(mutation.toPath),
      };
    case "reconcile":
      return mutation;
  }
}

/**
 * Accept safe, stable tokens for the job id. Non-conforming client ids are
 * hashed so retries still map to the same job; absent ids get a fresh one.
 */
function normalizeMutationId(mutationId: string | undefined): string {
  if (!mutationId) return randomUUID();
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(mutationId)) return mutationId;
  return `h${createHash("sha1").update(mutationId).digest("hex").slice(0, 32)}`;
}

/**
 * Run a mutation inside a cloud sandbox through the agent. The agent executes
 * against its existing connection pool, so sandbox-local watchers observe the
 * change; this path never falls back to a direct PVC write.
 */
async function runCloudSandboxMutation<Op extends AgentSandboxFsMutationOperation>(
  spaceId: string,
  mutation: Op,
  mutationId?: string,
): Promise<SandboxMutationResultFor<Op>> {
  try {
    const result = await enqueueSandboxFsMutationJob({
      spaceId,
      mutationId: normalizeMutationId(mutationId),
      mutation: validateSandboxMutationPaths(mutation),
    });
    if (!result.ok) {
      throw new SpaceFsError(result.status, result.code, result.message);
    }
    return result.result as SandboxMutationResultFor<Op>;
  } catch (error) {
    if (error instanceof SandboxFsMutationTimeoutError) {
      throw new SpaceFsError(504, "sandbox_mutation_timeout", "File operation timed out. Retry the same request.");
    }
    throw error;
  }
}

function asSandboxOutcome<T extends object>(result: T): SandboxEventOutcome<T> {
  return { ...result, executedBy: "sandbox" };
}

function asApiEventOutcome<T extends object>(result: T): ApiEventOutcome<T> {
  return { ...result, executedBy: "api" };
}

/**
 * Writes straight to the workspace volume, which only happens while no
 * sandbox is dialable. A sandbox's watcher never sees these writes, and one
 * that became dialable meanwhile may already have indexed past the change,
 * so it is told to reconcile before the write is reported done. Sandboxes
 * start indexing only after the API sees them as ready, so a write that
 * finishes while none is dialable is always covered by the first reconcile.
 */
async function runDirectMutation<T extends object>(spaceId: string, mutate: () => Promise<T>): Promise<ApiEventOutcome<T>> {
  try {
    return asApiEventOutcome(await mutate());
  } finally {
    await reconcileSandboxAfterDirectWrite(spaceId);
  }
}

async function reconcileSandboxAfterDirectWrite(spaceId: string): Promise<void> {
  try {
    if (!(await isCloudSandboxDialable(spaceId))) return;
    await runCloudSandboxMutation(spaceId, { operation: "reconcile" });
  } catch (error) {
    // The write's own outcome stands: failing a completed write would invite
    // retries of non-idempotent operations. The sandbox index may miss it.
    logger.error(`[space-fs] sandbox reconcile after a direct write failed spaceId=${spaceId}`, error);
  }
}

export async function listSpaceDirectory(spaceId: string, path?: string, options?: Visibility) {
  return (await isLocal(spaceId))
    ? remote.listSpaceDirectory(spaceId, path, options)
    : direct.listSpaceDirectory(spaceId, path, options);
}

export async function readSpaceFile(spaceId: string, path: string, options?: Visibility) {
  return (await isLocal(spaceId))
    ? remote.readSpaceFile(spaceId, path, options)
    : direct.readSpaceFile(spaceId, path, options);
}

export async function statSpaceFileVersion(spaceId: string, path: string) {
  return (await isLocal(spaceId))
    ? remote.statSpaceFileVersion(spaceId, path)
    : direct.statSpaceFileVersion(spaceId, path);
}

export async function readSpaceFiles(spaceId: string, paths: string[], options?: Visibility) {
  return (await isLocal(spaceId))
    ? remote.readSpaceFiles(spaceId, paths, options)
    : direct.readSpaceFiles(spaceId, paths, options);
}

export async function writeSpaceFile(
  spaceId: string,
  input: Parameters<typeof direct.writeSpaceFile>[1],
): Promise<ApiEventOutcome<Awaited<ReturnType<typeof direct.writeSpaceFile>>> | SandboxEventOutcome<SandboxWriteResult>> {
  if (await isLocal(spaceId)) {
    // The API relay connection does not forward watcher events, so the route
    // remains responsible for publishing the mutation event for local spaces.
    return asApiEventOutcome(await remote.writeSpaceFile(spaceId, input));
  }
  if (await isCloudSandboxDialable(spaceId)) {
    const { mutationId, ...mutation } = input;
    return asSandboxOutcome(await runCloudSandboxMutation(spaceId, { operation: "write", ...mutation }, mutationId));
  }
  return runDirectMutation(spaceId, () => direct.writeSpaceFile(spaceId, input));
}

export async function createSpaceFileExclusive(
  spaceId: string,
  input: Parameters<typeof direct.createSpaceFileExclusive>[1],
): Promise<ApiEventOutcome<Awaited<ReturnType<typeof direct.createSpaceFileExclusive>>> | SandboxEventOutcome<SandboxWriteResult>> {
  if (await isLocal(spaceId)) {
    return asApiEventOutcome(await remote.createSpaceFileExclusive(spaceId, input));
  }
  if (await isCloudSandboxDialable(spaceId)) {
    const { mutationId, ...mutation } = input;
    return asSandboxOutcome(await runCloudSandboxMutation(spaceId, { operation: "write", ...mutation, exclusive: true }, mutationId));
  }
  return runDirectMutation(spaceId, () => direct.createSpaceFileExclusive(spaceId, input));
}

export async function createSpaceDirectory(
  spaceId: string,
  path: string,
  mutationId?: string,
): Promise<ApiEventOutcome<Awaited<ReturnType<typeof direct.createSpaceDirectory>>> | SandboxEventOutcome<SandboxMkdirResult>> {
  if (await isLocal(spaceId)) {
    return asApiEventOutcome(await remote.createSpaceDirectory(spaceId, path));
  }
  if (await isCloudSandboxDialable(spaceId)) {
    return asSandboxOutcome(await runCloudSandboxMutation(spaceId, { operation: "mkdir", path }, mutationId));
  }
  return runDirectMutation(spaceId, () => direct.createSpaceDirectory(spaceId, path));
}

export async function deleteSpaceNode(
  spaceId: string,
  path: string,
  recursive = false,
  mutationId?: string,
): Promise<ApiEventOutcome<Awaited<ReturnType<typeof direct.deleteSpaceNode>>> | SandboxEventOutcome<SandboxDeleteResult>> {
  if (await isLocal(spaceId)) {
    return asApiEventOutcome(await remote.deleteSpaceNode(spaceId, path, recursive));
  }
  if (await isCloudSandboxDialable(spaceId)) {
    return asSandboxOutcome(await runCloudSandboxMutation(spaceId, { operation: "delete", path, recursive }, mutationId));
  }
  return runDirectMutation(spaceId, () => direct.deleteSpaceNode(spaceId, path, recursive));
}

export async function moveSpaceNode(
  spaceId: string,
  input: Parameters<typeof direct.moveSpaceNode>[1] & { mutationId?: string },
): Promise<ApiEventOutcome<Awaited<ReturnType<typeof direct.moveSpaceNode>>> | SandboxEventOutcome<SandboxMoveResult>> {
  const { mutationId, ...move } = input;
  if (await isLocal(spaceId)) {
    return asApiEventOutcome(await remote.moveSpaceNode(spaceId, move));
  }
  if (await isCloudSandboxDialable(spaceId)) {
    return asSandboxOutcome(await runCloudSandboxMutation(spaceId, { operation: "move", fromPath: move.fromPath, toPath: move.toPath }, mutationId));
  }
  return runDirectMutation(spaceId, () => direct.moveSpaceNode(spaceId, move));
}

export async function uploadSpaceFiles(
  spaceId: string,
  files: File[],
  targetDir: string,
): Promise<ApiEventOutcome<SpaceFsUploadResponse> | SandboxEventOutcome<SpaceFsUploadResponse>> {
  if (await isLocal(spaceId)) {
    return asApiEventOutcome(await remote.uploadSpaceFiles(spaceId, files, targetDir));
  }
  if (await isCloudSandboxDialable(spaceId)) {
    // A direct volume write, and any directory it creates, would be
    // invisible to the running sandbox's watcher and workspace index.
    const safeTargetDir = assertSafeRelativePath(targetDir, { allowEmpty: true });
    return asSandboxOutcome(await writeUploadsThroughSandbox(files, safeTargetDir, (write) =>
      runCloudSandboxMutation(spaceId, { operation: "write", path: write.path, content: write.content, encoding: "base64" })));
  }
  return runDirectMutation(spaceId, () => direct.uploadSpaceFiles(spaceId, files, targetDir));
}

/**
 * Download source for a file. Cloud spaces may serve via CDN or a local PVC
 * path; local spaces return an in-memory buffer read over RPC. The route
 * renders each variant accordingly.
 */
export type SpaceFileDownload =
  | { kind: "cloud"; spaceId: string; path: string; options?: Visibility }
  | { kind: "buffer"; name: string; mimeType: string | null; buffer: Buffer };

export async function resolveSpaceFileDownload(spaceId: string, path: string, options?: Visibility): Promise<SpaceFileDownload> {
  if (await isLocal(spaceId)) {
    const file = await remote.downloadSpaceFile(spaceId, path, options);
    return { kind: "buffer", ...file };
  }
  return { kind: "cloud", spaceId, path, options };
}

// Re-export provider-independent helpers so callers have a single import site.
export {
  assertSafeRelativePath,
  ensureSpaceWorkspaceReady,
  getMimeType,
  sanitizeFileName,
  spaceFsJsonError,
  streamSpaceFile,
  SpaceFsError,
} from "./space-fs.js";
