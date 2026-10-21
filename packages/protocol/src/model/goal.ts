import type { HarnessKind } from "../runtime/harnesses.js";
import type { ModelThinkingLevel } from "./completion.js";

export const SESSION_GOAL_STATUSES = [
  "active",
  "paused",
  "blocked",
  "budget_limited",
  "complete",
] as const;

export type SessionGoalStatus = (typeof SESSION_GOAL_STATUSES)[number];

export const isSessionGoalStatus = (value: unknown): value is SessionGoalStatus =>
  typeof value === "string" && (SESSION_GOAL_STATUSES as readonly string[]).includes(value);

export type SessionGoalAccessMode = "full_access" | "read_only";

export type SessionGoal = {
  sessionId: string;
  goalId: string;
  objective: string;
  status: SessionGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdSequence: number;
  harness: HarnessKind;
  provider: string | null;
  model: string | null;
  accessMode: SessionGoalAccessMode;
  thinkingLevel: ModelThinkingLevel | null;
  createdBy: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SessionGoalWriteInput = {
  objective?: string;
  tokenBudget?: number | null;
  status?: SessionGoalStatus;
  provider?: string | null;
  model?: string | null;
  accessMode?: SessionGoalAccessMode;
  thinkingLevel?: ModelThinkingLevel | null;
};

export type SessionGoalSetInput = SessionGoalWriteInput & {
  sessionId: string;
  objective: string;
  createdBy: string | null;
  /** First turn sequence counted toward the goal; defaults to the next turn. */
  includeTurnSequence?: number | null;
};

export const MAX_SESSION_GOAL_OBJECTIVE_CHARS = 20_000;
export const DEFAULT_SESSION_GOAL_ACCESS_MODE: SessionGoalAccessMode = "full_access";
