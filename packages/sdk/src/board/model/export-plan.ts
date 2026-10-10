
import { arrowBindings, type BoardDocument, parseBoardDocument } from "@cohub/protocol";
import { itemBounds, type Rect, rectsIntersect, unionRects } from "./geometry.js";
import { arrowPathBounds, resolveSceneArrow } from "./arrow-geometry.js";
import type { BoardScene, BoardSceneItem } from "./scene.js";

export type BoardExportRegion =
  | { kind: "all" }
  | { kind: "items"; ids: string[] }
  | { kind: "frame"; id: string }
  | { kind: "rect"; rect: Rect };

export type BoardExportPlanInput = {
  scene: BoardScene;
  region: BoardExportRegion;
  scale?: number;
  padding?: number;
  maxEdge?: number;
  maxPixels?: number;
};

export type BoardExportPlan = {
  world: Rect;
  scale: number;
  requestedScale: number;
  width: number;
  height: number;
  items: BoardSceneItem[];
  clamped: boolean;
};

export function normalizeBoardDocument(document: unknown): BoardDocument {
  const parsed = parseBoardDocument(document);
  if (!parsed.ok) throw new Error(`Invalid Board document: ${parsed.diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`);
  return parsed.document;
}

export const BOARD_EXPORT_MAX_EDGE = 8192;
export const BOARD_EXPORT_MAX_PIXELS = 32_000_000;
export const BOARD_EXPORT_DEFAULT_SCALE = 2;
export const BOARD_EXPORT_DEFAULT_PADDING = 32;
export const BOARD_EXPORT_ITEM_WARN_THRESHOLD = 2000;

export function exportItemBounds(item: BoardSceneItem, scene: BoardScene): Rect | null {
  let bounds: Rect | null = item.type === "arrow"
    ? arrowPathBounds(resolveSceneArrow(item as Parameters<typeof resolveSceneArrow>[0], scene), item.style.strokeWidth)
    : itemBounds(item.frame);
  let cursor = item.parent;
  for (let depth = 0; cursor && bounds && depth < 64; depth += 1) {
    const parent = scene.get(cursor);
    if (!parent) break;
    if (parent.type === "frame" && (parent.props as { clip?: boolean }).clip !== false) bounds = intersectRects(bounds, itemBounds(parent.frame));
    cursor = parent.parent;
  }
  return bounds;
}

function intersectRects(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function resolveRegion(
  scene: BoardScene,
  region: BoardExportRegion,
): { items: BoardSceneItem[]; rect: Rect | null; padding: number | null } {
  const boundsOf = new Map<string, Rect | null>();
  const bounds = (item: BoardSceneItem) => {
    if (!boundsOf.has(item.id)) boundsOf.set(item.id, exportItemBounds(item, scene));
    return boundsOf.get(item.id) ?? null;
  };
  const visible = (item: BoardSceneItem, rect: Rect) => {
    const box = bounds(item);
    return box !== null && rectsIntersect(box, rect);
  };
  const union = (items: readonly BoardSceneItem[]) => unionRects(items.flatMap((item) => bounds(item) ?? []));
  switch (region.kind) {
    case "all":
      return { items: [...scene.items], rect: union(scene.items), padding: null };
    case "items": {
      const wanted = new Set(region.ids.flatMap((id) => (scene.get(id) ? [id, ...scene.descendants(id)] : [])));
      for (const id of [...wanted]) {
        for (const arrowId of scene.binders(id)) {
          const arrow = scene.get(arrowId);
          if (arrow && arrowBindings(arrow).every((bound) => wanted.has(bound))) wanted.add(arrowId);
        }
      }
      const items = scene.items.filter((item) => wanted.has(item.id));
      return { items, rect: union(items), padding: null };
    }
    case "frame": {
      const frame = scene.get(region.id);
      if (!frame) return { items: [], rect: null, padding: null };
      const rect = itemBounds(frame.frame);
      const items = scene.items.filter((item) => item.id !== region.id && visible(item, rect));
      return { items, rect, padding: 0 };
    }
    case "rect": {
      const rect = region.rect;
      return { items: scene.items.filter((item) => visible(item, rect)), rect, padding: 0 };
    }
  }
}

function clampScale(
  requested: number,
  world: Rect,
  maxEdge: number,
  maxPixels: number,
): number {
  const byEdge = Math.min(maxEdge / world.width, maxEdge / world.height);
  const byArea = Math.sqrt(maxPixels / (world.width * world.height));
  return Math.min(requested, byEdge, byArea);
}

export function planBoardExport(input: BoardExportPlanInput): BoardExportPlan | null {
  const {
    region,
    scale: requestedScale = BOARD_EXPORT_DEFAULT_SCALE,
    maxEdge = BOARD_EXPORT_MAX_EDGE,
    maxPixels = BOARD_EXPORT_MAX_PIXELS,
  } = input;
  const resolved = resolveRegion(input.scene, region);
  if (!resolved.rect) return null;

  const padding = input.padding ?? resolved.padding ?? BOARD_EXPORT_DEFAULT_PADDING;
  const world: Rect = {
    x: resolved.rect.x - padding,
    y: resolved.rect.y - padding,
    width: Math.max(1, resolved.rect.width + padding * 2),
    height: Math.max(1, resolved.rect.height + padding * 2),
  };

  const safeRequest = Number.isFinite(requestedScale) && requestedScale > 0 ? requestedScale : BOARD_EXPORT_DEFAULT_SCALE;
  const scale = clampScale(safeRequest, world, maxEdge, maxPixels);
  return {
    world,
    scale,
    requestedScale,
    width: Math.max(1, Math.floor(world.width * scale)),
    height: Math.max(1, Math.floor(world.height * scale)),
    items: resolved.items,
    clamped: scale < safeRequest - 1e-6,
  };
}
