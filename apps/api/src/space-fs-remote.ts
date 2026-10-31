import {
  createSandboxSpaceFs,
  SpaceFsError,
  type SpaceFsListOptions,
  type SpaceFsMoveInput,
  type SpaceFsTreePage,
  type SpaceFsTreeResponse,
  type SpaceFsWriteFileInput,
} from "@cohub/protocol/fs";
import { INLINE_UPLOAD_MAX_FILES, LOCAL_SANDBOX_UPLOAD_MAX_FILE_BYTES } from "@cohub/protocol";
import type { SpaceFsVisibility } from "@cohub/core/space-fs";
import { FsPaginationError, pageDirectory } from "./fs-pagination.js";
import { callSandboxRpc, getSandboxCapabilities, SandboxOfflineError } from "./space-sandbox-rpc.js";

// Local-sandbox filesystem backend. Mirrors the direct (PVC) backend's public
// surface so routes stay provider-agnostic, but every operation is served over
// the sandbox RPC relay against the user's machine, through the same mapping
// the machine's own clients use over its loopback API.

// Local spaces are owner-only (M1), so the owner always gets full visibility.
// Filtered visibility has no meaningful server-side enforcement here yet.
function assertFullVisibility(visibility: SpaceFsVisibility = "full") {
  if (visibility === "filtered") {
    throw new SpaceFsError(403, "forbidden", "Filtered file access is not available for local sandboxes.");
  }
}

function sandboxFs(spaceId: string, scope?: string) {
  return createSandboxSpaceFs({
    call: (method, params, options) => callSandboxRpc(spaceId, method, params, options),
    features: () => getSandboxCapabilities(spaceId),
    pageLegacy: (tree, options, truncated) => pageDirectory(tree, scope ?? spaceId, options, { truncated }),
  });
}

async function guard<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof SpaceFsError || error instanceof FsPaginationError || error instanceof SandboxOfflineError) throw error;
    throw new SpaceFsError(500, "space_fs_error", "space file operation failed");
  }
}

export function listSpaceDirectory(
  spaceId: string,
  path = "",
  options?: { visibility?: SpaceFsVisibility } & Partial<SpaceFsListOptions>,
): Promise<SpaceFsTreeResponse | SpaceFsTreePage> {
  const visibility = options?.visibility ?? "full";
  assertFullVisibility(visibility);
  const pagination = options?.pagination ? { ...options, pagination: true as const } : undefined;
  return guard(sandboxFs(spaceId, JSON.stringify([spaceId, path, visibility])).list(path, pagination));
}

export function readSpaceFile(spaceId: string, path: string, options?: { visibility?: SpaceFsVisibility }) {
  assertFullVisibility(options?.visibility);
  return guard(sandboxFs(spaceId).read(path));
}

export function readSpaceFiles(spaceId: string, paths: string[], options?: { visibility?: SpaceFsVisibility }) {
  assertFullVisibility(options?.visibility);
  return guard(sandboxFs(spaceId).readMany(paths));
}

export function statSpaceFileVersion(spaceId: string, path: string) {
  return guard(sandboxFs(spaceId).statVersion(path));
}

export function writeSpaceFile(spaceId: string, input: SpaceFsWriteFileInput) {
  return guard(sandboxFs(spaceId).write(input));
}

export function createSpaceFileExclusive(spaceId: string, input: SpaceFsWriteFileInput) {
  return guard(sandboxFs(spaceId).create(input));
}

export function createSpaceDirectory(spaceId: string, path: string) {
  return guard(sandboxFs(spaceId).mkdir(path));
}

export function deleteSpaceNode(spaceId: string, path: string, recursive = false) {
  return guard(sandboxFs(spaceId).remove(path, recursive));
}

export function moveSpaceNode(spaceId: string, input: SpaceFsMoveInput) {
  return guard(sandboxFs(spaceId).move(input));
}

export function uploadSpaceFiles(spaceId: string, files: File[], targetDir: string) {
  return guard(sandboxFs(spaceId).upload(files, targetDir, { maxFiles: INLINE_UPLOAD_MAX_FILES, maxFileBytes: LOCAL_SANDBOX_UPLOAD_MAX_FILE_BYTES }));
}

// Download variant: local files are read over RPC (bounded); routes serve the
// buffer directly (no CDN path for local spaces).
export async function downloadSpaceFile(spaceId: string, path: string, options?: { visibility?: SpaceFsVisibility }) {
  assertFullVisibility(options?.visibility);
  const file = await guard(sandboxFs(spaceId).read(path));
  const buffer = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
  return { name: file.name, mimeType: file.mimeType, buffer };
}
