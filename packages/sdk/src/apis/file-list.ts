import { isHttpErrorCode } from "../http-error.js";
import type { Fetch, HttpTransport } from "../transport.js";
import type { SpaceFsListOptions, SpaceFsTreePage, SpaceFsTreeResponse } from "../types.js";

export type FileListOptions = SpaceFsListOptions & { fetch?: Fetch; signal?: AbortSignal };

type TreePage = SpaceFsTreeResponse & Partial<SpaceFsTreePage>;

const DIRECTORY_CHANGED_RETRY_DELAYS_MS = [100, 250, 500] as const;

export async function listDirectory(
  transport: HttpTransport,
  endpoint: string,
  path: string,
  options?: Fetch | FileListOptions,
): Promise<SpaceFsTreeResponse | SpaceFsTreePage> {
  const pageOptions = typeof options === "object" ? options : undefined;
  const fetch = typeof options === "function" ? options : pageOptions?.fetch;
  const readPage = (cursor: string | undefined) => {
    const params = new URLSearchParams({ pagination: "true" });
    if (path) params.set("path", path);
    if (pageOptions?.limit !== undefined) params.set("limit", String(pageOptions.limit));
    if (cursor) params.set("cursor", cursor);
    return transport.request<TreePage>(`${endpoint}?${params}`, { fetch, signal: pageOptions?.signal });
  };
  if (pageOptions) {
    const page = await readPage(pageOptions.cursor);
    return { ...page, nextCursor: page.nextCursor ?? null, truncated: page.truncated ?? true };
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await readAllPages(readPage, path);
    } catch (error) {
      const delay = DIRECTORY_CHANGED_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isHttpErrorCode(error, "directory_changed")) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function readAllPages(
  readPage: (cursor: string | undefined) => Promise<TreePage>,
  path: string,
): Promise<SpaceFsTreeResponse> {
  const entries = new Map<string, SpaceFsTreeResponse["entries"][number]>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  let responsePath = path;
  do {
    const page = await readPage(cursor);
    const nextCursor = page.nextCursor ?? null;
    responsePath = page.path;
    for (const entry of page.entries) entries.set(entry.path, entry);
    if (nextCursor && seen.has(nextCursor)) throw new Error("Server returned a repeated directory cursor.");
    if (nextCursor) seen.add(nextCursor);
    cursor = nextCursor ?? undefined;
  } while (cursor);
  const rank = { dir: 0, symlink: 1, file: 2 };
  return {
    path: responsePath,
    entries: [...entries.values()].sort((a, b) => rank[a.type] - rank[b.type] || a.name.localeCompare(b.name)),
  };
}
