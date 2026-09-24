import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { RUNTIME_RECOVERY_BATCH_SIZE, runtimeEventSchema, type RuntimeExecutionEvent, type RuntimeMessage, type RuntimePendingExecution, type RuntimeTurnInput } from "@neta-art/cohub";
import { atomicRuntimeJson } from "../archive-store.js";
import { confirmQuiescentProcessGroup } from "../process-group.js";
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
  uncertainCleanup?: { processGroupId: number; error: string; confirmedAt?: string };
};

export type RecoveredResult = { session: NativeSession; events: RuntimeExecutionEvent[] };

/** One small receipt per Cohub-executed Turn until the server acknowledges its result. */
export class ExecutionResults {
  constructor(private readonly root: string) {}

  private path(sessionId: string) { return join(this.root, "executions", `${sessionId}.json`); }

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
      await rm(this.path(input.sessionId), { force: true });
      return resolved ? receipt.session.path : null;
    }
    if (complete === false) throw new ContextRequiredError("Server resolution is required for the pending native execution");
    throw new Error(`Local turn ${receipt.turnId} has unconfirmed results; reconcile it before continuing`);
  }

  async start(session: NativeSession, input: Pick<RuntimeTurnInput, "sessionId" | "turnId">, requestId: string | null): Promise<void> {
    await atomicRuntimeJson(this.path(input.sessionId), { version: 2, requestId, sessionId: input.sessionId, turnId: input.turnId, session } satisfies Receipt);
  }

  async record(session: NativeSession, input: Pick<RuntimeTurnInput, "sessionId" | "turnId">, requestId: string | null, events: RuntimeExecutionEvent[], uncertainCleanup?: Receipt["uncertainCleanup"]): Promise<void> {
    await atomicRuntimeJson(this.path(input.sessionId), { version: 2, requestId, sessionId: input.sessionId, turnId: input.turnId, session, events, ...(uncertainCleanup ? { uncertainCleanup } : {}) } satisfies Receipt);
  }

  async recover(input: Pick<RuntimeTurnInput, "sessionId" | "turnId" | "harness">, requestId?: string): Promise<RecoveredResult | null> {
    const receipt = await this.read(input.sessionId);
    if (!receipt || receipt.turnId !== input.turnId || receipt.session.harness !== input.harness) return null;
    if (requestId && receipt.requestId != null && receipt.requestId !== requestId) throw new Error("Runtime result execution identity mismatch");
    if (receipt.events) {
      // A quiescent process group upgrades the receipt to confirmed; a live one stays uncertain.
      if (receipt.uncertainCleanup && !receipt.uncertainCleanup.confirmedAt) {
        if (!await confirmQuiescentProcessGroup(receipt.uncertainCleanup.processGroupId)) return null;
        receipt.uncertainCleanup.confirmedAt = new Date().toISOString();
        await atomicRuntimeJson(this.path(input.sessionId), receipt);
      }
      return { session: receipt.session, events: receipt.events.map((event) => runtimeEventSchema.parse(event)) };
    }
    const events = await this.fromTranscript(receipt);
    if (!events) return null;
    await this.record(receipt.session, receipt, receipt.requestId, events);
    return { session: receipt.session, events };
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

  async *pendingBatches(): AsyncGenerator<RuntimePendingExecution[]> {
    const names = await readdir(join(this.root, "executions")).catch((error) => { if (missing(error)) return []; throw error; });
    let batch: RuntimePendingExecution[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const receipt = await this.read(name.slice(0, -5)).catch(() => null);
      if (!receipt) continue;
      batch.push({ sessionId: receipt.sessionId, turnId: receipt.turnId, harness: receipt.session.harness });
      if (batch.length >= RUNTIME_RECOVERY_BATCH_SIZE) { yield batch; batch = []; }
    }
    if (batch.length) yield batch;
  }

  private async fromTranscript(receipt: Receipt): Promise<RuntimeExecutionEvent[] | null> {
    const transcript = await readTranscript(receipt.session.path, receipt.session.harness).catch(() => null);
    const turn = transcript?.turns.find((entry) => entry.cloudTurnId === receipt.turnId);
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
