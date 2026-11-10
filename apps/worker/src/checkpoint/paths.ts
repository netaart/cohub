import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";

export const CHECKPOINT_ASSET_MANIFEST_PATH = ".cohub/system/checkpoint-assets.v1.json";
export const CHECKPOINT_META_PATH = ".cohub/system/checkpoint-meta.v1.json";
export const USER_GIT_REPOS_PATH = ".cohub/system/user-git-repos.v2.json";
export const LEGACY_USER_GIT_REPOS_PATH = ".cohub/system/user-git-repos.v1.json";

export const getCheckpointWorkspaceDir = (spaceId: string) =>
  join(config.spaceStorageRoot, spaceId, "workspace");

export const getCheckpointSystemDir = (spaceId: string) =>
  join(config.spaceSystemRoot, spaceId);

export const getCheckpointSystemRepoDir = (spaceId: string) =>
  join(getCheckpointSystemDir(spaceId), "repo");

export const getCheckpointLatestDir = (spaceId: string) =>
  join(config.checkpointCacheRoot, spaceId, "latest");

export const getCheckpointLatestSubPath = (spaceId: string) =>
  `${config.checkpointCacheSubpath}/${spaceId}/latest`;

/** The cache repository is left to its readers (API, restore), which create it on first use. */
export const ensureCheckpointDirs = async (spaceId: string) => {
  const workspaceDir = getCheckpointWorkspaceDir(spaceId);
  const systemDir = getCheckpointSystemDir(spaceId);
  const repoDir = getCheckpointSystemRepoDir(spaceId);
  const latestDir = getCheckpointLatestDir(spaceId);

  await Promise.all([workspaceDir, systemDir, latestDir].map((dir) => mkdir(dir, { recursive: true, mode: 0o775 })));
  await Promise.all([workspaceDir, systemDir, latestDir].map((dir) => chmod(dir, 0o775).catch(() => undefined)));

  return { workspaceDir, systemDir, repoDir, latestDir };
};
