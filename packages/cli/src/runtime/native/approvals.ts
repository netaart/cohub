import { randomUUID } from "node:crypto";
import type { ApprovalDecision, NativeRuntimeEvent, RuntimeApproval, RuntimeApprovalDecision } from "@neta-art/cohub";

/** How long a card waits for a person; unanswered, the request is declined. */
export const APPROVAL_TIMEOUT_MS = 30 * 60_000;

type Send = (event: NativeRuntimeEvent) => Promise<unknown>;
export type ApprovalRequest = Omit<RuntimeApproval, "id" | "requestedAt" | "expiresAt">;

/** Asks the web for a decision over the control connection; without one, it declines. */
export class ApprovalBroker {
  private send: Send | null = null;
  private readonly pending = new Map<string, { sessionId: string; turnId: string; resolve: (decision: ApprovalDecision) => void }>();

  constructor(private readonly timeoutMs = APPROVAL_TIMEOUT_MS) {}

  /** `null` when the Gateway cannot relay decisions; open cards are then declined. */
  connect(send: Send | null): void {
    this.send = send;
    if (!send) for (const entry of this.pending.values()) entry.resolve("decline");
  }

  get available(): boolean { return this.send !== null; }

  async request(sessionId: string, turnId: string, request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    const send = this.send;
    if (!send || signal.aborted) return "decline";
    const id = randomUUID();
    const now = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const decided = new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(id, { sessionId, turnId, resolve });
      timer = setTimeout(() => resolve("decline"), this.timeoutMs);
      onAbort = () => resolve("decline");
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await send({ type: "approval", sessionId, turnId, approval: { ...request, id, requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + this.timeoutMs).toISOString() } });
      return await decided;
    } catch {
      // A server that cannot show the card cannot answer it either.
      return "decline";
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      this.pending.delete(id);
      void this.send?.({ type: "approval.closed", sessionId, turnId, approvalId: id }).catch(() => undefined);
    }
  }

  decide(input: Pick<RuntimeApprovalDecision, "sessionId" | "turnId" | "approvalId" | "decision">): void {
    const entry = this.pending.get(input.approvalId);
    if (entry && entry.sessionId === input.sessionId && entry.turnId === input.turnId) entry.resolve(input.decision);
  }
}
