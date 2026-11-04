import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { spaceMods, spaces } from "@cohub/db";
import { parseModelsConfig, type ModelsConfig } from "@cohub/infra/config-runtime/models";

export const SANDBOX_MODS_PATH = "/mods";

export type SpaceModRecord = typeof spaceMods.$inferSelect;

export type SpaceModListItem = SpaceModRecord & {
  modSpaceName: string | null;
  modSpaceDescription: string | null;
  mountPath: string;
};

type SpaceModsDb = PostgresJsDatabase<Record<string, unknown>>;

export function normalizeMountSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/_+/g, "_")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 63);
}

export function assertValidMountSlug(value: string): string {
  const slug = normalizeMountSlug(value);
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/.test(slug)) {
    throw new Error("mountSlug must be 1-63 chars of lowercase letters, numbers, hyphens, or underscores");
  }
  return slug;
}

export function getSpaceModMountPath(mountSlug: string) {
  return `${SANDBOX_MODS_PATH}/${assertValidMountSlug(mountSlug)}`;
}

export function createDefaultMountSlug(modSpaceId: string, existingSlugs: Iterable<string> = []) {
  const compact = modSpaceId.replaceAll("-", "").toLowerCase();
  const taken = new Set(Array.from(existingSlugs, (item) => item.toLowerCase()));
  for (const length of [8, 12, 16, 20, 32]) {
    const candidate = assertValidMountSlug(compact.slice(0, length));
    if (!taken.has(candidate)) return candidate;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = assertValidMountSlug(`${compact.slice(0, 8)}-${index}`);
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("failed to generate unique mod mount slug");
}

export function getSpaceModMountSignature(mods: Pick<SpaceModRecord, "modSpaceId" | "mountSlug" | "enabled" | "sortOrder">[]) {
  return JSON.stringify(
    mods
      .filter((mod) => mod.enabled)
      .map((mod) => ({ modSpaceId: mod.modSpaceId, mountSlug: mod.mountSlug, sortOrder: mod.sortOrder }))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.mountSlug.localeCompare(b.mountSlug)),
  );
}

export async function listSpaceMods(db: SpaceModsDb, spaceId: string): Promise<SpaceModListItem[]> {
  const rows = await db
    .select({
      mod: spaceMods,
      modSpaceName: spaces.name,
      modSpaceDescription: spaces.description,
    })
    .from(spaceMods)
    .leftJoin(spaces, eq(spaceMods.modSpaceId, spaces.id))
    .where(eq(spaceMods.spaceId, spaceId))
    .orderBy(asc(spaceMods.sortOrder), asc(spaceMods.createdAt));

  return rows.map((row) => ({
    ...row.mod,
    modSpaceName: row.modSpaceName,
    modSpaceDescription: row.modSpaceDescription,
    mountPath: getSpaceModMountPath(row.mod.mountSlug),
  }));
}

export async function listEnabledSpaceMods(db: SpaceModsDb, spaceId: string): Promise<SpaceModListItem[]> {
  return (await listSpaceMods(db, spaceId)).filter((mod) => mod.enabled);
}

export type LoadedSpaceModModelsConfig = {
  modSpaceId: string;
  /** Mount slug used as the source reference in diagnostics. */
  ref: string;
  config: ModelsConfig;
};

/**
 * Read enabled mods' `.cohub/models.json` from their latest checkpoint snapshot.
 * A broken or missing mod config never fails the caller; it is reported instead.
 */
export async function loadSpaceModModelsConfigs(
  db: SpaceModsDb,
  spaceId: string,
  options: {
    checkpointCacheRoot: string;
    readFile?: (path: string, encoding: "utf-8") => Promise<string>;
  },
): Promise<{ configs: LoadedSpaceModModelsConfig[]; warnings: string[] }> {
  const mods = await listEnabledSpaceMods(db, spaceId);
  const configs: LoadedSpaceModModelsConfig[] = [];
  const warnings: string[] = [];
  const read = options.readFile ?? readFile;

  for (const mod of mods) {
    const path = join(options.checkpointCacheRoot, mod.modSpaceId, "latest", ".cohub", "models.json");
    let rawText: string;
    try {
      rawText = await read(path, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      warnings.push(`Cannot read mod models.json at ${path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    try {
      configs.push({ modSpaceId: mod.modSpaceId, ref: mod.mountSlug, config: parseModelsConfig(rawText) });
    } catch (error) {
      warnings.push(`Ignoring invalid mod models.json at ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { configs, warnings };
}
