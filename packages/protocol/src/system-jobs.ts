export const SESSION_MESSAGE_POSTPROCESS_JOB = "session.message.postprocess";
export const SESSION_TITLE_GENERATE_JOB = "session.title.generate";

export type SessionTitleGenerateJobData = {
  sessionId: string;
  messageId: string;
  userId: string | null;
  trace?: Record<string, unknown>;
};

export type SessionMessagePostprocessJobData = {
  sessionId: string;
  messageId: string;
  trace?: Record<string, unknown>;
};

export const isLlmUsageMessage = (message: { role: string; meta?: unknown }) => {
  const meta = message.meta && typeof message.meta === "object" ? message.meta as Record<string, unknown> : null;
  if (meta?.llm === false) return false;
  return message.role === "assistant" || (message.role === "system" && meta?.messageKind === "compacted");
};

export const BOARD_SESSION_SYNC_JOB = "board.session.sync";

export type BoardSessionSyncJobData = {
  sessionId: string;
  trace?: Record<string, unknown>;
};
