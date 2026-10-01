import type { BoardSketchItem } from "@cohub/protocol";
import { ImageSource, Texture } from "pixi.js";
import { Script, createContext } from "node:vm";
import type { SceneItem } from "../core/scene.js";
import type { BoardSketchHost } from "../render/renderers/board-renderer-registry.js";
import type { BoardHeadlessRenderer } from "./index.js";

const MAX_EDGE = 2048;
const DEFAULT_TIMEOUT_MS = 2_000;

type SketchFrame = SceneItem<BoardSketchItem>;
type CanvasLike = {
  width: number;
  height: number;
  getContext: (kind: "2d") => { scale: (x: number, y: number) => void };
};
type SketchModule = {
  default?: { draw?: SketchModule["draw"] };
  draw?: (context: unknown, frame: BoardSketchItem["props"] & { t: number; width: number; height: number; seed: string }) => unknown;
};

type PreparedSketchHost = BoardSketchHost & {
  prepare: (items: readonly SketchFrame[], times: readonly number[], zoom: number) => Promise<void>;
  destroy: () => void;
};

function transformModule(code: string, src: string): string {
  const transformed = code
    .replace(/export\s+default\s+/g, "module.exports.default = ")
    .replace(/export\s+(async\s+)?function\s+draw\b/g, (_match, asyncKeyword = "") => `module.exports.draw = ${asyncKeyword}function draw`)
    .replace(/export\s+(const|let|var)\s+draw\s*=/g, "module.exports.draw =");
  return `(function(module, exports) {\n${transformed}\n})(module, module.exports);\n//# sourceURL=${JSON.stringify(src)}`;
}

function runModule(code: string, src: string, timeoutMs: number): SketchModule {
  const module = { exports: {} as SketchModule };
  const context = createContext({
    module,
    exports: module.exports,
    console: { log() {}, warn() {}, error() {} },
    fetch: undefined,
    XMLHttpRequest: undefined,
    WebSocket: undefined,
    EventSource: undefined,
    importScripts: undefined,
    indexedDB: undefined,
    caches: undefined,
    process: undefined,
    require: undefined,
  });
  new Script(transformModule(code, src), { filename: src }).runInContext(context, { timeout: timeoutMs });
  const value = module.exports.default && typeof module.exports.default === "object"
    ? { ...module.exports.default, ...module.exports }
    : module.exports;
  if (typeof value.draw !== "function") throw new Error(`${src} does not export draw(ctx, frame)`);
  return value;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, src: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${src} exceeded the ${timeoutMs}ms sketch timeout.`)), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function frameKey(item: SketchFrame, time: number, scale: number): string {
  return `${item.id}|${time}|${item.frame.width}|${item.frame.height}|${scale}|${item.props.seed ?? item.id}|${JSON.stringify(item.props.params)}`;
}

function textureFromCanvas(canvas: CanvasLike): Texture {
  return new Texture({ source: new ImageSource({ resource: canvas as never, width: canvas.width, height: canvas.height }) });
}

export type BoardHeadlessSketchOptions = {
  readModule: (src: string) => Promise<string>;
  timeoutMs?: number;
};

export function createBoardHeadlessSketchHost(
  headless: BoardHeadlessRenderer,
  options: BoardHeadlessSketchOptions,
): PreparedSketchHost {
  const textures = new Map<string, Texture>();
  const errors = new Map<string, string>();
  const modules = new Map<string, Promise<SketchModule>>();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const loadModule = (src: string) => {
    let pending = modules.get(src);
    if (!pending) {
      pending = options.readModule(src).then((code) => runModule(code, src, timeoutMs));
      modules.set(src, pending);
      pending.catch(() => modules.delete(src));
    }
    return pending;
  };

  const render = async (item: SketchFrame, time: number, scale: number) => {
    const key = frameKey(item, time, scale);
    if (textures.has(key) || errors.has(item.id)) return;
    try {
      const module = await loadModule(item.props.src);
      const width = Math.max(1, Math.round(item.frame.width * scale));
      const height = Math.max(1, Math.round(item.frame.height * scale));
      const canvas = headless.canvasModule.createCanvas(width, height) as CanvasLike;
      const context = canvas.getContext("2d");
      context.scale(scale, scale);
      await withTimeout(Promise.resolve(module.draw?.(context, {
        ...item.props,
        t: time,
        width: item.frame.width,
        height: item.frame.height,
        seed: item.props.seed ?? item.id,
      })), timeoutMs, item.props.src);
      textures.set(key, textureFromCanvas(canvas));
    } catch (error) {
      errors.set(item.id, error instanceof Error ? error.message : String(error));
    }
  };

  return {
    frame(item, time, resolution) {
      const scale = Math.min(resolution, MAX_EDGE / Math.max(1, item.frame.width), MAX_EDGE / Math.max(1, item.frame.height));
      return textures.get(frameKey(item, time, scale)) ?? null;
    },
    error: (id) => errors.get(id) ?? null,
    release: () => {},
    async prepare(items, times, zoom) {
      const sketches = items.filter((item) => item.type === "sketch");
      const jobs: Promise<void>[] = [];
      for (const item of sketches) {
        const scale = Math.min(4, Math.max(0.25, zoom), MAX_EDGE / Math.max(1, item.frame.width), MAX_EDGE / Math.max(1, item.frame.height));
        for (const time of times) jobs.push(render(item, time, scale));
      }
      await Promise.all(jobs);
    },
    destroy() {
      for (const texture of textures.values()) texture.destroy(true);
      textures.clear();
      errors.clear();
      modules.clear();
    },
  };
}
