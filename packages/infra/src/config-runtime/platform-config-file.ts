import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

type Cached<T> = { mtimeMs: number; size: number; value: T };

/**
 * One hot-reloaded file under the published platform config root. Never throws: a broken file is
 * reported and the last valid value keeps serving, or `empty` if none was loaded yet. A missing
 * file means `empty`.
 */
export function createPlatformConfigFile<T>(input: {
  path: string;
  parse: (rawText: string) => T;
  empty: T;
}) {
  const cache = new Map<string, Cached<T>>();

  async function load(platformConfigRoot: string, onError: (error: unknown) => void): Promise<T> {
    const path = join(platformConfigRoot, input.path);
    try {
      const info = await stat(path);
      const cached = cache.get(platformConfigRoot);
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.value;
      const value = input.parse(await readFile(path, "utf-8"));
      cache.set(platformConfigRoot, { mtimeMs: info.mtimeMs, size: info.size, value });
      return value;
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") {
        cache.delete(platformConfigRoot);
        return input.empty;
      }
      onError(error);
      // Re-read: a concurrent load may have cached a newer valid value during this one's I/O.
      return cache.get(platformConfigRoot)?.value ?? input.empty;
    }
  }

  return { load, clear: () => cache.clear() };
}
