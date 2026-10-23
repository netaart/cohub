import { createHash } from "node:crypto";
import type { SpaceFsListOptions, SpaceFsTreePage, SpaceFsTreeResponse } from "@cohub/protocol/fs";

export class FsPaginationError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function parseFsPagination(query: Record<string, string | undefined>): SpaceFsListOptions | undefined {
  if (query.pagination === undefined && query.limit === undefined && query.cursor === undefined) return undefined;
  if (query.pagination !== "true") throw new FsPaginationError(400, "invalid_pagination", "Pagination must be enabled explicitly.");
  const limit = query.limit === undefined ? 1000 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
    throw new FsPaginationError(400, "invalid_pagination", "Page size must be between 1 and 5000.");
  }
  if (query.cursor !== undefined && (!query.cursor || query.cursor.length > 16384)) {
    throw new FsPaginationError(400, "invalid_cursor", "Invalid directory cursor.");
  }
  return { pagination: true, limit, cursor: query.cursor };
}

export function directoryCursor(scope: string, options?: SpaceFsListOptions, version?: string) {
  const key = createHash("sha256").update(scope).digest("base64url");
  const versionKey = version === undefined ? "" : createHash("sha256").update(version).digest("base64url");
  let after = "";
  if (options?.cursor) {
    let value: unknown;
    try { value = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")); } catch { value = undefined; }
    if (!Array.isArray(value) || value.length !== 4 || value[0] !== 1 || value[1] !== key || typeof value[2] !== "string" || typeof value[3] !== "string") {
      throw new FsPaginationError(400, "invalid_cursor", "Invalid directory cursor.");
    }
    if (version !== undefined && value[2] !== versionKey) {
      throw new FsPaginationError(409, "directory_changed", "Directory changed. Restart the listing.");
    }
    after = value[3];
  }
  return {
    after,
    encode: (name: string) => Buffer.from(JSON.stringify([1, key, versionKey, name])).toString("base64url"),
  };
}

export function pageDirectory(
  tree: SpaceFsTreeResponse,
  scope: string,
  options: SpaceFsListOptions,
  { version, truncated = false }: { version?: string; truncated?: boolean } = {},
): SpaceFsTreePage {
  const cursor = directoryCursor(scope, options, version);
  const sorted = [...tree.entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const start = sorted.findIndex((entry) => entry.name > cursor.after);
  const entries = start < 0 ? [] : sorted.slice(start, start + (options.limit ?? 1000));
  const hasMore = start >= 0 && start + entries.length < sorted.length;
  const last = entries.at(-1);
  return { path: tree.path, entries, nextCursor: hasMore && last ? cursor.encode(last.name) : null, truncated };
}
