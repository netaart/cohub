
import { arrowBindings, type BoardDocument, parseBoardDocument } from "@cohub/protocol";
import { type BoardViewport, effectBounds, itemBounds, type Rect, rectsIntersect, unionRects } from "./geometry.js";
import { arrowPathBounds, resolveSceneArrow } from "./arrow-geometry.js";
import type { BoardScene, BoardSceneItem } from "./scene.js";
import { boardDepthItemOutline, boardDepthOf, boardDepthRoots } from "./depth.js";
import type { BoardScriptView } from "./script.js";

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
  extras: BoardSceneItem[];
  clamped: boolean;
  page?: string;
};

export function normalizeBoardDocument(document: unknown): BoardDocument {
  const parsed = parseBoardDocument(document, { keepUnknown: true });
  if (!parsed.ok) throw new Error(`Invalid Board document: ${parsed.diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}`);
  return parsed.document;
}

export const BOARD_EXPORT_MAX_EDGE = 8192;
export const BOARD_EXPORT_MAX_PIXELS = 32_000_000;
export const BOARD_EXPORT_DEFAULT_SCALE = 2;
export const BOARD_EXPORT_DEFAULT_PADDING = 32;
export const BOARD_EXPORT_ITEM_WARN_THRESHOLD = 2000;

export function exportItemBounds(item: BoardSceneItem, scene: BoardScene): Rect | null {
  let bounds: Rect | null = effectBounds(item.type === "arrow"
    ? arrowPathBounds(resolveSceneArrow(item as Parameters<typeof resolveSceneArrow>[0], scene), item.style.strokeWidth)
    : itemBounds(item.frame), item.style);
  let cursor = item.parent;
  for (let depth = 0; cursor && bounds && depth < 64; depth += 1) {
    const parent = scene.get(cursor);
    if (parent?.type !== "frame") break;
    if ((parent.props as { clip?: boolean }).clip !== false) bounds = intersectRects(bounds, itemBounds(parent.frame));
    if (bounds) bounds = effectBounds(bounds, parent.style);
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
): { items: BoardSceneItem[]; rect: Rect | null; padding: number | null; page?: string } {
  const boundsOf = new Map<string, Rect | null>();
  const bounds = (item: BoardSceneItem) => {
    if (!boundsOf.has(item.id)) boundsOf.set(item.id, exportItemBounds(item, scene));
    return boundsOf.get(item.id) ?? null;
  };
  const visible = (item: BoardSceneItem, rect: Rect) => {
    if (item.type === "effect" && item.props.kind === "trail" && item.props.follow) return true;
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
      const items = scene.items.filter((item) => item.id === region.id || visible(item, rect));
      return { items, rect, padding: 0, page: region.id };
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
  const around = (rect: Rect): Rect => ({
    x: rect.x - padding,
    y: rect.y - padding,
    width: Math.max(1, rect.width + padding * 2),
    height: Math.max(1, rect.height + padding * 2),
  });
  let world = around(resolved.rect);
  const safeRequest = Number.isFinite(requestedScale) && requestedScale > 0 ? requestedScale : BOARD_EXPORT_DEFAULT_SCALE;
  let scale = clampScale(safeRequest, world, maxEdge, maxPixels);
  if (region.kind === "all" || region.kind === "items") {
    const planned = new Set(resolved.items.map((item) => item.id));
    const lifted = boardDepthRoots(input.scene).filter((item) => planned.has(item.id));
    let rect = resolved.rect;
    for (let pass = 0; lifted.length && pass < 8; pass++) {
      const view = { x: -world.x * scale, y: -world.y * scale, zoom: scale, width: world.width * scale, height: world.height * scale };
      const seen = lifted.flatMap((item) => boardDepthItemOutline(input.scene, item.id, view) ?? []);
      const xs = seen.map((point) => point.x);
      const ys = seen.map((point) => point.y);
      const next = unionRects([rect, { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }]);
      if (!next || (next.width - rect.width < 0.5 && next.height - rect.height < 0.5)) break;
      rect = next;
      world = around(rect);
      scale = clampScale(safeRequest, world, maxEdge, maxPixels);
    }
  }
  const items = region.kind === "rect" || region.kind === "frame" ? withLiftedInto(input.scene, resolved.items, world, scale) : resolved.items;
  return {
    world,
    scale,
    requestedScale,
    width: Math.max(1, Math.floor(world.width * scale)),
    height: Math.max(1, Math.floor(world.height * scale)),
    items,
    extras: boardDepthExtras(input.scene, items),
    clamped: scale < safeRequest - 1e-6,
    ...(resolved.page ? { page: resolved.page } : {}),
  };
}

export function boardExportView(plan: Pick<BoardExportPlan, "world" | "scale" | "width" | "height">, camera?: BoardViewport): BoardScriptView {
  const { world, scale, width, height } = plan;
  const { x, y, zoom, pitch, bearing } = camera ?? { x: -world.x * scale, y: -world.y * scale, zoom: scale };
  return { camera: { x, y, zoom, ...(pitch ? { pitch } : {}), ...(bearing ? { bearing } : {}) }, width, height, safeRect: { x: 0, y: 0, width, height } };
}

function withLiftedInto(scene: BoardScene, items: BoardSceneItem[], world: Rect, scale: number): BoardSceneItem[] {
  const planned = new Set(items.map((item) => item.id));
  const view = { x: -world.x * scale, y: -world.y * scale, zoom: scale, width: world.width * scale, height: world.height * scale };
  let added = false;
  for (const root of boardDepthRoots(scene)) {
    if (planned.has(root.id)) {
      for (const id of scene.descendants(root.id)) if (!planned.has(id)) {
        planned.add(id);
        added = true;
      }
      continue;
    }
    const seen = boardDepthItemOutline(scene, root.id, view);
    if (!seen?.length) continue;
    const xs = seen.map((point) => point.x);
    const ys = seen.map((point) => point.y);
    if (!rectsIntersect(world, { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) })) continue;
    for (const id of [root.id, ...scene.descendants(root.id)]) planned.add(id);
    added = true;
  }
  return added ? scene.items.filter((item) => planned.has(item.id)) : items;
}

function boardDepthExtras(scene: BoardScene, items: readonly BoardSceneItem[]): BoardSceneItem[] {
  const planned = new Set(items.map((item) => item.id));
  const wanted = new Set<string>();
  for (const root of boardDepthRoots(scene)) {
    const back = planned.has(root.id) ? boardDepthOf(root)?.back : undefined;
    if (!back || planned.has(back) || !scene.get(back)) continue;
    for (const id of [back, ...scene.descendants(back)]) if (!planned.has(id)) wanted.add(id);
  }
  return wanted.size ? scene.items.filter((item) => wanted.has(item.id)) : [];
}
