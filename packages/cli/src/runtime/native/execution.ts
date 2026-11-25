import { assertHarnessAccess, type RuntimeTurnInput } from "@neta-art/cohub";
import type { RuntimeArchiveStore } from "../archive-store.js";
import { serializeDiagnosticError, type RuntimeDiagnosticContext, type RuntimeDiagnostics } from "../diagnostics.js";
import { harnessAdapter } from "../harnesses/index.js";
import { closeHost, watchHost } from "../harnesses/process.js";
import type { HarnessExecutables, HarnessResult, HarnessRun, HarnessTurn } from "../harnesses/types.js";
import type { WarmHosts } from "../harnesses/warm-hosts.js";
import type { ApprovalBroker } from "./approvals.js";
import type { CodexShared } from "./codex-link.js";
import type { NativeIngest } from "./ingest.js";
import type { PiLink } from "./pi-link.js";
import type { ExecutionResults } from "./results.js";
import type { NativeSession, NativeSessions } from "./sessions.js";

export type { HarnessResult } from "../harnesses/types.js";

export type Executor = {
  cwd: string;
  executables: HarnessExecutables;
  sessions: NativeSessions;
  results: ExecutionResults;
  ingest: NativeIngest;
  archives: RuntimeArchiveStore;
  pi: PiLink;
  codex: CodexShared;
  approvals: ApprovalBroker;
  warm: WarmHosts;
  piExtension: string;
  diagnostics?: RuntimeDiagnostics;
};

/** Run one Cohub Turn in a local harness through its adapter. */
export async function executeTurn(executor: Executor, input: RuntimeTurnInput, emit: HarnessTurn["emit"], signal: AbortSignal, requestId: string | null, context?: RuntimeDiagnosticContext): Promise<HarnessResult> {
  signal.throwIfAborted();
  assertHarnessAccess(input.harness, input.accessMode);
  const diverged = await executor.results.admit(input);
  await executor.results.dispatch(input, requestId);
  let processGroup: number | null = null;
  const unwatch: Array<() => void> = [];
  let begun: NativeSession | null = null;
  const started: HarnessTurn["started"] = async (session) => {
    begun = session;
    await executor.results.start(session, input, requestId, processGroup);
    executor.ingest.begin(session, input.sessionId, input.turnId);
  };
  // Cursor spawns after `started`; a failed record only loses the leftover stop.
  let joined: Promise<void> = Promise.resolve();
  const spawned: HarnessTurn["spawned"] = (host) => {
    unwatch.push(watchHost(host, executor.diagnostics, context));
    processGroup = host.processGroupId;
    if (begun) joined = executor.results.start(begun, input, requestId, processGroup).catch((error: unknown) => {
      executor.diagnostics?.log("warn", "runtime.receipt_process_group_failed", { error: serializeDiagnosticError(error) }, { ...context, component: "harness" });
    });
  };
  const turn: HarnessTurn = { input, emit, signal, diverged, started, spawned, context };
  let run: HarnessRun;
  try { run = await harnessAdapter(input.harness).run(executor, turn); }
  catch (error) { executor.ingest.end(input.turnId); throw error; }
  finally { for (const off of unwatch) off(); await joined; }
  let uncertainCleanup: HarnessResult["uncertainCleanup"];
  if (run.host) uncertainCleanup = await closeHost(run.host, run.message.errorMessage);
  const message = signal.aborted ? { ...run.message, stopReason: "aborted" } : run.message;
  const archive = !harnessAdapter(input.harness).session.archive ? null : await executor.archives.stage({ sessionId: input.sessionId, harness: input.harness, nativeSessionId: run.session.nativeSessionId, path: run.session.path }, input.turnId).catch((error: unknown) => {
    // A missing archive only costs cross-machine native resume; the file itself is intact.
    executor.diagnostics?.log("warn", "archive.capture_failed", { error: serializeDiagnosticError(error) }, { ...context, component: "archive" });
    return null;
  });
  executor.ingest.advance(run.session.path, input.turnId);
  return { session: run.session, event: { type: "turn.end", message, resume: run.resume, archive }, ...(uncertainCleanup ? { uncertainCleanup } : {}) };
}
