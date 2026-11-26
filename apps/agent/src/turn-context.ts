import { imageBlockToPi, type ContentBlock, type PiImageContent } from "@cohub/protocol/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { persistUserMessage } from "./persistence.js";
import { clearCurrentSessionExecutionAuth } from "./runtime/session-execution-auth.js";
import type { SessionHandle } from "./session-handle.js";

type AgentUserContent = { type: "text"; text: string } | PiImageContent;

export function contentToAgentMessage(content: ContentBlock[], meta: Record<string, unknown> | null): AgentMessage {
  const agentContent = content.flatMap((block): AgentUserContent[] => {
    if (block.type === "text") return [{ type: "text", text: block.text }];
    const image = block.type === "image" ? imageBlockToPi(block) : null;
    return image ? [image] : [];
  });
  return {
    role: "user",
    content: agentContent.length > 0 ? agentContent : [{ type: "text", text: "" }],
    timestamp: Date.now(),
    meta: meta ?? null,
  } as unknown as AgentMessage;
}

export type TurnUserMessage = {
  turnId: string;
  turnSeq: number;
  userMessageId: string;
  content: ContentBlock[];
  meta: Record<string, unknown>;
};

export function normalizeTurnUserMeta(input: TurnUserMessage, patch?: Record<string, unknown>) {
  return {
    ...input.meta,
    ...(patch ?? {}),
    userMessageId: input.userMessageId,
    messageId: input.userMessageId,
    turnId: input.turnId,
    anchorUserMessageId: input.userMessageId,
  };
}

export function setActiveTurnContext(handle: SessionHandle, input: {
  turnId: string;
  turnSeq: number;
  userMessageId: string | null;
  userMeta: Record<string, unknown> | null;
  llmRound?: number | null;
}) {
  handle.currentTurnId = input.turnId;
  handle.currentTurnSeq = input.turnSeq;
  handle.currentTurnPatchSeq = 0;
  handle.currentAssistantMessageOrdinal = null;
  handle.currentStreamMessageId = null;
  handle.currentUserMessageId = input.userMessageId;
  handle.currentUserMessageMeta = input.userMeta;
  handle.currentLlmRound = input.llmRound ?? 0;
}

export function clearActiveTurnContext(handle: SessionHandle, sessionId: string) {
  clearCurrentSessionExecutionAuth(sessionId);
  handle.currentLlmRound = null;
  handle.currentTurnId = null;
  handle.currentTurnSeq = null;
  handle.currentExecutionTurnIds.clear();
  handle.currentTurnPatchSeq = null;
  handle.currentAssistantMessageOrdinal = null;
  handle.currentStreamMessageId = null;
  handle.currentUserMessageId = null;
  handle.currentUserMessageMeta = null;
  handle.lastActiveAt = Date.now();
}

export async function appendAndPersistUserMessage(input: {
  handle: SessionHandle;
  spaceId: string;
  sessionId: string;
  user: TurnUserMessage;
  meta: Record<string, unknown>;
}) {
  const content = input.user.content;
  const message = contentToAgentMessage(content, input.meta);
  const startedAt = new Date().toISOString();
  input.handle.session.agent.state.messages.push(message);
  const entryId = input.handle.sessionManager.appendMessage(message);
  (message as unknown as Record<string, unknown>).sessionEntryId = entryId;

  await persistUserMessage({
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    userMessageId: input.user.userMessageId,
    turnId: input.user.turnId,
    agentSessionEntryId: entryId,
    content,
    meta: input.meta,
    startedAt,
  });

  return message;
}
