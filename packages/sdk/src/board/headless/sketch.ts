import type { BoardSketchItem } from "@cohub/protocol";
import { ImageSource, Texture } from "pixi.js";
import { Script, createContext, type Context } from "node:vm";
import type { SceneItem } from "../core/scene.js";
import type { BoardSketchHost } from "../render/renderers/board-renderer-registry.js";
import type { BoardHeadlessRenderer } from "./index.js";

const MAX_EDGE = 2048;
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_READ_TIMEOUT_MS = 15_000;
const MAX_PREPARE_CONCURRENCY = 4;

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

type SketchRuntime = {
  module: SketchModule;
  context: Context;
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

function runModule(code: string, src: string, timeoutMs: number): SketchRuntime {
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
  if (value.draw.constructor?.name === "AsyncFunction") throw new Error(`${src} must export a synchronous draw(ctx, frame) for headless export.`);
  return { module: value, context };
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

function frameScale(resolution: number, width: number, height: number): number {
  return Math.min(4, Math.max(0.25, resolution), MAX_EDGE / Math.max(1, width), MAX_EDGE / Math.max(1, height));
}

function textureFromCanvas(canvas: CanvasLike): Texture {
  return new Texture({ source: new ImageSource({ resource: canvas as never, width: canvas.width, height: canvas.height }) });
}

export type BoardHeadlessSketchOptions = {
  readModule: (src: string) => Promise<string>;
  timeoutMs?: number;
  readTimeoutMs?: number;
};

export function createBoardHeadlessSketchHost(
  headless: BoardHeadlessRenderer,
  options: BoardHeadlessSketchOptions,
): PreparedSketchHost {
  const textures = new Map<string, Texture>();
  const errors = new Map<string, string>();
  const lastErrors = new Map<string, string>();
  const modules = new Map<string, Promise<SketchRuntime>>();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;

  const loadModule = (src: string) => {
    let pending = modules.get(src);
    if (!pending) {
      pending = withTimeout(options.readModule(src), readTimeoutMs, src).then((code) => runModule(code, src, timeoutMs));
      modules.set(src, pending);
      pending.catch(() => modules.delete(src));
    }
    return pending;
  };

  const render = async (item: SketchFrame, time: number, scale: number) => {
    const key = frameKey(item, time, scale);
    if (textures.has(key) || errors.has(key)) return;
    try {
      const runtime = await loadModule(item.props.src);
      const width = Math.max(1, Math.round(item.frame.width * scale));
      const height = Math.max(1, Math.round(item.frame.height * scale));
      const canvas = headless.canvasModule.createCanvas(width, height) as CanvasLike;
      const context = canvas.getContext("2d");
      context.scale(scale, scale);
      const frame = {
        ...item.props,
        t: time,
        width: item.frame.width,
        height: item.frame.height,
        seed: item.props.seed ?? item.id,
      };
      runtime.context.__boardDraw = runtime.module.draw;
      runtime.context.__boardDrawContext = context;
      runtime.context.__boardFrame = frame;
      try {
        const drawResult = new Script("__boardDraw(__boardDrawContext, __boardFrame)", { filename: item.props.src }).runInContext(runtime.context, { timeout: timeoutMs });
        if (drawResult && typeof (drawResult as { then?: unknown }).then === "function") throw new Error(`${item.props.src} must export a synchronous draw(ctx, frame) for headless export.`);
      } finally {
        delete runtime.context.__boardDraw;
        delete runtime.context.__boardDrawContext;
        delete runtime.context.__boardFrame;
      }
      textures.set(key, textureFromCanvas(canvas));
      lastErrors.delete(item.id);
    } catch (error) {
      errors.set(key, error instanceof Error ? error.message : String(error));
      lastErrors.set(item.id, error instanceof Error ? error.message : String(error));
    }
  };

  return {
    frame(item, time, resolution) {
      const scale = frameScale(resolution, item.frame.width, item.frame.height);
      return textures.get(frameKey(item, time, scale)) ?? null;
    },
    error: (id) => lastErrors.get(id) ?? null,
    release: () => {},
    async prepare(items, times, zoom) {
      const sketches = items.filter((item) => item.type === "sketch");
      const jobs: Array<() => Promise<void>> = [];
      for (const item of sketches) {
        const scale = frameScale(zoom, item.frame.width, item.frame.height);
        for (const time of times) jobs.push(() => render(item, time, scale));
      }
      let next = 0;
      const worker = async () => {
        while (next < jobs.length) {
          const job = jobs[next++];
          if (job) await job();
        }
      };
      await Promise.all(Array.from({ length: Math.min(MAX_PREPARE_CONCURRENCY, jobs.length) }, worker));
    },
    destroy() {
      for (const texture of textures.values()) texture.destroy(true);
      textures.clear();
      errors.clear();
      lastErrors.clear();
      modules.clear();
    },
  };
}
