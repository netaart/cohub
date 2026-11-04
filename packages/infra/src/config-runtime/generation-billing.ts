import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

const CONFIG_PATH = join("platform", ".cohub", "billing", "generation-reserves.yaml");

export type GenerationBillingConfig = {
  /** Model id to reserve cap in USD. Only listed models are prepaid. */
  reserves: ReadonlyMap<string, number>;
};

type CachedConfig = {
  mtimeMs: number;
  size: number;
  config: GenerationBillingConfig;
};

const EMPTY_CONFIG: GenerationBillingConfig = { reserves: new Map() };
const cache = new Map<string, CachedConfig>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseGenerationBillingConfig(rawText: string): GenerationBillingConfig {
  const parsed = parse(rawText) as unknown;
  if (parsed === null || parsed === undefined) return EMPTY_CONFIG;
  if (!isRecord(parsed)) throw new Error("Generation billing config must be an object");
  if (parsed.schema !== undefined && parsed.schema !== "cohub.generation.billing.v1") {
    throw new Error(`Unsupported generation billing config schema: ${String(parsed.schema)}`);
  }
  const models = parsed.models;
  if (models === undefined) return EMPTY_CONFIG;
  if (!isRecord(models)) throw new Error("Generation billing config models must be an object");

  const reserves = new Map<string, number>();
  for (const [model, value] of Object.entries(models)) {
    const id = model.trim();
    if (!id) throw new Error("Generation billing config contains an empty model id");
    if (!isRecord(value)) {
      throw new Error(`Generation billing config for ${id} must be an object`);
    }
    const reserveUsd = value.reserveUsd;
    if (typeof reserveUsd !== "number" || !Number.isFinite(reserveUsd) || reserveUsd <= 0) {
      throw new Error(`Generation billing config reserveUsd for ${id} must be a positive number`);
    }
    reserves.set(id, Number(reserveUsd.toFixed(8)));
  }
  return { reserves };
}

export function resolveGenerationBillingReserve(
  config: GenerationBillingConfig,
  model: string,
): number | null {
  return config.reserves.get(model.trim()) ?? null;
}

/**
 * Never throws: a broken config must not block non-whitelisted models. On error it reports and keeps the
 * last valid config, or no whitelist (the original post-success charge path) if none was loaded yet.
 */
export async function loadGenerationBillingConfig(
  platformConfigRoot: string,
  onError: (error: unknown) => void,
): Promise<GenerationBillingConfig> {
  const path = join(platformConfigRoot, CONFIG_PATH);
  const cached = cache.get(platformConfigRoot);
  try {
    const info = await stat(path);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.config;
    const config = parseGenerationBillingConfig(await readFile(path, "utf-8"));
    cache.set(platformConfigRoot, { mtimeMs: info.mtimeMs, size: info.size, config });
    return config;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      cache.delete(platformConfigRoot);
      return EMPTY_CONFIG;
    }
    onError(error);
    return cached?.config ?? EMPTY_CONFIG;
  }
}

export function clearGenerationBillingConfigCache(): void {
  cache.clear();
}
