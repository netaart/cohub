import { isSafeBoardSourcePath } from "./board-model.js";

export const BOARD_SCRIPT_MAX_BYTES = 2_000_000;
export const BOARD_SCRIPT_ASSET_MAX_BYTES = 32_000_000;

const ASSET = /\.(woff2?|ttf|otf|png|jpe?g|webp|gif|avif|bin)$/i;

export type BoardScriptSource = {
  code: string;
  imports: Array<{
    start: number;
    end: number;
    path: string;
    dynamic: boolean;
    attributes?: [number, number];
  }>;
  bytes?: Uint8Array;
};
export type BoardScriptSources = Record<string, BoardScriptSource>;

export type BoardScriptReaders = {
  module(path: string): Promise<string>;
  asset?(path: string): Promise<Uint8Array>;
  timeoutMs?: number;
};

export function createBoardScriptModuleReader<T = string>(
  read: (path: string) => Promise<T>,
  timeoutMs = 15_000,
) {
  const cache = new Map<string, Promise<T>>();
  const queue: Array<() => void> = [];
  let active = 0;
  let disposed = false;
  function pump() {
    while (active < 4 && queue.length) queue.shift()?.();
  }
  return {
    read(path: string): Promise<T> {
      if (disposed)
        return Promise.reject(new Error("Module reader is disposed."));
      const cached = cache.get(path);
      if (cached) return cached;
      const promise = new Promise<T>((resolve, reject) => {
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
  if (!isSafeBoardSourcePath(path) || !(/\.(m?js|json)$/.test(path) || ASSET.test(path)))
    throw new Error(`Invalid module path: ${path}`);
  return path;
}

function importType(path: string): "json" | "bytes" | null {
  return path.endsWith(".json") ? "json" : ASSET.test(path) ? "bytes" : null;
}

function withTimeout<T>(read: () => Promise<T>, path: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve().then(read),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Module read timed out: ${path}`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function loadBoardScriptSources(src: string, readers: BoardScriptReaders): Promise<BoardScriptSources> {
  const timeoutMs = readers.timeoutMs ?? 15_000;
  if (!isSafeBoardSourcePath(src) || !/\.m?js$/.test(src))
    throw new Error("Invalid script entry path.");
  const { init, parse } = await import("es-module-lexer");
  await init();
  const sources: BoardScriptSources = {};
  const loading = new Map<string, Promise<void>>();
  const edges = new Map<string, readonly string[]>();
  let bytes = 0;
  let assetBytes = 0;
  function load(path: string): Promise<void> {
    let promise = loading.get(path);
    if (promise) return promise;
    if (loading.size >= 64) throw new Error("A script may load at most 64 modules.");
    promise = (async () => {
      if (importType(path) === "bytes") {
        const { asset } = readers;
        if (!asset) throw new Error(`${path}: this host cannot load assets.`);
        const data = await withTimeout(() => asset(path), path, timeoutMs);
        assetBytes += data.byteLength;
        if (assetBytes > BOARD_SCRIPT_ASSET_MAX_BYTES) throw new Error("Script assets exceed the 32 MB limit.");
        sources[path] = { code: "", imports: [], bytes: data };
        return;
      }
      const code = await withTimeout(() => readers.module(path), path, timeoutMs);
      bytes += new TextEncoder().encode(code).byteLength;
      if (bytes > BOARD_SCRIPT_MAX_BYTES) throw new Error("Script modules exceed the 2 MB limit.");
      if (importType(path) === "json") {
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
        if (entry.type === "import-meta")
          throw new Error("import.meta is not available in Board scripts.");
        const specifier = entry.specifier;
        if (specifier === undefined || (entry.type === "dynamic" && entry.glob))
          throw new Error("Dynamic imports must use a literal relative path.");
        const dynamic = entry.type === "dynamic";
        const typed = dynamic
          ? entry.attributesStart >= 0
            ? (/\btype\s*:\s*["']([^"']*)["']/.exec(code.slice(entry.attributesStart, entry.importEnd))?.[1] ?? null)
            : null
          : (entry.attributes?.find(([key]) => key === "type")?.[1] ?? null);
        if (typed && typed !== importType(specifier))
          throw new Error(typed === "json" ? `Only .json files import with type "json": ${specifier}`
            : typed === "bytes" ? `Only fonts, images and .bin files import with type "bytes": ${specifier}`
            : `Unknown import type "${typed}": ${specifier}`);
        resolved.push({
          start: entry.start, end: entry.end, path: resolveScriptImport(path, specifier), dynamic,
          ...(typed ? { attributes: (dynamic ? [entry.end, entry.importEnd - 1] : [entry.end + 1, entry.importEnd]) as [number, number] } : {}),
        });
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
  shared: Map<string | Uint8Array, { url: string; users: number; data?: string }> = new Map(),
): {
  urls: Record<string, string>;
  dispose(): void;
} {
  const urls: Record<string, string> = {};
  const owned: string[] = [];
  const held: Array<string | Uint8Array> = [];
  for (const [path, source] of Object.entries(sources)) {
    if (source.bytes) {
      let asset = shared.get(source.bytes);
      if (!asset) {
        const data = URL.createObjectURL(new Blob([source.bytes as Uint8Array<ArrayBuffer>]));
        const module = `export default new Uint8Array(await (await fetch(${JSON.stringify(data)})).arrayBuffer());`;
        asset = { url: URL.createObjectURL(new Blob([module], { type: "text/javascript" })), users: 0, data };
        shared.set(source.bytes, asset);
      }
      asset.users++;
      held.push(source.bytes);
      urls[path] = asset.url;
      continue;
    }
    if (path.endsWith(".json")) {
      const key = `${path}\n${source.code}`;
      let json = shared.get(key);
      if (!json) {
        const module = `export default JSON.parse(${JSON.stringify(source.code)});`;
        json = { url: URL.createObjectURL(new Blob([module], { type: "text/javascript" })), users: 0 };
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
      if (entry.attributes) code = code.slice(0, entry.attributes[0]) + code.slice(entry.attributes[1]);
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
        const entry = shared.get(key);
        if (!entry || --entry.users > 0) continue;
        URL.revokeObjectURL(entry.url);
        if (entry.data) URL.revokeObjectURL(entry.data);
        shared.delete(key);
      }
    },
  };
}
