import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { assertValidUserId } from "./ids.js";

export const SANDBOX_WORKSPACE_PATH = "/workspace";
export const SANDBOX_PLATFORM_CONFIG_PATH = "/configs/platform";
export const SANDBOX_PLATFORM_AGENT_PATH = `${SANDBOX_PLATFORM_CONFIG_PATH}/.cohub`;
export const SANDBOX_PLATFORM_AGENTS_PATH = `${SANDBOX_PLATFORM_CONFIG_PATH}/.agents`;
export const SANDBOX_PLATFORM_SKILLS_PATH = `${SANDBOX_PLATFORM_AGENTS_PATH}/skills`;
export const SANDBOX_USER_CONFIG_PATH = "/configs/user";
export const SANDBOX_USER_AGENT_PATH = `${SANDBOX_USER_CONFIG_PATH}/.cohub`;
export const SANDBOX_USER_AGENTS_PATH = `${SANDBOX_USER_CONFIG_PATH}/.agents`;
export const SANDBOX_USER_SKILLS_PATH = `${SANDBOX_USER_AGENTS_PATH}/skills`;
export const SANDBOX_WORKSPACE_AGENTS_PATH = `${SANDBOX_WORKSPACE_PATH}/.agents`;
export const SANDBOX_WORKSPACE_SKILLS_PATH = `${SANDBOX_WORKSPACE_AGENTS_PATH}/skills`;

export function getAgentConfigRoot() {
  return process.env.PLATFORM_CONFIG_ROOT ?? "/configs";
}

export function getAgentPlatformConfigPath() {
  return join(getAgentConfigRoot(), "platform");
}

export function getAgentPlatformAgentPath() {
  return join(getAgentPlatformConfigPath(), ".cohub");
}

export function getAgentPlatformAgentsPath() {
  return join(getAgentPlatformConfigPath(), ".agents");
}

export function getAgentPlatformSkillsPath() {
  return join(getAgentPlatformAgentsPath(), "skills");
}

export function getAgentPlatformModelsPath() {
  return join(getAgentPlatformAgentPath(), "models.json");
}

export function getAgentPlatformAuthPath() {
  return join(getAgentPlatformAgentPath(), "auth.json");
}

export function getAgentUserConfigPath(userId: string) {
  return join(getAgentConfigRoot(), "users", assertValidUserId(userId));
}

export function getAgentUserAgentPath(userId: string) {
  return join(getAgentUserConfigPath(userId), ".cohub");
}

export function getAgentUserAgentsPath(userId: string) {
  return join(getAgentUserConfigPath(userId), ".agents");
}

export function getAgentUserSkillsPath(userId: string) {
  return join(getAgentUserAgentsPath(userId), "skills");
}

export function getAgentUserModelsPath(userId: string) {
  return join(getAgentUserAgentPath(userId), "models.json");
}

export function getAgentWorkspacePath(spaceId: string) {
  return join(process.env.WORKSPACE_ROOT ?? "/space-storage", spaceId, "workspace");
}

export function getAgentCheckpointCacheRoot() {
  return process.env.CHECKPOINT_CACHE_ROOT ?? "/checkpoint-cache";
}

export function getAgentModSnapshotPath(modSpaceId: string) {
  return join(getAgentCheckpointCacheRoot(), modSpaceId, "latest");
}

export function getAgentWorkspaceAgentsPath(spaceIdOrWorkspacePath: string) {
  const workspacePath = spaceIdOrWorkspacePath.startsWith("/")
    ? spaceIdOrWorkspacePath
    : getAgentWorkspacePath(spaceIdOrWorkspacePath);
  return join(workspacePath, ".agents");
}

export function getAgentWorkspaceSkillsPath(spaceIdOrWorkspacePath: string) {
  return join(getAgentWorkspaceAgentsPath(spaceIdOrWorkspacePath), "skills");
}

export function getAgentSpaceSessionsPath(spaceId: string) {
  return join(process.env.SESSIONS_DIR ?? "/sessions", "spaces", spaceId);
}

export function getAgentSessionFilePath(spaceId: string, sessionId: string) {
  return join(getAgentSpaceSessionsPath(spaceId), `${sessionId}.jsonl`);
}

export async function ensureAgentSpaceSessionPath(spaceId: string) {
  await mkdir(getAgentSpaceSessionsPath(spaceId), { recursive: true }).catch(() => undefined);
}
