import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

const CONFIG_PATHS = [
  join("platform", ".cohub", "billing", "generation-reserves.yaml"),
  join("platform", ".cohub", "billing", "generation-reserves.yml"),
  join("platform", ".cohub", "generation-reserves.yaml"),
  join("platform", ".cohub", "generation-reserves.yml"),
] as const;

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

async function readConfigFile(platformConfigRoot: string): Promise<{ rawText: string; mtimeMs: number; size: number } | null> {
  for (const relativePath of CONFIG_PATHS) {
    const path = join(platformConfigRoot, relativePath);
    try {
      const info = await stat(path);
      return { rawText: await readFile(path, "utf-8"), mtimeMs: info.mtimeMs, size: info.size };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT") continue;
      throw error;
    }
  }
  return null;
}

export async function loadGenerationBillingConfig(
  platformConfigRoot: string,
): Promise<GenerationBillingConfig> {
  const key = platformConfigRoot;
  const file = await readConfigFile(platformConfigRoot);
  if (!file) {
    cache.delete(key);
    return EMPTY_CONFIG;
  }
  const cached = cache.get(key);
  if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
    return cached.config;
  }
  const config = parseGenerationBillingConfig(file.rawText);
  cache.set(key, { mtimeMs: file.mtimeMs, size: file.size, config });
  return config;
}

export function clearGenerationBillingConfigCache(): void {
  cache.clear();
}
