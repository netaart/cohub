export const APP_ACTION_EXECUTION_SOURCE = "app_action" as const;

export type TaskType = string;

export type RunCommandSource = "run_command" | typeof APP_ACTION_EXECUTION_SOURCE;

export type RunCommandTaskData = {
  command: string;
  cwd?: string;
  source?: RunCommandSource;
  actionInput?: unknown;
  appId?: string;
  appVersionId?: string;
  action?: string;
  actorUserId?: string;
  viewerUserId?: string;
  executionScopes?: string[];
  [key: string]: unknown;
};

export interface TaskPayload {
  type: TaskType;
  spaceId?: string;
  sessionId?: string;
  turnId?: string;
  userId?: string;
  cronJobId?: string;
  data?: Record<string, unknown>;
}

export type RunCommandTaskPayload = Omit<TaskPayload, "type" | "data"> & {
  type: "run_command";
  data: RunCommandTaskData;
};

export type TaskRunStatus = "pending" | "running" | "completed" | "failed";

export interface TaskScheduleConfig {
  pattern: string;
  timezone?: string;
}

export { sanitizeTaskRunForList, stripInlineMedia } from "./list-view.js";
