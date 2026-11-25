import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { RUNTIME_RECOVERY_BATCH_SIZE, runtimeEventSchema, type LocalHarness, type RuntimeExecutionEvent, type RuntimeMessage, type RuntimePendingExecution, type RuntimeTurnInput } from "@neta-art/cohub";
import { atomicRuntimeJson } from "../archive-store.js";
import { confirmQuiescentProcessGroup, ProcessCleanupUncertainError, processStart, stopProcessGroup } from "../process-group.js";
import { readTranscript } from "./adapters.js";
import type { NativeSession } from "./sessions.js";

export class ContextRequiredError extends Error {}

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

type Receipt = {
  version: 2;
  requestId: string | null;
  sessionId: string;
  turnId: string;
  session: NativeSession;
  events?: RuntimeExecutionEvent[];
  processGroup?: { id: number; start: string };
  uncertainCleanup?: { processGroupId: number; error: string; confirmedAt?: string };
};

/** A Turn whose prompt was not sent yet; kept apart from receipts, which earlier Runtimes read. */
type Dispatched = { requestId: string | null; sessionId: string; turnId: string; harness: LocalHarness };

export type RecoveredResult = { session: NativeSession; events: RuntimeExecutionEvent[] };
export const NOT_STARTED = "not_started";

async function stopLeftover(receipt: Receipt) {
  const group = receipt.processGroup;
  if (group?.start && await processStart(group.id) === group.start) await stopProcessGroup(group.id);
}

/** One small receipt per Cohub-executed Turn until the server acknowledges its result. */
export class ExecutionResults {
  constructor(private readonly root: string) {}

  private path(sessionId: string) { return join(this.root, "executions", `${sessionId}.json`); }
  private dispatchedPath(sessionId: string) { return join(this.root, "dispatched", `${sessionId}.json`); }

  private async dispatched(sessionId: string): Promise<Dispatched | null> {
    try {
      const value = JSON.parse(await readFile(this.dispatchedPath(sessionId), "utf8")) as Dispatched;
      return value.sessionId === sessionId ? value : null;
    } catch (error) { if (missing(error)) return null; throw error; }
  }

  private async read(sessionId: string): Promise<Receipt | null> {
    try {
      const receipt = JSON.parse(await readFile(this.path(sessionId), "utf8")) as Receipt;
      if (receipt.version !== 2 || receipt.sessionId !== sessionId) throw new Error("Invalid execution receipt");
      return receipt;
    } catch (error) { if (missing(error)) return null; throw error; }
  }

  /**
   * Admit a new Turn. An unacknowledged earlier Turn is released once the server has settled it;
   * otherwise the server must decide first, so a result is never overwritten unseen.
   */
  async admit(input: RuntimeTurnInput): Promise<string | null> {
    const receipt = await this.read(input.sessionId);
    if (!receipt || receipt.turnId === input.turnId) return null;
    const { resolvedTurnIds, settledTurnIds, complete } = input.context;
    const resolved = resolvedTurnIds?.includes(receipt.turnId) === true;
    if (resolved || settledTurnIds?.includes(receipt.turnId)) {
      if (resolved) await stopLeftover(receipt).catch((error: unknown) => { throw error instanceof ProcessCleanupUncertainError ? new Error(error.message) : error; });
      await rm(this.path(input.sessionId), { force: true });
      return resolved ? receipt.session.path : null;
    }
    if (complete === false) throw new ContextRequiredError("Server resolution is required for the pending native execution");
    throw new Error(`Local turn ${receipt.turnId} has unconfirmed results; reconcile it before continuing`);
  }

  async dispatch(input: Pick<RuntimeTurnInput, "sessionId" | "turnId" | "harness">, requestId: string | null): Promise<void> {
    await atomicRuntimeJson(this.dispatchedPath(input.sessionId), { requestId, sessionId: input.sessionId, turnId: input.turnId, harness: input.harness } satisfies Dispatched);
  }

  async undispatch(input: Pick<RuntimeTurnInput, "sessionId" | "turnId">): Promise<void> {
    if ((await this.dispatched(input.sessionId))?.turnId === input.turnId) await rm(this.dispatchedPath(input.sessionId), { force: true });
  }

  async start(session: NativeSession, input: Pick<RuntimeTurnInput, "sessionId" | "turnId">, requestId: string | null, processGroup: number | null = null): Promise<void> {
    const start = processGroup != null && process.platform !== "win32" ? await processStart(processGroup) : null;
    const group = processGroup != null && start ? { processGroup: { id: processGroup, start } } : {};
    await atomicRuntimeJson(this.path(input.sessionId), { version: 2, requestId, sessionId: input.sessionId, turnId: input.turnId, session, ...group } satisfies Receipt);
    await rm(this.dispatchedPath(input.sessionId), { force: true });
  }

  async record(session: NativeSession, input: Pick<RuntimeTurnInput, "sessionId" | "turnId">, requestId: string | null, events: RuntimeExecutionEvent[], uncertainCleanup?: Receipt["uncertainCleanup"]): Promise<void> {
    await atomicRuntimeJson(this.path(input.sessionId), { version: 2, requestId, sessionId: input.sessionId, turnId: input.turnId, session, events, ...(uncertainCleanup ? { uncertainCleanup } : {}) } satisfies Receipt);
  }

  async recover(input: Pick<RuntimeTurnInput, "sessionId" | "turnId" | "harness">, requestId?: string): Promise<RecoveredResult | typeof NOT_STARTED | null> {
    const receipt = await this.read(input.sessionId);
    if (!receipt || receipt.turnId !== input.turnId) {
      const dispatched = await this.dispatched(input.sessionId);
      if (dispatched?.turnId !== input.turnId || dispatched.harness !== input.harness) return null;
      if (requestId && dispatched.requestId != null && dispatched.requestId !== requestId) throw new Error("Runtime result execution identity mismatch");
      return NOT_STARTED;
    }
    if (receipt.session.harness !== input.harness) return null;
    if (requestId && receipt.requestId != null && receipt.requestId !== requestId) throw new Error("Runtime result execution identity mismatch");
    const { session } = receipt;
    if (receipt.events) {
      // A quiescent process group upgrades the receipt to confirmed; a live one stays uncertain.
      if (receipt.uncertainCleanup && !receipt.uncertainCleanup.confirmedAt) {
        if (!await confirmQuiescentProcessGroup(receipt.uncertainCleanup.processGroupId)) return null;
        receipt.uncertainCleanup.confirmedAt = new Date().toISOString();
        await atomicRuntimeJson(this.path(input.sessionId), receipt);
      }
      return { session, events: receipt.events.map((event) => runtimeEventSchema.parse(event)) };
    }
    const events = await this.fromTranscript(session, receipt.turnId);
    if (!events) return null;
    await this.record(session, receipt, receipt.requestId, events);
    return { session, events };
  }

  async acknowledge(sessionId: string, turnId: string): Promise<void> {
    const receipt = await this.read(sessionId);
    if (receipt?.turnId !== turnId) throw new Error("Runtime acknowledgement identity mismatch");
    await rm(this.path(sessionId), { force: true });
  }

  async pendingTurnIds(sessionId: string): Promise<string[]> {
    const receipt = await this.read(sessionId);
    return receipt ? [receipt.turnId] : [];
  }

  async unconfirmed(): Promise<boolean> {
    for (const name of await this.names("executions")) if (await this.read(name).catch(() => null)) return true;
    return false;
  }

  async *pendingBatches(): AsyncGenerator<RuntimePendingExecution[]> {
    const pending: RuntimePendingExecution[] = [];
    for (const name of await this.names("executions")) {
      const receipt = await this.read(name).catch(() => null);
      if (receipt) pending.push({ sessionId: receipt.sessionId, turnId: receipt.turnId, harness: receipt.session.harness });
    }
    const started = new Set(pending.map((execution) => execution.sessionId));
    for (const name of await this.names("dispatched")) {
      const dispatched = started.has(name) ? null : await this.dispatched(name).catch(() => null);
      if (dispatched) pending.push({ sessionId: dispatched.sessionId, turnId: dispatched.turnId, harness: dispatched.harness });
    }
    for (let index = 0; index < pending.length; index += RUNTIME_RECOVERY_BATCH_SIZE) yield pending.slice(index, index + RUNTIME_RECOVERY_BATCH_SIZE);
  }

  private async names(directory: string) {
    const names = await readdir(join(this.root, directory)).catch((error) => { if (missing(error)) return []; throw error; });
    return names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
  }

  private async fromTranscript(session: NativeSession, turnId: string): Promise<RuntimeExecutionEvent[] | null> {
    const transcript = await readTranscript(session.path, session.harness).catch(() => null);
    const turn = transcript?.turns.find((entry) => entry.cloudTurnId === turnId);
    const result = turn?.result;
    if (!result || result.status === "interrupted" || turn !== transcript?.turns.at(-1)) return null;
    const messages = result.messages.filter((message) => message.content.length);
    if (!messages.length) return null;
    const message = (entry: (typeof messages)[number], ordinal: number): RuntimeMessage => ({
      ordinal,
      content: entry.content,
      provider: entry.provider ?? null,
      model: entry.model ?? null,
      usage: (entry.usage ?? null) as RuntimeMessage["usage"],
      stopReason: entry.stopReason ?? "stop",
      errorMessage: entry.errorMessage ?? null,
    });
    return [
      ...messages.slice(0, -1).map((entry, index) => ({ type: "message.commit", message: message(entry, index) }) as const),
      { type: "turn.end", message: message(messages.at(-1) as (typeof messages)[number], messages.length - 1), resume: "native", archive: null },
    ];
  }
}
