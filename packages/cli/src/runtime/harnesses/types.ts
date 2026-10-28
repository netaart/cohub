import type {
  LocalHarness, NativeProjection, ProjectionInput, ProjectionRecord, RuntimeCapabilities, RuntimeExecutionEvent, RuntimeMessage, RuntimeTurnInput,
} from "@neta-art/cohub";
import type { JsonRpcProcess } from "../json-rpc.js";
import type { RuntimeDiagnosticContext } from "../diagnostics.js";
import type { Executor } from "../native/execution.js";
import type { NativeSession, ResumeKind } from "../native/sessions.js";
import type { NativeTranscript, NativeTranscriptTurn } from "../native/transcript.js";

export type HarnessExecutables = Partial<Record<LocalHarness, string>>;
export type HarnessModel = RuntimeCapabilities["models"][number];

export type HarnessResult = {
  session: NativeSession;
  event: Extract<RuntimeExecutionEvent, { type: "turn.end" }>;
  uncertainCleanup?: { processGroupId: number; error: string };
};

/** One Cohub Turn handed to an adapter. `started` must be awaited right before the prompt is sent. */
export type HarnessTurn = {
  input: RuntimeTurnInput;
  emit: (event: RuntimeExecutionEvent) => void;
  signal: AbortSignal;
  /** A native file the server resolved as stopped; it is never continued. */
  diverged: string | null;
  started: (session: NativeSession) => Promise<void>;
  context?: RuntimeDiagnosticContext;
};

/** `host` is a process Cohub started for this Turn; the executor closes it. */
export type HarnessRun = { session: NativeSession; resume: ResumeKind; message: RuntimeMessage; host: JsonRpcProcess | null };

export type ThreadKind = "user" | "internal" | "spawned";
export type SessionHeader = { harness: LocalHarness; nativeSessionId: string; cwd: string; thread: ThreadKind };

/** Native session files: where they live, how Cohub history is written into them, and how archives restore. */
export type NativeSessionFormat = {
  /** File for a new native session of `cwd`. */
  path(nativeSessionId: string, cwd: string): string;
  /** An empty session is created by the harness itself instead of a projected file. */
  startsWithoutFile: boolean;
  project(input: ProjectionInput): NativeProjection;
  /** Rewrite the session identity of a full projection. */
  rebind(records: ProjectionRecord[], nativeSessionId: string): ProjectionRecord[];
  /** Absent when the native state is not one file Cohub can carry; history is then projected again. */
  archive?: {
    /** Working-copy path of a restored archive; `id` is fresh, `nativeSessionId` the archived one. */
    target(input: { id: string; nativeSessionId: string; cwd: string }): string;
    /** Copy raw archive bytes to `target`, adjusting only the header; returns the copy's session id. */
    import(input: NativeArchiveImport): Promise<{ checksum: string; nativeSessionId: string }>;
  };
};

export type NativeArchiveImport = { source: string; target: string; nativeSessionId: string; id: string; cwd: string; signal?: AbortSignal };

/** Reading a harness's own transcripts: native sync, import and receipt-less recovery. */
export type NativeTranscriptFormat = {
  roots(): string[];
  /** Whether a directory found under a root can hold transcripts of `cwd`. */
  acceptsDirectory(path: string, root: string, cwd: string): boolean;
  /** Name-only check: can this path hold a transcript of `cwd`? */
  acceptsTranscript(path: string, cwd: string): boolean;
  header(path: string, signal?: AbortSignal): Promise<SessionHeader | null>;
  /** Parse into Turns. Without `turnEndRecorded`, the tail is parsed as settled and withdrawn by the caller while in flight. */
  read(path: string, signal?: AbortSignal): Promise<NativeTranscript>;
  /** Record substrings that begin or end a Turn; new bytes without one need no parse. */
  boundaries: string[];
  /** The file records each Turn's end, so a Turn without a result is still running. */
  turnEndRecorded: boolean;
  /** Otherwise: whether the tail's last reply ended (a quiet period then settles it). */
  replyEnded?(turn: NativeTranscriptTurn): boolean;
  /** The prompt is recorded in steps and marked final (`userFinal`); a Turn is sent only once it is. */
  userFinalMarked: boolean;
  /** Turn keys are unique across sessions (forks share their history's Turns). */
  globalTurnKeys: boolean;
  /**
   * A Turn Cohub runs carries its Cohub Turn id in the file (`cloudTurnId`). Otherwise the ledger
   * records which Turn Cohub is running, and a Cohub file's Turns up to its end are taken as the server's.
   */
  marksCohubTurns: boolean;
  /** Plain JSONL bytes for archival when the file itself is stored differently. */
  archiveSource?(path: string, cacheDirectory: string): Promise<string>;
};

export type LocalHarnessAdapter = {
  id: LocalHarness;
  /** Executable looked up on PATH unless overridden. */
  binary: string;
  /** Fails when the harness cannot run; with `strict`, also instead of falling back to a reduced catalog. */
  models(executable: string, cwd: string, options?: { strict?: boolean }): Promise<HarnessModel[]>;
  run(executor: Executor, turn: HarnessTurn): Promise<HarnessRun>;
  session: NativeSessionFormat;
  /** Every harness reads its own transcripts, so terminal conversations sync to the Space. */
  transcript: NativeTranscriptFormat;
};
