import ignore from "ignore";
import { openSpaceFile } from "./pinned.js";

const GIT_DIR_PATTERN = /^\.git(?:\/|$)/;
const GITIGNORE_CACHE_TTL_MS = 30_000;

export type SpaceFsVisibility = "full" | "filtered";

export type SpaceGitignoreFilter = {
  isIgnored(path: string, options?: { isDirectory?: boolean }): boolean;
};

const normalizeFilterPath = (path: string) => path.replace(/\\/g, "/").replace(/^\/+/, "");
const asDirectoryPath = (path: string) => path.endsWith("/") ? path : `${path}/`;

type CachedGitignoreFilter = {
  filter: SpaceGitignoreFilter;
  signature: string;
  expiresAt: number;
};

const filterCache = new Map<string, CachedGitignoreFilter>();

const getErrorCode = (error: unknown) => typeof error === "object" && error !== null && "code" in error
  ? String((error as { code?: unknown }).code)
  : undefined;

function createFilter(content: string | null): SpaceGitignoreFilter {
  const matcher = ignore();
  if (content) matcher.add(content);
  return {
    isIgnored(path, options) {
      const normalized = normalizeFilterPath(path);
      return normalized.length > 0 && (
        GIT_DIR_PATTERN.test(normalized) ||
        matcher.ignores(normalized) ||
        (options?.isDirectory === true && matcher.ignores(asDirectoryPath(normalized)))
      );
    },
  };
}

export async function createSpaceGitignoreFilter(root: string): Promise<SpaceGitignoreFilter> {
  const file = await openSpaceFile(root, ".gitignore").catch((error: unknown) => {
    if (getErrorCode(error) === "ENOENT") return null;
    throw error;
  });
  try {
    const now = Date.now();
    const stats = await file?.stat();
    const signature = stats ? `${stats.dev}:${stats.ino}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}` : "missing";
    const cached = filterCache.get(root);
    if (cached && cached.signature === signature && cached.expiresAt > now) return cached.filter;
    const content = file ? await file.readFile("utf8") : null;
    const filter = createFilter(content);
    filterCache.set(root, { filter, signature, expiresAt: now + GITIGNORE_CACHE_TTL_MS });
    return filter;
  } finally {
    await file?.close();
  }
}
