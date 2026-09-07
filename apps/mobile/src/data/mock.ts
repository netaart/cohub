import type { MessageRecord, ModelCatalogEntry, SessionTurnIndexItem, SessionTurnRecord, SpaceFsEntry, SpaceRecord, UserSessionListItem } from "@neta-art/cohub";

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
  session("s-failed", "product", "Launch brief generation failed", "failed", "The Agent run failed after preparing the source notes."),
  session("s-complete", "research", "Summarize the customer interview notes", "completed", "The summary is ready with five recurring themes."),
  session("s-long", "research", "A very long chat title that should remain readable without pushing actions off screen on a narrow phone", "completed", "A deliberately long preview line to exercise truncation and row height."),
];
export const mockTurns: Record<string, SessionTurnRecord[]> = {};
export const mockTurnIndex: Record<string, SessionTurnIndexItem[]> = {};
for (const sessionId of ["s-running", "s-failed", "s-complete", "s-long"]) {
  const turns = Array.from({ length: sessionId === "s-complete" ? 6 : 3 }, (_, index) => {
    const sequence = index + 1;
    const failed = sessionId === "s-failed" && sequence === 3;
    return {
      id: `${sessionId}-turn-${sequence}`, sessionId, userUuid: "web-preview", sequence,
      status: failed ? "failed" : sessionId === "s-running" && sequence === 3 ? "running" : "completed",
      intent: "chat", userContent: [{ type: "text", text: `User request for turn ${sequence}: continue the work.` }], userText: `User request for turn ${sequence}: continue the work.`,
      assistantContent: failed ? null : [{ type: "text", text: `Assistant response for turn ${sequence}. This longer response gives the locator enough content to scroll to a distinct position.` }], assistantText: failed ? null : `Assistant response for turn ${sequence}. This longer response gives the locator enough content to scroll to a distinct position.`,
      provider: "cohub", model: "mock-agent", stopReason: failed ? null : "stop", errorMessage: failed ? "The Agent run ended before the launch brief could be completed." : null, finalUsage: null, totalUsage: null, summary: null, intermediateIndex: null, intermediateSummary: null, meta: null, startedAt: now, completedAt: now, durationMs: 420, createdAt: now, updatedAt: now,
    } as unknown as SessionTurnRecord;
  });
  mockTurns[sessionId] = turns;
  mockTurnIndex[sessionId] = turns.map((turn) => ({ id: turn.id, sequence: turn.sequence, status: turn.status, userPreview: turn.userText, assistantPreview: turn.assistantText, provider: turn.provider, model: turn.model, createdAt: turn.createdAt } as SessionTurnIndexItem));
}
export const mockMessages: Record<string, MessageRecord[]> = {
  "s-running": [message("s-running-m1", "s-running", "user", 1, "Prepare a concise launch brief for the mobile app."), message("s-running-m2", "s-running", "assistant", 2, "I am comparing the current positioning, launch risks, and the checklist now. This running state should keep the composer and stop action usable.")],
  "s-failed": [message("s-failed-m1", "s-failed", "user", 1, "Prepare the launch brief."), message("s-failed-m2", "s-failed", "assistant", 2, "The Agent run failed after preparing the source notes.")],
  "s-complete": [message("s-complete-m1", "s-complete", "user", 1, "Summarize the interviews."), message("s-complete-m2", "s-complete", "assistant", 2, "The summary is ready with five recurring themes and three follow-up questions.")],
};
export const mockUsage = { requestCount: 128, successCount: 119, totalTokens: 84320, hourly: [] } as never;
export const mockModels: ModelCatalogEntry[] = [
  { provider: "openai", id: "gpt-5", model: { name: "GPT-5", description: "OpenAI flagship reasoning model", reasoning: true, contextWindow: 400_000, cost: { input: 1.25, output: 10 } } },
  { provider: "anthropic", id: "claude-opus-4-1", model: { name: "Claude Opus 4.1", description: "Anthropic most capable model", reasoning: true, contextWindow: 200_000, cost: { input: 15, output: 75 } } },
  { provider: "google", id: "gemini-2.5-pro", model: { name: "Gemini 2.5 Pro", description: "Google multimodal model", reasoning: true, input: ["image"], contextWindow: 1_000_000, cost: { input: 1.25, output: 10 } } },
  { provider: "deepseek", id: "deepseek-chat", model: { name: "DeepSeek Chat", description: "Cost-effective general model", contextWindow: 128_000, cost: { input: 0.27, output: 1.1 } } },
  { provider: "qwen", id: "qwen3-max", model: { name: "Qwen3 Max", description: "Alibaba flagship model", reasoning: true, contextWindow: 256_000 } },
  { provider: "xai", id: "grok-4", model: { name: "Grok 4", description: "xAI reasoning model", reasoning: true, contextWindow: 256_000 } },
];

const file = (path: string, type: SpaceFsEntry["type"], size = 0, mimeType: string | null = null): SpaceFsEntry => ({ name: path.split("/").pop() ?? path, path, type, size, mimeType, mtimeMs: Date.parse("2026-09-01T08:00:00Z") });
const folder = (path: string): SpaceFsEntry => file(path, "dir");

export const mockFileTree: Record<string, SpaceFsEntry[]> = {
  "": [
    folder("docs"),
    folder("src"),
    file("README.md", "file", 4821, "text/markdown"),
    file("package.json", "file", 1263, "application/json"),
    file("logo.png", "file", 24576, "image/png"),
    file("demo.mp4", "file", 10485760, "video/mp4"),
    file("budget.xlsx", "file", 15360, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    file("assets.zip", "file", 5242880, "application/zip"),
    file("backup.sqlite", "file", 61440, "application/x-sqlite3"),
  ],
  docs: [
    file("notes.md", "file", 2107, "text/markdown"),
    file("spec.pdf", "file", 209715, "application/pdf"),
    file("logo-dark.png", "file", 18944, "image/png"),
  ],
  src: [
    folder("components"),
    file("index.ts", "file", 512, "text/typescript"),
    file("styles.css", "file", 2048, "text/css"),
    file("config.yml", "file", 384, "text/yaml"),
  ],
  "src/components": [
    file("Button.tsx", "file", 1229, "text/typescript-tsxx"),
    file("Header.tsx", "file", 2048, "text/typescript-tsxx"),
    file("icon.svg", "file", 940, "image/svg+xml"),
    file("click.wav", "file", 40960, "audio/wav"),
  ],
};
