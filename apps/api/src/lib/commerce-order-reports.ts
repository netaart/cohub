import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { isUuidOrShortUuid } from "@cohub/protocol/identifiers";

const CONFIG_PATH = join("platform", ".cohub", "commerce", "order-reports.yaml");
const SCHEMA = "cohub.commerce.order-reports.v1";

/** Operations Space id to the shop Space ids it may report on. */
export type CommerceOrderReports = ReadonlyMap<string, readonly string[]>;

const EMPTY: CommerceOrderReports = new Map();
let cached: { root: string; mtimeMs: number; size: number; reports: CommerceOrderReports } | null = null;

export function canonicalSpaceId(value: string): string | null {
  if (!isUuidOrShortUuid(value)) return null;
  const hex = value.replaceAll("-", "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function spaceId(value: unknown, where: string) {
  const id = typeof value === "string" ? canonicalSpaceId(value.trim()) : null;
  if (!id) throw new Error(`Commerce order reports ${where} is not a Space id: ${String(value)}`);
  return id;
}

export function parseCommerceOrderReports(rawText: string): CommerceOrderReports {
  const parsed = parse(rawText) as unknown;
  if (parsed === null || parsed === undefined) return EMPTY;
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Commerce order reports config must be an object");
  const { schema, reports } = parsed as { schema?: unknown; reports?: unknown };
  if (schema !== undefined && schema !== SCHEMA) throw new Error(`Unsupported commerce order reports schema: ${String(schema)}`);
  if (reports === undefined || reports === null) return EMPTY;
  if (typeof reports !== "object" || Array.isArray(reports)) throw new Error("Commerce order reports `reports` must map Space ids to shop lists");
  const result = new Map<string, string[]>();
  for (const [operations, shops] of Object.entries(reports)) {
    const id = spaceId(operations, "operations Space");
    if (!Array.isArray(shops)) throw new Error(`Commerce order reports for ${id} must be a list of shop Space ids`);
    result.set(id, [...new Set(shops.map((shop) => spaceId(shop, `shop for ${id}`)))]);
  }
  return result;
}

/**
 * Reloads on every edit published to the platform config root. Access grants fail closed:
 * a missing or invalid file enables no reports, so a broken edit can never keep a removed shop readable.
 */
export async function loadCommerceOrderReports(
  platformConfigRoot: string,
  onError: (error: unknown) => void,
): Promise<CommerceOrderReports> {
  const path = join(platformConfigRoot, CONFIG_PATH);
  try {
    const info = await stat(path);
    if (cached?.root === platformConfigRoot && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.reports;
    const reports = parseCommerceOrderReports(await readFile(path, "utf-8"));
    cached = { root: platformConfigRoot, mtimeMs: info.mtimeMs, size: info.size, reports };
    return reports;
  } catch (error) {
    cached = null;
    if ((error as { code?: unknown }).code !== "ENOENT") onError(error);
    return EMPTY;
  }
}
