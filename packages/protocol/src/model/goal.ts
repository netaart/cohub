export const SESSION_GOAL_STATUSES = ["active", "blocked", "complete"] as const;

export type SessionGoalStatus = (typeof SESSION_GOAL_STATUSES)[number];

export const isSessionGoalStatus = (value: unknown): value is SessionGoalStatus =>
  typeof value === "string" && (SESSION_GOAL_STATUSES as readonly string[]).includes(value);

export type SessionGoal = {
  sessionId: string;
  goalId: string;
  objective: string;
  status: SessionGoalStatus;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SessionGoalWriteInput = {
  status: SessionGoalStatus;
};

export const MAX_SESSION_GOAL_OBJECTIVE_CHARS = 20_000;
