import type { MessageRecord, ModelCatalogEntry, SessionTurnIndexItem, SessionTurnRecord, SpaceRecord, UserSessionListItem } from "@neta-art/cohub";

const now = new Date().toISOString();
const space = (id: string, name: string, description: string, pinned = false): SpaceRecord => ({ id, userUuid: "web-preview", name, slug: id, description, title: name, status: "active", meta: null, createdAt: now, updatedAt: now, lastActivityAt: now, isPinned: pinned });
const session = (id: string, spaceId: string, title: string, status: string, latestMessageText: string): UserSessionListItem => ({ id, spaceId, userUuid: "web-preview", title, source: "mock", status, externalSessionId: null, meta: null, latestMessageText, lastMessageAt: now, lastMessageId: `${id}-m2`, createdAt: now, updatedAt: now, space: { id: spaceId, name: spaceId === "product" ? "Product launch" : "Research vault", slug: spaceId, publicProfile: null } });
const message = (id: string, sessionId: string, role: "user" | "assistant", sequence: number, text: string): MessageRecord => ({ id, sessionId, role, content: [{ type: "text", text }], text, sequence, provider: role === "assistant" ? "cohub" : null, model: role === "assistant" ? "mock-agent" : null, stopReason: role === "assistant" ? "stop" : null, errorMessage: null, usage: null, meta: null, startedAt: now, completedAt: now, durationMs: 420, createdAt: now });

export const mockSpaces = [
  space("product", "Product launch", "Roadmap, launch notes, positioning, and the long description that tests wrapping.", true),
  space("research", "Research vault", "Collected sources and open questions from the team.", false),
  space("empty", "Empty workspace", "A space with no chats yet.", false),
];
export const mockSessions: UserSessionListItem[] = [
  session("s-running", "product", "Agent is preparing the launch brief", "running", "Drafting the competitive positioning and launch checklist…"),
  session("s-attention", "product", "Review the pricing page before publishing", "needs_attention", "I found two copy conflicts that need your decision."),
  session("s-complete", "research", "Summarize the customer interview notes", "completed", "The summary is ready with five recurring themes."),
  session("s-long", "research", "A very long chat title that should remain readable without pushing actions off screen on a narrow phone", "completed", "A deliberately long preview line to exercise truncation and row height."),
];
export const mockTurns: Record<string, SessionTurnRecord[]> = {};
export const mockTurnIndex: Record<string, SessionTurnIndexItem[]> = {};
for (const sessionId of ["s-running", "s-attention", "s-complete"]) {
  const turns = Array.from({ length: sessionId === "s-complete" ? 6 : 3 }, (_, index) => {
    const sequence = index + 1;
    return {
      id: `${sessionId}-turn-${sequence}`, sessionId, userUuid: "web-preview", sequence,
      status: sessionId === "s-running" && sequence === 3 ? "running" : "completed",
      intent: "chat", userContent: [{ type: "text", text: `User request for turn ${sequence}: continue the work.` }], userText: `User request for turn ${sequence}: continue the work.`,
      assistantContent: [{ type: "text", text: `Assistant response for turn ${sequence}. This longer response gives the locator enough content to scroll to a distinct position.` }], assistantText: `Assistant response for turn ${sequence}. This longer response gives the locator enough content to scroll to a distinct position.`,
      provider: "cohub", model: "mock-agent", stopReason: "stop", errorMessage: null, finalUsage: null, totalUsage: null, summary: null, intermediateIndex: null, intermediateSummary: null, meta: null, startedAt: now, completedAt: now, durationMs: 420, createdAt: now, updatedAt: now,
    } as unknown as SessionTurnRecord;
  });
  mockTurns[sessionId] = turns;
  mockTurnIndex[sessionId] = turns.map((turn) => ({ id: turn.id, sequence: turn.sequence, status: turn.status, userPreview: turn.userText, assistantPreview: turn.assistantText, provider: turn.provider, model: turn.model, createdAt: turn.createdAt } as SessionTurnIndexItem));
}
export const mockMessages: Record<string, MessageRecord[]> = {
  "s-running": [message("s-running-m1", "s-running", "user", 1, "Prepare a concise launch brief for the mobile app."), message("s-running-m2", "s-running", "assistant", 2, "I am comparing the current positioning, launch risks, and the checklist now. This running state should keep the composer and stop action usable.")],
  "s-attention": [message("s-attention-m1", "s-attention", "user", 1, "Review the pricing page."), message("s-attention-m2", "s-attention", "assistant", 2, "I found two copy conflicts that need your decision before I can finish.")],
  "s-complete": [message("s-complete-m1", "s-complete", "user", 1, "Summarize the interviews."), message("s-complete-m2", "s-complete", "assistant", 2, "The summary is ready with five recurring themes and three follow-up questions.")],
};
export const mockUsage = { requestCount: 128, successCount: 119, totalTokens: 84320, hourly: [] } as never;
export const mockModels: ModelCatalogEntry[] = [
  { provider: "cohub", id: "atlas", model: { name: "Atlas", description: "Fast general-purpose model", thinkingLevels: ["off", "low", "medium", "high"] } },
  { provider: "cohub", id: "sage", model: { name: "Sage", description: "Careful reasoning model", thinkingLevels: ["low", "medium", "high"] } },
];
