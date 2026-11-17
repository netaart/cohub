import { createModelTasksConfigLoader } from "@cohub/infra/config-runtime/model-tasks";
import { redis } from "../redis.js";
import { getAgentConfigRoot } from "./paths.js";

const loadModelTasksConfig = createModelTasksConfigLoader({
  platformConfigRoot: getAgentConfigRoot(),
  redis,
});

export const loadImageToTextConfig = async (userId?: string | null) =>
  (await loadModelTasksConfig(userId)).imageToText ?? null;

export const loadContextCompactionConfig = async (userId?: string | null) =>
  (await loadModelTasksConfig(userId)).contextCompaction ?? null;
