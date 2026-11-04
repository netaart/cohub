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

export const BOARD_SESSION_SYNC_JOB = "board.session.sync";

export type BoardSessionSyncJobData = {
  sessionId: string;
  trace?: Record<string, unknown>;
};
