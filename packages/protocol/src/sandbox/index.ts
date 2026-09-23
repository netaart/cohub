import type { WORKSPACE_CANDIDATE_INDEX_FAMILY, WORKSPACE_PATH_INDEX_FAMILY } from "../search/index.js";

export const AGENT_SANDBOX_PROTOCOL_VERSION = "1" as const;

export { SYSTEM_ENV_KEYS, SYSTEM_ENV_KEY_SET, SPACE_ENV_REDIS_KEY } from "./constants.js";

export const SANDBOX_STATUSES = [
  "connecting",
  "preparing",
  "ready",
  "degraded",
  "busy",
  "error",
] as const;

export type SandboxStatus = (typeof SANDBOX_STATUSES)[number];

export const RPC_METHODS = [
  "fs.read",
  "fs.write",
  "fs.edit",
  "fs.mkdir",
  "fs.stat",
  "fs.ls",
  "fs.tree",
  "fs.find",
  "fs.grep",
  "fs.search",
  "fs.pathSearch",
  "process.start",
  "process.abort",
] as const;

export type FsChange = {
  path?: string;
  oldPath?: string;
  kind: "create" | "modify" | "delete" | "rename";
  nodeType?: "file" | "dir" | "unknown";
  mtimeMs?: number;
  size?: number;
};

export type FsChanged = BaseMessage & {
  type: "fs.changed";
  payload: {
    seq: number;
    resync?: boolean;
    changes: FsChange[];
  };
};

export type PortStatus = "listening" | "closed";

export type PortChange = {
  port: number;
  protocol: "tcp";
  status: PortStatus;
  observedAt: number;
};

export type PortsChangedPayload = {
  seq: number;
  resync?: boolean;
  ports: PortChange[];
};

export type PortsChanged = BaseMessage & {
  type: "ports.changed";
  payload: PortsChangedPayload;
};

export type RpcMethod = (typeof RPC_METHODS)[number];

export const RPC_ERROR_CODES = [
  "BAD_REQUEST",
  "UNSUPPORTED_METHOD",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "NOT_DIRECTORY",
  "INVALID_PATH",
  "ACCESS_DENIED",
  "READ_ONLY_FILESYSTEM",
  "CONFLICT",
  "EDIT_NOT_FOUND",
  "EDIT_NOT_UNIQUE",
  "TIMEOUT",
  "PROCESS_SPAWN_FAILED",
  "PROCESS_ABORT_FAILED",
  "IO_ERROR",
  "INTERNAL_ERROR",
  "SEARCH_UNAVAILABLE",
] as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

export type BaseMessage = {
  version: typeof AGENT_SANDBOX_PROTOCOL_VERSION;
  type: string;
  spaceId: string;
  sandboxId: string;
  timestamp: number;
};

export type RequestScopedMessage = BaseMessage & {
  requestId: string;
  sessionId?: string | null;
  toolCallId?: string | null;
};

export type OperationScopedMessage = BaseMessage & {
  opId: string;
  requestId: string;
  seq: number;
  sessionId?: string | null;
  toolCallId?: string | null;
};

export type SandboxCapabilities = {
  fsRead: boolean;
  fsWrite: boolean;
  /** fs.write reports atomic create/modify disposition and created parent directories. */
  fsWriteDisposition?: boolean;
  /** fs.write honors the expected version baseline (atomic check-and-write). */
  fsWriteExpected?: boolean;
  /** fs.write can atomically install a sandbox-local staging file. */
  fsWriteSource?: boolean;
  /** Supports the atomic fs.edit read-apply-write method. */
  fsEdit?: boolean;
  fsMkdir?: boolean;
  fsStat: boolean;
  fsLs: boolean;
  /** Supports the structured recursive fs.tree method. */
  fsTree?: boolean;
  fsFind: boolean;
  fsGrep: boolean;
  /** Tantivy-backed candidate search is available in the sandbox. */
  fsSearch?: boolean;
  /** Persistent path-glob search is available in the sandbox. */
  fsPathSearch?: boolean;
  processStart: boolean;
  /** process.start supports argv exec mode (no shell). */
  processStartArgv?: boolean;
  processAbort: boolean;
};

export type SandboxFilesystemRoot = {
  path: string;
  writable: boolean;
  label?: string;
};

export type SandboxHeartbeat = BaseMessage & {
  type: "sandbox.heartbeat";
  status: SandboxStatus;
  capabilities?: SandboxCapabilities;
  filesystem?: {
    roots: SandboxFilesystemRoot[];
    defaultCwd: string;
    mode?: "host-like";
    notes?: string[];
  };
  metadata?: {
    podName?: string;
    hostname?: string;
    imageVersion?: string;
    startedAt?: string;
    setup?: SandboxSetupInfo;
  };
};

export type SandboxSetupInfo = {
  ran: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: string;
  error?: string;
};

export type SessionAttach = BaseMessage & {
  type: "session.attach";
  requestId: string;
  identity: string;
};

export type SessionAttachOk = BaseMessage & {
  type: "session.attach.ok";
  requestId: string;
  connectionId: string;
  identity: string;
};

export type FsReadParams = {
  path: string;
  cwd?: string;
  offset?: number;
  limit?: number;
  /** Return content as base64 for binary-safe reading */
  binary?: boolean;
};

export type FsReadResult = {
  path: string;
  content: string;
  /** Base64-encoded content when binary=true */
  contentBase64?: string;
  /** MIME type detected for binary content */
  mimeType?: string;
  /** Full file size in bytes (not the returned slice). */
  size?: number;
  /** File modification time in epoch milliseconds. */
  mtimeMs?: number;
  /** File metadata change time in epoch milliseconds, when available. */
  ctimeMs?: number;
};

export type FsWriteParams = {
  path: string;
  cwd?: string;
  content: string;
  /** Internal upload path: atomically install this staged file at path. */
  sourcePath?: string;
  /** Content encoding; base64 enables binary-safe writes. Defaults to utf-8. */
  encoding?: "utf-8" | "base64";
  /** Fail with ALREADY_EXISTS instead of overwriting when the path exists (O_EXCL). */
  exclusive?: boolean;
  /**
   * Optimistic concurrency baseline: reject with CONFLICT when the file no
   * longer matches this version (size + mtimeMs). Checked atomically with the
   * write inside the sandbox. Only honored for non-exclusive writes.
   */
  expected?: { size: number; mtimeMs: number };
};

export type FsWriteResult = {
  path: string;
  bytesWritten: number;
  /** Whether this write created the target file. */
  created?: boolean;
  /** Workspace-relative parent directories created by this write, outermost first. */
  createdDirs?: string[];
  /** File modification time in epoch milliseconds after the write. */
  mtimeMs?: number;
};

export type FsEdit = {
  oldText: string;
  newText: string;
};

export type FsEditParams = {
  path: string;
  cwd?: string;
  edits: FsEdit[];
};

export type FsEditResult = {
  path: string;
  /** Number of edits applied. */
  applied: number;
  bytesWritten: number;
  mtimeMs?: number;
};

export type FsMkdirParams = {
  path: string;
  cwd?: string;
};

export type FsMkdirResult = {
  path: string;
  createdDirs: string[];
  mtimeMs?: number;
};

export type FsStatParams = {
  path?: string;
  cwd?: string;
};

export type FsStatResult = {
  path?: string;
  exists: boolean;
  isDirectory: boolean;
  /** File size in bytes when the node exists and is a regular file. */
  size?: number;
  /** Modification time in epoch milliseconds when the node exists. */
  mtimeMs?: number;
  /** Metadata change time in epoch milliseconds when available. */
  ctimeMs?: number;
  isFile?: boolean;
};

export type FsLsParams = {
  path?: string;
  cwd?: string;
  limit?: number;
};

export type FsLsResult = {
  path: string;
  entries: string[];
  truncated?: boolean;
};

export type FsTreeParams = {
  /** Directory to list; resolved like other fs paths. Defaults to cwd. */
  path?: string;
  cwd?: string;
  /** Recursion depth; 1 lists only direct children. Defaults to 1, max 10. */
  depth?: number;
  /** Total entry cap across the walk. Defaults to 1000, max 5000. */
  limit?: number;
  /** Apply workspace .gitignore rules (and always hide .git). Defaults to true. */
  respectGitignore?: boolean;
};

export type FsTreeEntry = {
  name: string;
  /** Posix path relative to the requested tree root. */
  path: string;
  type: "file" | "dir" | "symlink";
  size: number;
  mtimeMs: number;
};

export type FsTreeResult = {
  /** Resolved absolute path of the tree root. */
  path: string;
  /** Flat list in depth-first order; directories sort before recursion. */
  entries: FsTreeEntry[];
  truncated?: boolean;
};

export type FsFindParams = {
  pattern: string;
  path?: string;
  cwd?: string;
  limit?: number;
  /** Search mode: "glob" (default), "regex", or "fixed-strings" */
  mode?: "glob" | "regex" | "fixed-strings";
  /** Maximum number of results (--max-results) */
  maxResults?: number;
  /** Include hidden files/directories */
  hidden?: boolean;
  /** Require a git repository to apply .gitignore rules (false = apply even outside git repos, i.e. --no-require-git) */
  requireGit?: boolean;
  /** Skip VCS ignore rules entirely (i.e. --no-ignore-vcs) */
  ignoreVcs?: boolean;
  /** Match against full path instead of basename */
  fullPath?: boolean;
  /** Glob patterns to exclude (e.g. node_modules, .git) */
  ignore?: string[];
};

export type FsFindResult = {
  path: string;
  matches: string[];
  truncated?: boolean;
};

export type FsGrepParams = {
  pattern: string;
  path?: string;
  cwd?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
  /** Maximum matches per file (-m/--max-count) */
  maxCount?: number;
  /** Output in JSON format for structured parsing (--json) */
  json?: boolean;
  /** Require a git repository to apply .gitignore rules (false = apply even outside git repos, i.e. --no-require-git) */
  requireGit?: boolean;
  /** Include hidden files/directories */
  hidden?: boolean;
};

export type FsGrepResult = {
  path: string;
  lines: string[];
  truncated?: boolean;
};

export type FsSearchParams = {
  /** Required literal fragments; each must contain at least 3 non-whitespace characters. */
  literals: string[];
  path?: string;
  cwd?: string;
  glob?: string;
  limit?: number;
};

export type FsSearchResult = {
  path: string;
  /** Paths relative to the requested path, matching fs.find semantics. */
  matches: string[];
  indexFamily: typeof WORKSPACE_CANDIDATE_INDEX_FAMILY;
  schemaVersion: number;
  coverage: "complete" | "partial" | "stale";
  truncated?: boolean;
  state?: "ready" | "indexing" | "error";
};

export type FsPathSearchParams = {
  pattern: string;
  path?: string;
  cwd?: string;
  limit?: number;
  fullPath?: boolean;
  ignore?: string[];
};

export type FsPathSearchResult = {
  path: string;
  matches: string[];
  indexFamily: typeof WORKSPACE_PATH_INDEX_FAMILY;
  schemaVersion: number;
  coverage: "complete" | "partial" | "stale";
  truncated?: boolean;
  state?: "ready" | "indexing" | "error";
};

export type ProcessStartParams = {
  /** Shell command mode. Preserves existing `bash -c` semantics. */
  command?: string;
  /** Direct exec mode. argv[0] is the executable; no shell is used. */
  argv?: string[];
  timeoutSecs?: number;
  cwd?: string;
  env?: Record<string, string>;
};

export type ProcessTerminationReason = "exited" | "timed_out" | "aborted";

export type ProcessTermination = {
  reason: ProcessTerminationReason;
  exitCode: number | null;
  timeoutSecs?: number;
  message?: string;
  outputTruncated?: boolean;
};

export type ProcessStartResult = {
  processId: string;
  exitCode: number | null;
  termination?: ProcessTermination;
};

export type ProcessAbortParams = {
  processId: string;
};

export type ProcessAbortResult = {
  processId: string;
  aborted: boolean;
};

export type RpcRequestMap = {
  "fs.read": {
    params: FsReadParams;
    result: FsReadResult;
  };
  "fs.write": {
    params: FsWriteParams;
    result: FsWriteResult;
  };
  "fs.edit": {
    params: FsEditParams;
    result: FsEditResult;
  };
  "fs.mkdir": {
    params: FsMkdirParams;
    result: FsMkdirResult;
  };
  "fs.stat": {
    params: FsStatParams;
    result: FsStatResult;
  };
  "fs.ls": {
    params: FsLsParams;
    result: FsLsResult;
  };
  "fs.tree": {
    params: FsTreeParams;
    result: FsTreeResult;
  };
  "fs.find": {
    params: FsFindParams;
    result: FsFindResult;
  };
  "fs.grep": {
    params: FsGrepParams;
    result: FsGrepResult;
  };
  "fs.search": {
    params: FsSearchParams;
    result: FsSearchResult;
  };
  "fs.pathSearch": {
    params: FsPathSearchParams;
    result: FsPathSearchResult;
  };
  "process.start": {
    params: ProcessStartParams;
    result: ProcessStartResult;
  };
  "process.abort": {
    params: ProcessAbortParams;
    result: ProcessAbortResult;
  };
};

export type RpcRequest<M extends RpcMethod = RpcMethod> = RequestScopedMessage & {
  type: "rpc.request";
  method: M;
  params: RpcRequestMap[M]["params"];
};

export type RpcAccepted = RequestScopedMessage & {
  type: "rpc.accepted";
  opId: string;
};

export type RpcEventPayload =
  | { type: "started"; processId: string }
  | { type: "stdout"; chunk: string }
  | { type: "stderr"; chunk: string }
  | { type: "exit"; exitCode: number | null; termination?: ProcessTermination };

export type RpcEvent = OperationScopedMessage & {
  type: "rpc.event";
  event: RpcEventPayload;
};

export type RpcCompleted<M extends RpcMethod = RpcMethod> = OperationScopedMessage & {
  type: "rpc.completed";
  result: RpcRequestMap[M]["result"];
};

export type RpcFailed = OperationScopedMessage & {
  type: "rpc.failed";
  error: {
    code: RpcErrorCode;
    message: string;
    retryable?: boolean;
  };
};

export type AgentSandboxMessage =
  | SandboxHeartbeat
  | SessionAttach
  | SessionAttachOk
  | FsChanged
  | PortsChanged
  | RpcRequest
  | RpcAccepted
  | RpcEvent
  | RpcCompleted
  | RpcFailed;

export function isRpcMethod(value: string): value is RpcMethod {
  return RPC_METHODS.includes(value as RpcMethod);
}

export function isRpcErrorCode(value: string): value is RpcErrorCode {
  return RPC_ERROR_CODES.includes(value as RpcErrorCode);
}
