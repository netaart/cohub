import { applyMatrix, type BoardMatrix, framePoint, invertMatrix } from "@cohub/protocol/board-layout";
import type { Renderer } from "pixi.js";
import { itemBounds, type Rect, rectsIntersect } from "../../model/geometry.js";
import type { BoardScene, BoardSceneItem } from "../../model/scene.js";
import type { BoardScriptOutput, BoardScriptParameter } from "../../model/script.js";
import type { BoardDocument } from "@cohub/protocol";
import { isBoardRootScript } from "../../model/script-index.js";
import { boardScriptOf, scriptTemporaryPrefix } from "../../model/script-scene.js";
import { boardShaderParameters, boardShaderSignature } from "../../model/shader.js";
import type { BoardColor, BoardShapeItem } from "@cohub/protocol";
import { itemAlpha, itemColor } from "../palette.js";
import { DEFAULT_ROUNDED_RADIUS, roundRectPoints, shapeOutlinePoints } from "../stroke.js";
import type { BoardRenderContext } from "../renderers/board-renderer-registry.js";
import { type BoardShaderLayer, boardShaderSeed, createBoardShaderLayer } from "./layer.js";
import { type BoardSurfaceField, createBoardSurfaceField } from "./surfaces.js";

export type BoardShaderOwner = {
  id: string;
  root: boolean;
  output: BoardScriptOutput;
  params: Readonly<Record<string, unknown>>;
  seed: string;
  time: number;
};

export function boardShaderOwners(
  document: BoardDocument,
  outputs: Iterable<readonly [string, BoardScriptOutput]>,
  time: (id: string) => number,
): BoardShaderOwner[] {
  const owners: BoardShaderOwner[] = [];
  for (const [id, output] of outputs) {
    const script = output.shader ? boardScriptOf(document, id) : undefined;
    if (script) owners.push({ id, root: isBoardRootScript(document, id), output, params: script.params, seed: script.seed ?? id, time: time(id) });
  }
  return owners;
}

export type BoardShaderPlacement = {
  region: Rect;
  view: Rect;
  localToGlobal: BoardMatrix;
  localToWorld: BoardMatrix;
};

export type BoardShaderHost = {
  attach(owner: BoardShaderOwner, layer: BoardShaderLayer | null): BoardShaderPlacement | null;
  fault(id: string, message: string): void;
  zoom: number;
  density: number;
  quality: number;
  shading?: number;
  dark: boolean;
  color(value: unknown): [number, number, number, number];
};

export function boardShaderColor(context: Pick<BoardRenderContext, "colors" | "colorScheme" | "palette">, value: unknown): [number, number, number, number] {
  const color = itemColor(context, value as BoardColor | undefined, "brand", "fill");
  return [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255, itemAlpha(context, value as BoardColor | undefined)];
}

const SKIPPED = new Set(["frame", "arrow", "draw", "effect", "text"]);
const LIGHT_BLENDS = new Set(["screen", "add"]);
const SURFACE_EDGE = 512;
const SURFACE_MARGIN = 0.25;
const SURFACE_COARSEN = 1.5;
const SURFACE_INTERVAL_MS = 1000 / 30;

function grow(rect: Rect, margin: number): Rect {
  return { x: rect.x - rect.width * margin, y: rect.y - rect.height * margin, width: rect.width * (1 + 2 * margin), height: rect.height * (1 + 2 * margin) };
}

function surfaceOutline(item: BoardSceneItem): ReadonlyArray<{ x: number; y: number }> {
  const { width, height } = item.frame;
  const radius = item.style?.radius;
  if (item.type === "shape") {
    const { geometry } = item.props as BoardShapeItem["props"];
    return shapeOutlinePoints(geometry, width, height, radius ?? (geometry === "rounded" ? DEFAULT_ROUNDED_RADIUS : 0));
  }
  return roundRectPoints(width, height, radius ?? 0);
}

export function boardSurfaceOutlines(scene: BoardScene, owner: string, world: Rect, worldToLocal: BoardMatrix, candidates?: Iterable<string>): number[][] {
  const prefix = scriptTemporaryPrefix(owner);
  const outlines: number[][] = [];
  const items: Iterable<BoardSceneItem> = candidates
    ? [...candidates].map((id) => scene.get(id)).filter((item): item is BoardSceneItem => Boolean(item))
    : scene.items;
  for (const item of items) {
    if (item.id === owner || SKIPPED.has(item.type) || LIGHT_BLENDS.has(item.style?.blend ?? "") || item.id.startsWith(prefix) || scene.opacity(item.id) <= 0) continue;
    if (!rectsIntersect(itemBounds(item.frame), world)) continue;
    const { width, height } = item.frame;
    const points: number[] = [];
    for (const point of surfaceOutline(item)) {
      const local = applyMatrix(worldToLocal, framePoint(item.frame, width ? point.x / width : 0, height ? point.y / height : 0));
      points.push(local.x, local.y);
    }
    outlines.push(points);
  }
  return outlines;
}

export function boardSurfaceRegion(previous: Rect | null, needed: Rect, margin: number): Rect {
  const grown = grow(needed, margin);
  if (
    previous && previous.x <= needed.x && previous.y <= needed.y &&
    previous.x + previous.width >= needed.x + needed.width && previous.y + previous.height >= needed.y + needed.height &&
    previous.width <= grown.width * SURFACE_COARSEN && previous.height <= grown.height * SURFACE_COARSEN
  )
    return previous;
  return grown;
}

function parameterValues(
  parameters: Record<string, BoardScriptParameter> | undefined,
  params: Readonly<Record<string, unknown>>,
  color: BoardShaderHost["color"],
): Record<string, number | number[]> {
  const values: Record<string, number | number[]> = {};
  for (const [name, spec] of Object.entries(parameters ?? {})) {
    const value = params[name] ?? spec.default;
    if (spec.type === "number") values[name] = typeof value === "number" && Number.isFinite(value) ? value : 0;
    else if (spec.type === "boolean") values[name] = value === true ? 1 : 0;
    else if (spec.type === "color") values[name] = color(value);
  }
  return values;
}

type Entry = {
  owner: BoardShaderOwner;
  output: BoardScriptOutput;
  signature: string;
  layer: BoardShaderLayer;
  surfaces: BoardSurfaceField | null;
  surfaceKey: string;
  surfaceScene: BoardScene | null;
  surfaceAt: number;
  surfaceSignature: string;
  outlines: number[][];
  placed: boolean;
};

function sameOutlines(a: readonly (readonly number[])[], b: readonly (readonly number[])[], tolerance: number): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    const left = a[index] as readonly number[];
    const right = b[index] as readonly number[];
    if (left.length !== right.length) return false;
    for (let point = 0; point < left.length; point++) if (Math.abs((left[point] as number) - (right[point] as number)) > tolerance) return false;
  }
  return true;
}

function outlineHash(outlines: readonly (readonly number[])[]): string {
  let hash = 2166136261;
  for (const outline of outlines) for (const value of outline) hash = Math.imul(hash ^ Math.round(value * 8), 16777619) >>> 0;
  return `${outlines.length}.${hash.toString(36)}`;
}


export function createBoardShaderLayers(options: { wait?: boolean; now?: () => number } = {}) {
  const now = options.now ?? (() => performance.now());
  const interval = options.wait ? 0 : SURFACE_INTERVAL_MS;
  const entries = new Map<string, Entry>();
  const compiling = new Map<string, { signature: string; layer: BoardShaderLayer }>();
  const failed = new Map<string, string>();
  let animated = false;
  let pending = false;

  function drop(id: string, host?: Pick<BoardShaderHost, "attach">) {
    const entry = entries.get(id);
    if (!entry) return;
    host?.attach(entry.owner, null);
    entries.delete(id);
    entry.layer.destroy();
    entry.surfaces?.destroy();
  }

  function dropCompiling(id: string) {
    compiling.get(id)?.layer.destroy();
    compiling.delete(id);
  }

  function surfaceField(entry: Entry, renderer: Renderer, owner: BoardShaderOwner, placement: BoardShaderPlacement, host: BoardShaderHost, scene: BoardScene, candidates?: (world: Rect) => Iterable<string>) {
    const { localToWorld } = placement;
    const region = owner.root ? boardSurfaceRegion(entry.surfaces?.region ?? null, placement.region, SURFACE_MARGIN) : placement.region;
    const corners = [applyMatrix(localToWorld, region), applyMatrix(localToWorld, { x: region.x + region.width, y: region.y + region.height }),
      applyMatrix(localToWorld, { x: region.x + region.width, y: region.y }), applyMatrix(localToWorld, { x: region.x, y: region.y + region.height })];
    const xs = corners.map((point) => point.x);
    const ys = corners.map((point) => point.y);
    const world = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    const edge = Math.max(64, Math.round(SURFACE_EDGE * (owner.root ? 1 + 2 * SURFACE_MARGIN : 1) * host.quality));
    const key = `${[region.x, region.y, region.width, region.height, ...localToWorld].map((n) => n.toFixed(3)).join(",")}|${edge}`;
    entry.surfaces ??= createBoardSurfaceField();
    const moved = key !== entry.surfaceKey;
    const at = now();
    if (moved || (entry.surfaceScene !== scene && at - entry.surfaceAt >= interval)) {
      entry.surfaceScene = scene;
      const outlines = boardSurfaceOutlines(scene, owner.id, world, invertMatrix(localToWorld), candidates?.(world));
      if (moved || !sameOutlines(outlines, entry.outlines, region.width / edge / 2)) {
        entry.surfaces.build(renderer, region, outlines, edge);
        entry.outlines = outlines;
        entry.surfaceAt = at;
        entry.surfaceSignature = `${key}|${outlineHash(outlines)}`;
      }
      entry.surfaceKey = key;
    } else if (entry.surfaceScene !== scene) pending = true;
    entry.layer.setSurfaces(entry.surfaces.texture, entry.surfaces.region, entry.surfaceSignature);
  }

  return {
    get animated() {
      return animated || pending;
    },
    get size() {
      return entries.size + compiling.size;
    },
    get compiling() {
      return compiling.size > 0;
    },
    layer: (id: string): BoardShaderLayer | null => entries.get(id)?.layer ?? null,
    sync(renderer: Renderer, owners: readonly BoardShaderOwner[], host: BoardShaderHost, scene: BoardScene, candidates?: (world: Rect) => Iterable<string>) {
      const alive = new Set<string>();
      animated = false;
      for (const owner of owners) {
        const { output } = owner;
        const shader = output.shader;
        const signature = shader && `${boardShaderSignature(shader)}|${JSON.stringify(boardShaderParameters(output.parameters))}`;
        if (!shader || !signature || failed.get(owner.id) === signature) continue;
        alive.add(owner.id);
        let entry = entries.get(owner.id);
        try {
          if (entry?.signature !== signature) {
            let next = compiling.get(owner.id);
            if (next?.signature !== signature) {
              dropCompiling(owner.id);
              next = { signature, layer: createBoardShaderLayer(renderer, shader, boardShaderParameters(output.parameters), owner.id, { wait: options.wait }) };
              compiling.set(owner.id, next);
            }
            if (next.layer.ready()) {
              compiling.delete(owner.id);
              drop(owner.id, host);
              entry = { owner, output, signature, layer: next.layer, surfaces: null, surfaceKey: "", surfaceScene: null, surfaceAt: -Infinity, surfaceSignature: "", outlines: [], placed: false };
              entries.set(owner.id, entry);
            }
          }
          if (!entry) continue;
          entry.owner = owner;
          if (entry.signature === signature) entry.output = output;
          const drawn = entry.output;
          const placement = host.attach(owner, entry.layer);
          entry.placed = placement !== null;
          if (!placement) continue;
          animated ||= drawn.animated || entry.layer.animated;
          entry.layer.update({
            time: owner.time,
            region: placement.region,
            view: placement.view,
            localToGlobal: placement.localToGlobal,
            zoom: host.zoom,
            density: host.density,
            seed: boardShaderSeed(owner.seed),
            quality: host.quality,
            shading: host.shading,
            dark: host.dark,
            params: parameterValues(drawn.parameters, owner.params, host.color),
            uniforms: drawn.uniforms,
            passes: drawn.passes,
          });
          if (entry.layer.surfaces) surfaceField(entry, renderer, owner, placement, host, scene, candidates);
        } catch (error) {
          host.attach(owner, null);
          drop(owner.id, host);
          dropCompiling(owner.id);
          failed.set(owner.id, signature);
          host.fault(owner.id, error instanceof Error ? error.message : String(error));
        }
      }
      for (const id of [...entries.keys()]) if (!alive.has(id)) drop(id, host);
      for (const id of [...compiling.keys()]) if (!alive.has(id)) dropCompiling(id);
      for (const id of [...failed.keys()]) if (!owners.some((owner) => owner.id === id)) failed.delete(id);
    },
    prepare(renderer: Renderer, catchUp = false) {
      pending = false;
      for (const entry of entries.values())
        if (entry.placed && entry.layer.prepare(renderer, { catchUp })) pending = true;
    },
    rewind() {
      for (const entry of entries.values()) entry.layer.rewind();
    },
    detach() {
      for (const entry of entries.values()) {
        entry.layer.below?.removeFromParent();
        entry.layer.above?.removeFromParent();
        entry.placed = false;
      }
    },
    destroy() {
      for (const id of [...entries.keys()]) drop(id);
      for (const id of [...compiling.keys()]) dropCompiling(id);
      failed.clear();
    },
  };
}

export type BoardShaderLayers = ReturnType<typeof createBoardShaderLayers>;
