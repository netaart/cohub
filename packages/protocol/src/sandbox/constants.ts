/**
 * System-reserved environment variables that users cannot create or override.
 * Shared between API (validation) and Agent (process injection).
 */
export const SYSTEM_ENV_KEYS = [
  // sandbox pod-level
  "COHUB_SPACE_ID",
  "COHUB_SANDBOX_VERSION",
  "WORKSPACE_DIR",
  "PLATFORM_AGENTS_DIR",
  "USER_AGENTS_DIR",
  "IMAGE_VERSION", // Legacy Sandbox version env; reserved during migration.
  "POD_IP",
  "INTERNAL_API_BASE_URL",
  "PUBLIC_URL_PREFIX",
  "SANDBOX_REPORT_TOKEN",
  "SANDBOX_RPC_TOKEN",
  // agent process-level
  "COHUB_EXECUTION_TOKEN",
  "COHUB_SESSION_ID",
  "COHUB_TURN_ID",
  "COHUB_TOOL_CALL_ID",
  "COHUB_SOURCE_CLIENT_ID",
  "COHUB_MODEL_PROVIDER",
  "COHUB_MODEL_ID",
  "COHUB_USER_UUID",
  "COHUB_GENERATION_POLICY_B64",
  // space hook context
  "COHUB_HOOK_PATH",
  "COHUB_HOOK_TASK_RUN_ID",
  "COHUB_HOOK_EVENT_ID",
  "COHUB_HOOK_EVENT_TYPE",
  "COHUB_HOOK_SPACE_ID",
  "COHUB_HOOK_SESSION_ID",
  "COHUB_HOOK_TURN_ID",
  "COHUB_HOOK_CHECKPOINT_ID",
  "COHUB_HOOK_OCCURRED_AT",
  "COHUB_HOOK_ACTOR_USER_ID",
  "COHUB_HOOK_EXECUTION_USER_ID",
  "COHUB_HOOK_FS_CHANGE_COUNT",
  "COHUB_HOOK_FS_PATHS",
  "COHUB_HOOK_FS_KINDS",
  "COHUB_HOOK_APP_ID",
  "COHUB_HOOK_APP_VERSION_ID",
  "COHUB_HOOK_APP_VERSION",
  "COHUB_HOOK_TASK_ID",
  "COHUB_HOOK_TASK_TYPE",
  "COHUB_HOOK_TASK_STATUS",
  "COHUB_HOOK_TASK_CHANGED",
  "COHUB_HOOK_TASK_ERROR",
  "COHUB_HOOK_WEBHOOK_NAME",
  "COHUB_HOOK_WEBHOOK_BODY",
] as const;

export const SYSTEM_ENV_KEY_SET: Set<string> = new Set(SYSTEM_ENV_KEYS);

/** Redis key pattern for space-level user env cache */
export const SPACE_ENV_REDIS_KEY = (spaceId: string) => `space:env:${spaceId}`;
