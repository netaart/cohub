import { assertHarnessAccess, type RuntimeTurnInput } from "@neta-art/cohub";
import type { RuntimeArchiveStore } from "../archive-store.js";
import { serializeDiagnosticError, type RuntimeDiagnosticContext, type RuntimeDiagnostics } from "../diagnostics.js";
import { harnessAdapter } from "../harnesses/index.js";
import { closeHost } from "../harnesses/process.js";
import type { HarnessExecutables, HarnessResult, HarnessTurn } from "../harnesses/types.js";
import type { CodexShared } from "./codex-link.js";
import type { NativeIngest } from "./ingest.js";
import type { PiLink } from "./pi-link.js";
import type { ExecutionResults } from "./results.js";
import type { NativeSessions } from "./sessions.js";

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
  piExtension: string;
  diagnostics?: RuntimeDiagnostics;
};

/** Run one Cohub Turn in a local harness through its adapter. */
export async function executeTurn(executor: Executor, input: RuntimeTurnInput, emit: HarnessTurn["emit"], signal: AbortSignal, requestId: string | null, context?: RuntimeDiagnosticContext): Promise<HarnessResult> {
  signal.throwIfAborted();
  assertHarnessAccess(input.harness, input.accessMode);
  const diverged = await executor.results.admit(input);
  const turn: HarnessTurn = { input, emit, signal, diverged, started: (session) => executor.results.start(session, input, requestId), context };
  const run = await harnessAdapter(input.harness).run(executor, turn);
  let uncertainCleanup: HarnessResult["uncertainCleanup"];
  if (run.host) uncertainCleanup = await closeHost(run.host, run.message.errorMessage);
  const message = signal.aborted ? { ...run.message, stopReason: "aborted" } : run.message;
  const archive = await executor.archives.stage({ sessionId: input.sessionId, harness: input.harness, nativeSessionId: run.session.nativeSessionId, path: run.session.path }, input.turnId).catch((error: unknown) => {
    // A missing archive only costs cross-machine native resume; the file itself is intact.
    executor.diagnostics?.log("warn", "archive.capture_failed", { error: serializeDiagnosticError(error) }, { ...context, component: "archive" });
    return null;
  });
  executor.ingest.advance(run.session.path, input.turnId);
  return { session: run.session, event: { type: "turn.end", message, resume: run.resume, archive }, ...(uncertainCleanup ? { uncertainCleanup } : {}) };
}
