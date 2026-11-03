import { isSafeBoardSourcePath } from "./board-model.js";

export const BOARD_SCRIPT_MAX_BYTES = 2_000_000;

export type BoardScriptSource = {
  code: string;
  imports: Array<{
    start: number;
    end: number;
    path: string;
    dynamic: boolean;
  }>;
};
export type BoardScriptSources = Record<string, BoardScriptSource>;

export function createBoardScriptModuleReader(
  read: (path: string) => Promise<string>,
  timeoutMs = 15_000,
) {
  const cache = new Map<string, Promise<string>>();
  const queue: Array<() => void> = [];
  let active = 0;
  let disposed = false;
  function pump() {
    while (active < 4 && queue.length) queue.shift()?.();
  }
  return {
    read(path: string): Promise<string> {
      if (disposed)
        return Promise.reject(new Error("Module reader is disposed."));
      const cached = cache.get(path);
      if (cached) return cached;
      const promise = new Promise<string>((resolve, reject) => {
        queue.push(() => {
          if (disposed) {
            reject(new Error("Module reader is disposed."));
            return;
          }
          active++;
          let timer: ReturnType<typeof setTimeout>;
          const timeout = new Promise<never>((_resolve, rejectRead) => {
            timer = setTimeout(
              () => rejectRead(new Error(`Module read timed out: ${path}`)),
              timeoutMs,
            );
          });
          void Promise.race([Promise.resolve().then(() => read(path)), timeout])
            .then(resolve, reject)
            .finally(() => {
              clearTimeout(timer);
              active--;
              pump();
            });
        });
        pump();
      });
      cache.set(path, promise);
      void promise.catch(() => {
        if (cache.get(path) === promise) cache.delete(path);
      });
      return promise;
    },
    invalidate(path?: string) {
      if (path) cache.delete(path);
      else cache.clear();
    },
    destroy() {
      disposed = true;
      cache.clear();
      for (const job of queue.splice(0)) job();
    },
  };
}

export function resolveScriptImport(from: string, specifier: string): string {
  if (!specifier.startsWith("./") && !specifier.startsWith("../"))
    throw new Error(`Only relative module imports are supported: ${specifier}`);
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new Error("Module import leaves the Space.");
      parts.pop();
    } else parts.push(part);
  }
  const path = parts.join("/");
  if (!isSafeBoardSourcePath(path) || !/\.(m?js|json)$/.test(path))
    throw new Error(`Invalid module path: ${path}`);
  return path;
}

function isBoardScriptJson(path: string): boolean {
  return path.endsWith(".json");
}

export async function loadBoardScriptSources(
  src: string,
  read: (path: string) => Promise<string>,
  timeoutMs = 15_000,
): Promise<BoardScriptSources> {
  if (!isSafeBoardSourcePath(src) || !/\.m?js$/.test(src))
    throw new Error("Invalid script entry path.");
  const { init, parse } = await import("es-module-lexer");
  await init;
  const sources: BoardScriptSources = {};
  const loading = new Map<string, Promise<void>>();
  const edges = new Map<string, readonly string[]>();
  let bytes = 0;
  function load(path: string): Promise<void> {
    let promise = loading.get(path);
    if (promise) return promise;
    if (loading.size >= 64) throw new Error("A script may load at most 64 modules.");
    promise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const code = await Promise.race([
        Promise.resolve().then(() => read(path)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Module read timed out: ${path}`)), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      bytes += new TextEncoder().encode(code).byteLength;
      if (bytes > BOARD_SCRIPT_MAX_BYTES) throw new Error("Script modules exceed the 2 MB limit.");
      if (isBoardScriptJson(path)) {
        try {
          JSON.parse(code);
        } catch {
          throw new Error(`${path} is not valid JSON.`);
        }
        sources[path] = { code, imports: [] };
        return;
      }
      const [imports] = parse(code, path);
      const resolved: BoardScriptSource["imports"] = [];
      for (const entry of imports) {
        if (entry.d === -2) throw new Error("import.meta is not available in Board scripts.");
        if (entry.n === undefined) throw new Error("Dynamic imports must use a literal relative path.");
        const typed = entry.d >= 0
          ? entry.a >= 0 && /\btype\s*:\s*["']json["']/.test(code.slice(entry.a, entry.se))
          : Boolean(entry.at?.some(([key, value]) => key === "type" && value === "json"));
        if (typed !== isBoardScriptJson(entry.n))
          throw new Error(typed ? `Only .json files import with type "json": ${entry.n}` : `Import ${entry.n} with { type: "json" }.`);
        resolved.push({ start: entry.s, end: entry.e, path: resolveScriptImport(path, entry.n), dynamic: entry.d >= 0 });
      }
      // Waiting on a module that imports this one would never settle, so cycles fail here.
      const dependencies = resolved.map((entry) => entry.path);
      edges.set(path, dependencies);
      if (dependencies.some((dependency) => importsReach(dependency, path))) throw new Error(`Circular module dependency: ${path}`);
      await Promise.all(dependencies.map(load));
      sources[path] = { code, imports: resolved };
    })();
    loading.set(path, promise);
    return promise;
  }
  function importsReach(from: string, target: string, seen = new Set<string>()): boolean {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (edges.get(from) ?? []).some((next) => importsReach(next, target, seen));
  }
  await load(src);
  return sources;
}

export function scriptModuleUrls(
  sources: BoardScriptSources,
  shared: Map<string, { url: string; users: number }> = new Map(),
): {
  urls: Record<string, string>;
  dispose(): void;
} {
  const urls: Record<string, string> = {};
  const owned: string[] = [];
  const held: string[] = [];
  for (const [path, source] of Object.entries(sources)) {
    if (path.endsWith(".json")) {
      const key = `${path}\n${source.code}`;
      let json = shared.get(key);
      if (!json) {
        json = { url: URL.createObjectURL(new Blob([source.code], { type: "application/json" })), users: 0 };
        shared.set(key, json);
      }
      json.users++;
      held.push(key);
      urls[path] = json.url;
      continue;
    }
    let code = source.code;
    for (const entry of [...source.imports].reverse()) {
      const url = urls[entry.path];
      if (!url) throw new Error(`Unresolved module: ${entry.path}`);
      code =
        code.slice(0, entry.start) +
        (entry.dynamic ? JSON.stringify(url) : url) +
        code.slice(entry.end);
    }
    const url = URL.createObjectURL(
      new Blob(
        [
          `${code}\n//# sourceURL=cohub-script/${path.split("/").map(encodeURIComponent).join("/")}`,
        ],
        { type: "text/javascript" },
      ),
    );
    urls[path] = url;
    owned.push(url);
  }
  return {
    urls,
    dispose: () => {
      for (const url of owned) URL.revokeObjectURL(url);
      for (const key of held) {
        const json = shared.get(key);
        if (!json || --json.users > 0) continue;
        URL.revokeObjectURL(json.url);
        shared.delete(key);
      }
    },
  };
}
