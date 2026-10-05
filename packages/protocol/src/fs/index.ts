export type SpaceFsChange = {
  path?: string;
  oldPath?: string;
  kind: "create" | "modify" | "delete" | "rename";
  nodeType?: "file" | "dir" | "unknown";
  mtimeMs?: number;
  size?: number;
};

export type SpaceFsChangedPayload = {
  source: "sandbox-watch" | "api-fs" | "bootstrap" | "sandbox-watch-started";
  /** Client-generated id used to identify an API write echoed over realtime. */
  mutationId?: string;
  seq?: number;
  resync?: boolean;
  changes: SpaceFsChange[];
};

export type SpaceFsEntry = {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink";
  size: number;
  mimeType: string | null;
  mtimeMs: number;
};

export type SpaceFsTreeResponse = {
  path: string;
  entries: SpaceFsEntry[];
};

export type SpaceFsFileKind = "text" | "binary";
export type SpaceFsEncoding = "utf-8" | "base64";

export type SpaceFsFileResponse = {
  path: string;
  name: string;
  size: number;
  mimeType: string | null;
  mtimeMs: number;
  /** File metadata change time in epoch milliseconds, when available. */
  ctimeMs?: number;
  kind: SpaceFsFileKind;
  encoding: SpaceFsEncoding;
  content: string;
  delivery?: "inline" | "url";
  url?: string;
};

export type SpaceFsReadFilesInput = {
  paths: string[];
};

export type SpaceFsReadFilesError = {
  path: string;
  code: string;
  message: string;
  status: number;
};

export type SpaceFsPreparingFile = {
  path: string;
  name: string;
  size: number;
  mimeType: string | null;
  mtimeMs: number;
  retryAfterMs: number;
};

export type SpaceFsReadFilesResponse = {
  files: SpaceFsFileResponse[];
  preparing?: SpaceFsPreparingFile[];
  errors: SpaceFsReadFilesError[];
};

export type SpaceFsWriteFileInput = {
  path: string;
  content: string;
  encoding: SpaceFsEncoding;
  /** Reject the write when the file no longer matches this server baseline. */
  expected?: {
    mtimeMs: number;
    size: number;
  };
  /** Optional client-generated id echoed in the resulting fs event. */
  mutationId?: string;
};

export type SpaceFsVersion = {
  size?: number;
  mtimeMs?: number;
};

/**
 * Version captured for an upload target when the upload is planned. A missing
 * target is represented explicitly so materialization can use atomic create
 * semantics instead of overwriting a file created while the upload was in
 * flight.
 */
export type SpaceFsUploadTargetVersion =
  | { exists: false }
  | { exists: true; size: number; mtimeMs: number };

/**
 * Compare file versions at the integer-millisecond precision carried by every
 * filesystem transport. Node may expose fractional milliseconds while the Go
 * sandbox protocol uses Unix milliseconds, so comparing the raw values would
 * report a conflict for the same file.
 */
export function matchesSpaceFsVersion(
  actual: SpaceFsVersion,
  expected: { size: number; mtimeMs: number },
) {
  return actual.size === expected.size
    && actual.mtimeMs !== undefined
    && Math.trunc(actual.mtimeMs) === Math.trunc(expected.mtimeMs);
}

/**
 * Full preflight check used before a conditional write: the file must exist,
 * must not be a directory, and must match the caller's expected version.
 * Shared by the API and agent mutation paths so the conflict decision never
 * diverges.
 */
export function spaceFsVersionMatches(
  current: { exists?: boolean; isDirectory?: boolean; size?: number; mtimeMs?: number } | null | undefined,
  expected: { size: number; mtimeMs: number },
) {
  return current?.exists === true
    && current.isDirectory !== true
    && matchesSpaceFsVersion(current, expected);
}

export type SpaceFsMoveInput = {
  fromPath: string;
  toPath: string;
  /** Optional idempotency key used by backends that support retry dedupe. */
  mutationId?: string;
};

export type SpaceFsCopySource = {
  spaceId: string;
  path: string;
};

export type SpaceFsCopyOptions = {
  recursive?: boolean;
  noClobber?: boolean;
  preserveTimestamps?: boolean;
};

export type SpaceFsCopyInput = SpaceFsCopyOptions & {
  sources: SpaceFsCopySource[];
  destination: string;
  mutationId?: string;
};

export type SpaceFsCopyStats = {
  files: number;
  dirs: number;
  symlinks: number;
  bytes: number;
};

export type SpaceFsCopyError = {
  path: string;
  code: string;
  message: string;
};

export type SpaceFsCopyResult = SpaceFsCopyStats & {
  paths: string[];
  overwritten: number;
  skipped: number;
  errors: SpaceFsCopyError[];
};

export type SpaceFsCopyStatus = "queued" | "running" | "completed";

export type SpaceFsCopyResponse = {
  copyId: string;
  status: SpaceFsCopyStatus;
  progress?: SpaceFsCopyStats;
  result?: SpaceFsCopyResult;
};

export type SpaceFsCreateDirectoryInput = {
  path: string;
  /** Optional idempotency key used by backends that support retry dedupe. */
  mutationId?: string;
};

export type SpaceFsDeleteNodeInput = {
  path: string;
  recursive?: boolean;
  /** Optional idempotency key used by backends that support retry dedupe. */
  mutationId?: string;
};

export type SpaceFsUploadEntry = {
  path: string;
  name: string;
  size: number;
  mimeType: string | null;
  mtimeMs: number;
  /** Whether this upload created the file rather than replacing it. */
  created?: boolean;
};

export type SpaceFsUploadError = {
  name: string;
  code: "file_too_large" | "name_invalid" | "path_invalid" | "write_failed" | "object_missing";
  message: string;
};

export type SpaceFsUploadResponse = {
  uploaded: SpaceFsUploadEntry[];
  errors: SpaceFsUploadError[];
  /** Workspace-relative directories created while materializing the upload. */
  createdDirs?: string[];
};

export type SpaceFsUploadPlanEntryInput = {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  mimeType?: string | null;
  lastModified?: number;
  /**
   * Optional durable public URL. When set, client skips PUT and complete pulls from this URL.
   * Must be an allowed public-asset origin.
   */
  downloadUrl?: string;
};

export type SpaceFsUploadDestination =
  | {
      kind: "workspace";
      targetDir?: string;
    }
  | {
      kind: "sandbox_tmp";
      /** Optional association only; materialize path is /tmp/uploads/{uploadId}. */
      sessionId?: string;
    };

export type SpaceFsCreateUploadInput = {
  destination: SpaceFsUploadDestination;
  entries: SpaceFsUploadPlanEntryInput[];
};

export type SpaceFsUploadPlanEntry = {
  id: string;
  /** Present for client-PUT entries; omitted for remote downloadUrl entries. */
  objectKey?: string;
  /** Present for client-PUT entries; omitted for remote downloadUrl entries. */
  uploadUrl?: string;
  headers?: Record<string, string>;
  /** Echo of remote source when entry uses downloadUrl. */
  downloadUrl?: string;
};

export type SpaceFsCreateUploadResponse = {
  uploadId: string;
  expiresAt: string;
  entries: SpaceFsUploadPlanEntry[];
};

export type SpaceFsCompleteUploadInput = {
  entries: Array<{ id: string; etag?: string | null }>;
};

export type SpaceFsCompleteUploadResponse = {
  ok: true;
  uploaded: SpaceFsUploadEntry[];
};

export type SpaceFsUploadProgress = {
  phase: "queued" | "importing" | "done" | "failed";
  totalFiles: number;
  importedFiles: number;
  totalBytes: number;
  importedBytes: number;
  currentPath?: string;
  errors: SpaceFsUploadError[];
};

// ── Checkpoint / workspace diffs ──────────────────────────────────────────────

export type CheckpointDiffStatus = "A" | "M" | "D" | "R" | "C" | "T";

export type CheckpointDiffStats = {
  changedFileCount: number;
  addedFileCount: number;
  modifiedFileCount: number;
  deletedFileCount: number;
  renamedFileCount: number;
  copiedFileCount: number;
  additions: number;
  deletions: number;
};

export type CheckpointDiffFile = {
  status: CheckpointDiffStatus;
  path: string;
  oldPath?: string | null;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  asset: boolean;
};

export type CheckpointDiffDelivery = "inline" | "url";

export type CheckpointDiffSummary = {
  baseCheckpointId: string | null;
  baseCommitHash: string | null;
  headCheckpointId: string;
  headCommitHash: string;
  files: CheckpointDiffFile[];
  truncated: boolean;
  stats: CheckpointDiffStats;
  /** How this payload is delivered. `url` means `files` may be empty and clients should fetch `url`. */
  delivery?: CheckpointDiffDelivery;
  url?: string;
  /** True when summary was written during save_checkpoint (preferred hot path). */
  precomputed?: boolean;
};

export type CheckpointDiffPatchKind =
  | "text"
  | "binary"
  | "asset"
  | "too_large"
  | "unavailable";

export type CheckpointDiffPatchLine = {
  type: "context" | "add" | "del" | "hunk" | "meta";
  text: string;
};

export type CheckpointDiffFileResponse = {
  path: string;
  oldPath?: string | null;
  status: CheckpointDiffStatus | null;
  kind: CheckpointDiffPatchKind;
  binary: boolean;
  asset: boolean;
  additions: number | null;
  deletions: number | null;
  oldSize?: number | null;
  newSize?: number | null;
  truncated: boolean;
  lines: CheckpointDiffPatchLine[];
  delivery?: CheckpointDiffDelivery;
  url?: string;
  /** True when served from save-time precomputed meta/OSS. */
  precomputed?: boolean;
};

export type SpacePendingDiffSummary = {
  baseCheckpointId: string | null;
  files: CheckpointDiffFile[];
  truncated: boolean;
  incomplete: boolean;
  stats: CheckpointDiffStats;
};

export type SpacePendingDiffFileResponse = CheckpointDiffFileResponse & {
  baseCheckpointId: string | null;
};
