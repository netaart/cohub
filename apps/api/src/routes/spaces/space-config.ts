import { DEFAULT_SANDBOX_SPEC_ID, SANDBOX_SPECS, getDefaultSandboxIdleTtl, isSandboxSpecId, type SandboxSpecId } from "@cohub/sandbox-controller";
import type { Context } from "hono";
import type { spaces } from "@cohub/db";
import { getSandboxImageCatalog } from "../../space-sandbox-preferences.js";
import { parseSandboxPreferences, type SandboxImageId } from "../../sandbox-preferences.js";
import { config } from "../../config.js";
import type { SpaceSandboxAutoDestroyPolicy, SpaceSandboxProvider } from "../../space-create.js";
import { validateSpaceEnv, SpaceEnvValidationError } from "../../space-sessions.js";
import { featureGateResponse } from "../../lib/feature-gate.js";

export type SpaceConfigInput = {
  sandbox?: {
    provider?: SpaceSandboxProvider;
    autoDestroy?: SpaceSandboxAutoDestroyPolicy;
    spec?: SandboxSpecId | null;
    image?: SandboxImageId | null;
  };
  guest?: { appId: string } | null;
};

export const DEFAULT_SPACE_SANDBOX_AUTO_DESTROY: SpaceSandboxAutoDestroyPolicy = {
  mode: "idle",
  ttlSeconds: getDefaultSandboxIdleTtl(config.env),
};

const MIN_SPACE_SANDBOX_AUTO_DESTROY_TTL_SECONDS = 60;
const MAX_SPACE_SANDBOX_AUTO_DESTROY_TTL_SECONDS = 30 * 24 * 60 * 60;
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readSpaceConfig = (space: typeof spaces.$inferSelect) => {
  const meta = isRecord(space.meta) ? space.meta : {};
  const config = isRecord(meta.config) ? meta.config : {};
  return { meta, config };
};

export const normalizeSpaceSandboxAutoDestroyPolicy = (value: unknown): SpaceSandboxAutoDestroyPolicy => {
  if (!isRecord(value) || typeof value.mode !== "string") {
    throw new Error("sandbox.autoDestroy must be an object with mode");
  }
  if (value.mode === "never") return { mode: "never" };
  if (value.mode !== "idle") {
    throw new Error("sandbox.autoDestroy.mode must be idle or never");
  }
  const ttlSeconds = Number((value as { ttlSeconds?: unknown }).ttlSeconds);
  if (!Number.isInteger(ttlSeconds)) {
    throw new Error("sandbox.autoDestroy.ttlSeconds must be an integer number of seconds");
  }
  if (ttlSeconds < MIN_SPACE_SANDBOX_AUTO_DESTROY_TTL_SECONDS || ttlSeconds > MAX_SPACE_SANDBOX_AUTO_DESTROY_TTL_SECONDS) {
    throw new Error(`sandbox.autoDestroy.ttlSeconds must be between ${MIN_SPACE_SANDBOX_AUTO_DESTROY_TTL_SECONDS} and ${MAX_SPACE_SANDBOX_AUTO_DESTROY_TTL_SECONDS}`);
  }
  return { mode: "idle", ttlSeconds };
};

export const getSpaceSandboxAutoDestroyPolicy = (space: typeof spaces.$inferSelect) => {
  const { config } = readSpaceConfig(space);
  const sandbox = isRecord(config.sandbox) ? config.sandbox : {};
  const autoDestroy = sandbox.autoDestroy;
  if (!autoDestroy) return DEFAULT_SPACE_SANDBOX_AUTO_DESTROY;
  try {
    return normalizeSpaceSandboxAutoDestroyPolicy(autoDestroy);
  } catch {
    return DEFAULT_SPACE_SANDBOX_AUTO_DESTROY;
  }
};

const normalizeSpaceSandboxProvider = (value: unknown): SpaceSandboxProvider => {
  if (value === "local") return "local";
  if (value === undefined || value === null || value === "cloud") return "cloud";
  throw new Error("sandbox.provider must be 'cloud' or 'local'");
};

export const getSpaceSandboxProvider = (space: typeof spaces.$inferSelect): SpaceSandboxProvider => {
  const { config } = readSpaceConfig(space);
  const sandbox = isRecord(config.sandbox) ? config.sandbox : {};
  return sandbox.provider === "local" ? "local" : "cloud";
};

const normalizeSpaceSandboxSpec = (value: unknown): SandboxSpecId => {
  if (value === undefined || value === null) return DEFAULT_SANDBOX_SPEC_ID;
  if (isSandboxSpecId(value)) return value;
  throw new Error(`sandbox.spec must be one of: ${Object.keys(SANDBOX_SPECS).join(", ")}`);
};

export const createSandboxSpecRequiredResponse = (c: Context, specId: SandboxSpecId) =>
  featureGateResponse(c, {
    source: "sandbox_spec",
    message: `${SANDBOX_SPECS[specId].label} sandboxes are available on ${SANDBOX_SPECS[specId].requiredPlan ?? "a higher plan"}.`,
    title: `Upgrade for ${SANDBOX_SPECS[specId].label} sandboxes`,
    conversionMessage: `Choose a higher plan to use ${SANDBOX_SPECS[specId].label} with ${SANDBOX_SPECS[specId].resources.limits.cpu} vCPU and ${SANDBOX_SPECS[specId].resources.limits.memory} memory.`,
  });

export const normalizeSpaceConfigInput = (input?: SpaceConfigInput | null): SpaceConfigInput => {
  const provider = normalizeSpaceSandboxProvider(input?.sandbox?.provider);
  const policy = input?.sandbox?.autoDestroy;
  const spec = input?.sandbox?.spec == null ? null : normalizeSpaceSandboxSpec(input.sandbox.spec);
  const image = input?.sandbox?.image ?? null;
  if (image !== null) {
    parseSandboxPreferences({ image });
    if (!getSandboxImageCatalog()[image]) throw new Error("Sandbox image is unavailable");
  }
  return {
    sandbox: {
      provider,
      autoDestroy: policy ? normalizeSpaceSandboxAutoDestroyPolicy(policy) : DEFAULT_SPACE_SANDBOX_AUTO_DESTROY,
      spec,
      image,
    },
  };
};

export const mergeSpaceConfig = (space: typeof spaces.$inferSelect, patch: SpaceConfigInput) => {
  const { meta, config } = readSpaceConfig(space);
  const nextSandbox = {
    ...(isRecord(config.sandbox) ? config.sandbox : {}),
    ...(patch.sandbox?.provider ? { provider: patch.sandbox.provider } : {}),
    ...(patch.sandbox?.autoDestroy ? { autoDestroy: patch.sandbox.autoDestroy } : {}),
    ...(patch.sandbox?.spec !== undefined ? { spec: patch.sandbox.spec } : {}),
    ...(patch.sandbox?.image !== undefined ? { image: patch.sandbox.image } : {}),
  };
  const { guest, ...rest } = config;
  const nextGuest = patch.guest === undefined ? guest : patch.guest;
  return {
    ...meta,
    config: {
      ...rest,
      ...(patch.sandbox ? { sandbox: nextSandbox } : {}),
      ...(nextGuest ? { guest: nextGuest } : {}),
    },
  };
};

const toSpaceEnvValidationResponse = (error: unknown) => {
  if (!(error instanceof SpaceEnvValidationError)) return null;
  return { message: error.message };
};

export const validateSpaceEnvForResponse = (envs: Array<{ name: string; value: string }>) => {
  try {
    validateSpaceEnv(envs);
    return null;
  } catch (error) {
    const response = toSpaceEnvValidationResponse(error);
    if (response) return response;
    throw error;
  }
};
