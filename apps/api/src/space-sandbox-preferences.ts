import { join } from "node:path";
import { eq } from "drizzle-orm";
import { billingOperations, COHUB_BILLING_FEATURES } from "@cohub/billing";
import { spaces } from "@cohub/db";
import { listEnabledSpaceMods } from "@cohub/core/space-mods";
import { createLogger } from "@cohub/infra/logging";
import { db } from "./db/index.js";
import { config } from "./config.js";
import { CheckpointFsError, getCheckpointForSpace, readCheckpointFile } from "./checkpoint-fs.js";
import { SANDBOX_CONFIG_PATH, parseSandboxPreferences, readSandboxPreferences, resolveSandboxPreferences, type SandboxPreferenceSource } from "./sandbox-preferences.js";

const logger = createLogger({ serviceName: "cohub-api" });

export async function getAllowedSandboxSpecId(userId: string) {
  try {
    const state = await billingOperations.getState({ userId });
    const keys = new Set(state.entitlements.filter((item) => item.enabled).map((item) => item.key));
    if (keys.has(COHUB_BILLING_FEATURES.sandboxSpecUltra)) return "ultra" as const;
    if (keys.has(COHUB_BILLING_FEATURES.sandboxSpecBoost)) return "boost" as const;
  } catch (error) {
    logger.warn("[SandboxSpec] entitlement check failed; using standard", { userId, error });
  }
  return "standard" as const;
}

export const getSandboxImageCatalog = () => ({
  default: config.sandboxImage,
  ...(config.sandboxGameImage ? { game: config.sandboxGameImage } : {}),
});

const modPreferenceCache = new Map<string, Promise<SandboxPreferenceSource>>();

async function readModPreferences(modSpaceId: string): Promise<SandboxPreferenceSource> {
  const source = `mod:${modSpaceId}`;
  let checkpoint: Awaited<ReturnType<typeof getCheckpointForSpace>>;
  try {
    checkpoint = await getCheckpointForSpace(modSpaceId, "latest");
  } catch (error) {
    if (error instanceof CheckpointFsError && error.code === "checkpoint_not_found") return { source, preferences: {} };
    throw error;
  }
  const key = `${modSpaceId}:${checkpoint.id}`;
  const cached = modPreferenceCache.get(key);
  if (cached) return cached;
  const loading = loadModCheckpointPreferences(modSpaceId, checkpoint);
  if (modPreferenceCache.size >= 256) {
    const oldest = modPreferenceCache.keys().next().value;
    if (oldest) modPreferenceCache.delete(oldest);
  }
  modPreferenceCache.set(key, loading);
  void loading.catch(() => { if (modPreferenceCache.get(key) === loading) modPreferenceCache.delete(key); });
  return loading;
}

async function loadModCheckpointPreferences(modSpaceId: string, checkpoint: Awaited<ReturnType<typeof getCheckpointForSpace>>): Promise<SandboxPreferenceSource> {
  const source = `mod:${modSpaceId}`;
  const revision = checkpoint.commitHash;
  try {
    const file = await readCheckpointFile({ spaceId: modSpaceId, checkpointId: checkpoint.id, path: SANDBOX_CONFIG_PATH, visibility: "full" });
    if (file.delivery === "url" || file.kind !== "text" || file.size > 16_384) throw new Error("Sandbox config must be text of at most 16 KiB");
    return { source, revision, preferences: parseSandboxPreferences(JSON.parse(file.content), true) };
  } catch (error) {
    if (error instanceof CheckpointFsError && error.code === "path_not_found") return { source, revision, preferences: {} };
    throw new Error(`Invalid sandbox config (${source}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function readPreferenceSource(source: string, load: () => Promise<SandboxPreferenceSource>): Promise<SandboxPreferenceSource> {
  try {
    return await load();
  } catch (error) {
    return { source, preferences: {}, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function resolveSpaceSandboxPreferences(spaceId: string, override?: { image?: unknown; spec?: unknown }, strict = false) {
  const [space] = await db.select({ owner: spaces.userUuid, meta: spaces.meta }).from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) throw new Error("Space not found");
  const meta = space.meta as { config?: { sandbox?: { image?: unknown; spec?: unknown; provider?: string } } } | null;
  const saved = meta?.config?.sandbox;
  const applicable = saved?.provider !== "local";
  const enabledMods = applicable ? await listEnabledSpaceMods(db, spaceId) : [];
  const [allowedSpec, modSources, project] = await Promise.all([
    getAllowedSandboxSpecId(space.owner),
    Promise.all(enabledMods.map((mod) => readPreferenceSource(`mod:${mod.modSpaceId}`, () => readModPreferences(mod.modSpaceId)))),
    applicable ? readPreferenceSource("space", () => readSandboxPreferences(join(config.spaceStorageRoot, spaceId, "workspace"), "space")) : { source: "space", preferences: {} },
  ]);
  const explicit = { image: saved?.image, spec: saved?.spec, ...override };
  const preferences = parseSandboxPreferences({
    ...(explicit.image != null ? { image: explicit.image } : {}),
    ...(explicit.spec != null ? { spec: explicit.spec } : {}),
  });
  const sources: SandboxPreferenceSource[] = [...modSources, project, { source: "override", preferences }];
  const resolved = resolveSandboxPreferences({
    sources,
    strict,
    images: getSandboxImageCatalog(),
    allowedSpec,
  });
  return { ...resolved, allowedSpec, enabledMods, applicable, overrides: preferences };
}
