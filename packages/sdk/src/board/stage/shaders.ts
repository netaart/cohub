import { type BoardMatrix, multiplyMatrix } from "@cohub/protocol/board-layout";
import { type Container, type Filter, type Renderer, RendererType } from "pixi.js";
import type { BoardEditor } from "../editor/index.js";
import { type BoardViewport, type Rect, visibleWorldRect } from "../model/geometry.js";
import { boardItemLocalToWorld, boardLocalView } from "../render/shader/placement.js";
import type { BoardScene } from "../model/scene.js";
import { boardShaderSignature } from "../model/shader.js";
import type { BoardShaderLayer } from "../render/shader/layer.js";
import { type BoardShaderOwner, type BoardShaderPlacement, createBoardShaderLayers } from "../render/shader/layers.js";
import type { BoardDeviceTier } from "./device.js";
import type { BoardScene as BoardStageScene } from "./scene.js";

const QUALITY: Record<BoardDeviceTier, number> = { low: 0.5, standard: 0.75, high: 1 };
const MIN_QUALITY = 0.25;
const FRAME_MS = 1000 / 60;
const WINDOW = 30;
const SUSPENDED_KEY = "cohub.board.shaders.suspended";
const IDENTITY: BoardMatrix = [1, 0, 0, 1, 0, 0];

function shaderKey(owner: BoardShaderOwner): string {
  return owner.output.shader ? boardShaderSignature(owner.output.shader) : "";
}

function readSuspended(): Set<string> {
  try {
    return new Set(JSON.parse(globalThis.sessionStorage?.getItem(SUSPENDED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

// Steps down only while that speeds frames up, so a display capped below 60 Hz keeps its quality.
function createBoardShaderQuality(ceiling: number) {
  const intervals = new Float32Array(WINDOW);
  let filled = 0;
  let value = ceiling;
  let pace = FRAME_MS;
  let probe: { value: number; interval: number } | null = null;
  let steady = 0;
  const change = (next: number) => {
    value = next;
    filled = 0;
    steady = 0;
  };
  return {
    get value() {
      return value;
    },
    sample(interval: number) {
      if (interval > 250) return;
      intervals[filled++ % WINDOW] = interval;
      if (filled < WINDOW) return;
      const mean = intervals.reduce((sum, entry) => sum + entry, 0) / WINDOW;
      if (mean < pace * 0.8) pace = Math.max(FRAME_MS, mean);
      if (probe) {
        const helped = mean < probe.interval * 0.85;
        if (!helped) pace = mean;
        change(helped ? value : probe.value);
        probe = null;
      } else if (mean > pace * 1.6 && value > MIN_QUALITY) {
        probe = { value, interval: mean };
        change(Math.max(MIN_QUALITY, value * 0.75));
      } else if (mean < pace * 1.15 && value < ceiling && ++steady > 180) {
        change(Math.min(ceiling, value / 0.75));
      }
    },
  };
}

export function createBoardStageShaders(options: {
  editor: BoardEditor;
  renderer: Renderer;
  canvas: HTMLCanvasElement;
  scene: BoardStageScene;
  nodes: Container;
  below: Container;
  above: Container;
  tier: BoardDeviceTier;
  owners(): BoardShaderOwner[];
  fault(id: string, message: string): void;
  dark(): boolean;
  reducedMotion(): boolean;
  color(value: unknown): [number, number, number, number];
}) {
  const { editor, renderer, scene, nodes } = options;
  const layers = createBoardShaderLayers();
  const rootFilters = new Map<string, readonly Filter[]>();
  const rootContainers = new Map<string, Container>();
  const suspended = readSuspended();
  const paused = new Map<string, string>();
  let running: BoardShaderOwner[] = [];
  const supported = renderer.type === RendererType.WEBGL;
  const quality = createBoardShaderQuality(QUALITY[options.tier]);
  let lastSync = 0;

  function applyRootFilters() {
    const filters = [...rootFilters.values()].flat();
    nodes.filters = filters.length ? filters : null;
  }

  function attachRoot(owner: BoardShaderOwner, layer: BoardShaderLayer | null, camera: BoardViewport, view: Rect): BoardShaderPlacement | null {
    if (!layer) {
      rootContainers.get(owner.id)?.removeFromParent();
      rootContainers.delete(owner.id);
      if (rootFilters.delete(owner.id)) applyRootFilters();
      return null;
    }
    if (layer.container) {
      const parent = layer.layer === "below" ? options.below : options.above;
      if (layer.container.parent !== parent) parent.addChild(layer.container);
      rootContainers.set(owner.id, layer.container);
    }
    if (layer.filters && rootFilters.get(owner.id) !== layer.filters) {
      rootFilters.set(owner.id, layer.filters);
      applyRootFilters();
    }
    return { region: view, view, localToWorld: IDENTITY, localToGlobal: [camera.zoom, 0, 0, camera.zoom, camera.x, camera.y] };
  }

  function attachItem(owner: BoardShaderOwner, layer: BoardShaderLayer | null, camera: BoardViewport, view: Rect): BoardShaderPlacement | null {
    if (!layer) {
      scene.decorate(owner.id, null);
      return null;
    }
    const drawn = scene.decorate(owner.id, {
      below: layer.layer === "below" ? layer.container : null,
      above: layer.layer === "above" ? layer.container : null,
      filters: layer.filters,
    });
    const item = editor.scene.get(owner.id);
    if (!drawn || !item) return null;
    const localToWorld = boardItemLocalToWorld(item.frame);
    return {
      region: { x: 0, y: 0, width: item.frame.width, height: item.frame.height },
      view: boardLocalView(view, localToWorld),
      localToWorld,
      localToGlobal: multiplyMatrix([camera.zoom, 0, 0, camera.zoom, camera.x, camera.y], localToWorld),
    };
  }

  const lost = (event: Event) => {
    event.preventDefault();
    for (const owner of running) {
      suspended.add(shaderKey(owner));
      paused.set(owner.id, shaderKey(owner));
      options.fault(owner.id, "The GPU reset while this shader ran, so it is paused for this session. Restart it to try again.");
    }
    try {
      globalThis.sessionStorage?.setItem(SUSPENDED_KEY, JSON.stringify([...suspended].slice(-64)));
    } catch {}
  };
  options.canvas.addEventListener("webglcontextlost", lost);

  return {
    get animated() {
      return layers.animated && !options.reducedMotion();
    },
    get active() {
      return layers.size > 0;
    },
    sync(camera: BoardViewport, surface: { width: number; height: number }) {
      if (!supported) return;
      const owners: BoardShaderOwner[] = [];
      for (const owner of options.owners()) {
        const key = shaderKey(owner);
        if (suspended.has(key)) {
          paused.set(owner.id, key);
          options.fault(owner.id, "This shader stopped the GPU earlier in this session. Restart it to try again.");
          continue;
        }
        owners.push(options.reducedMotion() ? { ...owner, time: 0 } : owner);
      }
      running = owners;
      if (!owners.length && !layers.size) return;
      const now = performance.now();
      if (layers.animated && lastSync) quality.sample(now - lastSync);
      lastSync = now;
      const view = visibleWorldRect(camera, surface.width, surface.height);
      layers.sync(renderer, owners, {
        zoom: camera.zoom,
        density: renderer.resolution,
        quality: quality.value,
        dark: options.dark(),
        color: options.color,
        fault: options.fault,
        attach: (owner, layer) => (owner.root ? attachRoot : attachItem)(owner, layer, camera, view),
      }, editor.scene as BoardScene, (world) => editor.idsInRect(world));
    },
    prepare() {
      if (supported && layers.size) layers.prepare(renderer);
    },
    restart(id: string) {
      const key = paused.get(id);
      if (!key) return;
      paused.delete(id);
      suspended.delete(key);
      try {
        globalThis.sessionStorage?.setItem(SUSPENDED_KEY, JSON.stringify([...suspended]));
      } catch {}
    },
    destroy() {
      options.canvas.removeEventListener("webglcontextlost", lost);
      layers.destroy();
      rootFilters.clear();
    },
  };
}

export type BoardStageShaders = ReturnType<typeof createBoardStageShaders>;
