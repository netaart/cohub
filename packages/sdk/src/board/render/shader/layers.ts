import { applyMatrix, type BoardMatrix, framePoint, invertMatrix } from "@cohub/protocol/board-layout";
import type { Renderer } from "pixi.js";
import { itemBounds, type Rect, rectsIntersect } from "../../model/geometry.js";
import type { BoardScene, BoardSceneItem } from "../../model/scene.js";
import type { BoardScriptOutput, BoardScriptParameter } from "../../model/script.js";
import type { BoardDocument } from "@cohub/protocol";
import { isBoardRootScript } from "../../model/script-index.js";
import { boardScriptOf, scriptTemporaryPrefix } from "../../model/script-scene.js";
import { boardShaderParameters, boardShaderSignature } from "../../model/shader.js";
import type { BoardColor } from "@cohub/protocol";
import { itemAlpha, itemColor } from "../palette.js";
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
  zoom: number;
  density: number;
  quality: number;
  dark: boolean;
  color(value: unknown): [number, number, number, number];
};

export function boardShaderColor(context: Pick<BoardRenderContext, "colors" | "colorScheme" | "palette">, value: unknown): [number, number, number, number] {
  const color = itemColor(context, value as BoardColor | undefined, "brand", "fill");
  return [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255, itemAlpha(context, value as BoardColor | undefined)];
}

const SKIPPED = new Set(["frame", "arrow", "draw", "effect"]);
const SURFACE_EDGE = 512;

export function boardSurfaceOutlines(scene: BoardScene, owner: string, world: Rect, worldToLocal: BoardMatrix, candidates?: Iterable<string>): number[][] {
  const prefix = scriptTemporaryPrefix(owner);
  const outlines: number[][] = [];
  const items: Iterable<BoardSceneItem> = candidates
    ? [...candidates].map((id) => scene.get(id)).filter((item): item is BoardSceneItem => Boolean(item))
    : scene.items;
  for (const item of items) {
    if (item.id === owner || SKIPPED.has(item.type) || item.id.startsWith(prefix) || scene.opacity(item.id) <= 0) continue;
    if (!rectsIntersect(itemBounds(item.frame), world)) continue;
    const ellipse = item.type === "shape" && (item.props as { geometry?: string }).geometry === "ellipse";
    const points: number[] = [];
    const corners = ellipse
      ? Array.from({ length: 24 }, (_, index) => {
          const angle = (index / 24) * Math.PI * 2;
          return [0.5 + Math.cos(angle) / 2, 0.5 + Math.sin(angle) / 2] as const;
        })
      : ([[0, 0], [1, 0], [1, 1], [0, 1]] as const);
    for (const [u, v] of corners) {
      const local = applyMatrix(worldToLocal, framePoint(item.frame, u, v));
      points.push(local.x, local.y);
    }
    outlines.push(points);
  }
  return outlines;
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
  outlines: number[][];
  placed: boolean;
};

function sameOutlines(a: readonly (readonly number[])[], b: readonly (readonly number[])[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    const left = a[index] as readonly number[];
    const right = b[index] as readonly number[];
    if (left.length !== right.length) return false;
    for (let point = 0; point < left.length; point++) if (Math.abs((left[point] as number) - (right[point] as number)) > 1e-3) return false;
  }
  return true;
}

export function createBoardShaderLayers(options: { onError(id: string, message: string): void }) {
  const entries = new Map<string, Entry>();
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

  return {
    get animated() {
      return animated || pending;
    },
    get size() {
      return entries.size;
    },
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
        if (entry && entry.signature !== signature) {
          drop(owner.id, host);
          entry = undefined;
        }
        try {
          if (!entry) {
            const layer = createBoardShaderLayer(renderer, shader, boardShaderParameters(output.parameters), owner.id);
            entry = { owner, output, signature, layer, surfaces: null, surfaceKey: "", surfaceScene: null, outlines: [], placed: false };
            entries.set(owner.id, entry);
          }
          entry.owner = owner;
          entry.output = output;
          const placement = host.attach(owner, entry.layer);
          entry.placed = placement !== null;
          if (!placement) continue;
          animated ||= output.animated || entry.layer.animated;
          entry.layer.update({
            time: owner.time,
            region: placement.region,
            view: placement.view,
            localToGlobal: placement.localToGlobal,
            zoom: host.zoom,
            density: host.density,
            seed: boardShaderSeed(owner.seed),
            quality: host.quality,
            dark: host.dark,
            params: parameterValues(output.parameters, owner.params, host.color),
            uniforms: output.uniforms,
          });
          if (entry.layer.surfaces) {
            const { region, localToWorld } = placement;
            const corners = [applyMatrix(localToWorld, region), applyMatrix(localToWorld, { x: region.x + region.width, y: region.y + region.height }),
              applyMatrix(localToWorld, { x: region.x + region.width, y: region.y }), applyMatrix(localToWorld, { x: region.x, y: region.y + region.height })];
            const xs = corners.map((point) => point.x);
            const ys = corners.map((point) => point.y);
            const world = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
            const edge = Math.max(64, Math.round(SURFACE_EDGE * host.quality));
            const key = `${[region.x, region.y, region.width, region.height, ...localToWorld].map((n) => n.toFixed(3)).join(",")}|${edge}`;
            entry.surfaces ??= createBoardSurfaceField();
            if (key !== entry.surfaceKey || entry.surfaceScene !== scene) {
              entry.surfaceScene = scene;
              const outlines = boardSurfaceOutlines(scene, owner.id, world, invertMatrix(localToWorld), candidates?.(world));
              if (key !== entry.surfaceKey || !sameOutlines(outlines, entry.outlines)) entry.surfaces.build(renderer, region, outlines, edge);
              entry.surfaceKey = key;
              entry.outlines = outlines;
            }
            entry.layer.setSurfaces(entry.surfaces.texture, entry.surfaces.region);
          }
        } catch (error) {
          host.attach(owner, null);
          drop(owner.id, host);
          failed.set(owner.id, signature);
          options.onError(owner.id, error instanceof Error ? error.message : String(error));
        }
      }
      for (const id of [...entries.keys()]) if (!alive.has(id)) drop(id, host);
      for (const id of [...failed.keys()]) if (!owners.some((owner) => owner.id === id)) failed.delete(id);
    },
    prepare(renderer: Renderer, catchUp = false) {
      pending = false;
      for (const entry of entries.values())
        if (entry.placed && entry.layer.prepare(renderer, { catchUp })) pending = true;
    },
    destroy() {
      for (const id of [...entries.keys()]) drop(id);
      failed.clear();
    },
  };
}

export type BoardShaderLayers = ReturnType<typeof createBoardShaderLayers>;
