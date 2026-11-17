import { layoutBoardText, type BoardTextItem } from "@cohub/protocol";
import { DOMAdapter } from "pixi.js";
import type { BoardScene } from "../model/scene.js";
import { boardAutoplayKind } from "../model/autoplay.js";
import { effectBounds, itemBounds, rectsIntersect } from "../model/geometry.js";
import { boardFontFamily } from "../model/text-metrics.js";
import { boardDepthItemOutline, boardDepthOf, boardDepthPose, isBoardModelObject, boardDepthRootOf, boardDepthScreenPoint, boardDepthSurface, hitBoardDepthSurface } from "../model/depth.js";
import { boardProjection } from "../model/view-camera.js";
import { BOARD_FONT_STACKS, ensureBoardTextMeasurement } from "./text-measurement.js";

export type BoardRenderDiagnostic = {
  code: "text-clipped" | "text-overlap" | "glyph-unavailable" | "effect-follow-unused" | "autoplay-unused" | "attach-node-unknown";
  item: string;
  related?: string;
  characters?: string;
};
const glyphCache = new Map<string, boolean>();
let glyphContext: CanvasRenderingContext2D | undefined;

function missingGlyph(character: string, font: string): boolean {
  if (/\s/u.test(character)) return false;
  const key = `${font}:${character}`;
  const cached = glyphCache.get(key);
  if (cached !== undefined) return cached;
  try {
    glyphContext ??= DOMAdapter.get().createCanvas(64, 64).getContext("2d") as unknown as CanvasRenderingContext2D;
    const ctx = glyphContext;
    ctx.font = `32px ${font}`;
    const absent = "\u{10ffff}";
    if (ctx.measureText(character).width !== ctx.measureText(absent).width) {
      if (glyphCache.size >= 2048) glyphCache.clear();
      glyphCache.set(key, false);
      return false;
    }
    const pixels = (text: string) => {
      ctx.clearRect(0, 0, 64, 64);
      ctx.fillStyle = "#000000";
      ctx.fillText(text, 0, 40);
      return ctx.getImageData(0, 0, 64, 64).data;
    };
    const a = pixels(character);
    const b = pixels(absent);
    const missing = a.some((n) => n !== 0) && a.every((n, i) => n === b[i]);
    if (glyphCache.size >= 2048) glyphCache.clear();
    glyphCache.set(key, missing);
    return missing;
  } catch {
    return false;
  }
}

export function measureBoardText(props: BoardTextItem["props"]) {
  ensureBoardTextMeasurement();
  const font = boardFontFamily(props.font, BOARD_FONT_STACKS);
  const characters = [...new Set(props.text)]
    .slice(0, 512)
    .filter((char) => missingGlyph(char, font))
    .join("");
  return { ...layoutBoardText(props), missingCharacters: characters };
}

export const BOARD_INSPECT_VIEW = { width: 1600, height: 900 };

function inspectBoardDepth(scene: BoardScene, id: string, screen: { width: number; height: number }) {
  const root = boardDepthRootOf(scene, id);
  const rootItem = root ? scene.get(root) : undefined;
  const depth = rootItem && boardDepthOf(rootItem, scene);
  if (!root || !rootItem || !depth) return null;
  const center = itemBounds(rootItem.frame);
  const view = { x: screen.width / 2 - (center.x + center.width / 2), y: screen.height / 2 - (center.y + center.height / 2), zoom: 1, ...screen };
  const projection = boardProjection(view, screen);
  const surface = boardDepthSurface({ frame: rootItem.frame, origin: rootItem.origin, depth });
  const pose = boardDepthPose(surface, projection);
  const outline = boardDepthItemOutline(scene, id, view) ?? [];
  const xs = outline.map((point) => point.x);
  const ys = outline.map((point) => point.y);
  const facing = hitBoardDepthSurface(surface, pose, projection, boardDepthScreenPoint(surface, pose, projection, 0.5, 0.5))?.back ? "back" : "front";
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    root,
    facing,
    scale: round(projection.scale(pose.x, pose.y, pose.z) / projection.zoom),
    seenBounds: { x: round(Math.min(...xs)), y: round(Math.min(...ys)), width: round(Math.max(...xs) - Math.min(...xs)), height: round(Math.max(...ys) - Math.min(...ys)) },
  };
}

export function inspectBoardItems(scene: BoardScene, ids?: ReadonlySet<string>, options: { view?: { width: number; height: number } } = {}) {
  const view = options.view ?? BOARD_INSPECT_VIEW;
  return {
    diagnostics: inspectBoardScene(scene, 100, ids),
    items: scene.items
      .filter((item) => !ids || ids.has(item.id))
      .map((item) => {
        const depth = inspectBoardDepth(scene, item.id, view);
        return {
          id: item.id,
          bounds: item.frame,
          worldBounds: itemBounds(item.frame),
          ...(item.style.filter?.blur || item.style.shadow ? { visualBounds: effectBounds(itemBounds(item.frame), item.style) } : {}),
          opacity: scene.opacity(item.id),
          ...(depth ? { depth } : {}),
          ...(item.type === "text" ? { text: measureBoardText(item.props) } : {}),
        };
      }),
  };
}

export function inspectBoardScene(scene: BoardScene, limit = 100, ids?: ReadonlySet<string>): BoardRenderDiagnostic[] {
  ensureBoardTextMeasurement();
  const diagnostics: BoardRenderDiagnostic[] = [];
  const texts = scene.items.filter((item) => item.type === "text" && scene.opacity(item.id) > 0.01);
  const push = (entry: BoardRenderDiagnostic) => {
    if (diagnostics.length < limit && (!ids || ids.has(entry.item) || Boolean(entry.related && ids.has(entry.related)))) diagnostics.push(entry);
  };
  for (const item of scene.items) {
    if (diagnostics.length >= limit) break;
    if (item.type === "effect" && item.props.follow && item.props.kind !== "trail")
      push({ code: "effect-follow-unused", item: item.id });
    const unfinished = item.type === "task" && (item.props.snapshot.status === "pending" || item.props.snapshot.status === "running");
    if (item.autoplay && !unfinished && !boardAutoplayKind(item)) push({ code: "autoplay-unused", item: item.id });
    const node = item.attach?.node;
    const target = node ? scene.get(item.attach?.item as string) : undefined;
    const nodes = target?.type === "file" ? target.props.snapshot?.nodes : undefined;
    if (node && target && (!isBoardModelObject(target) || (nodes && !nodes.includes(node))))
      push({ code: "attach-node-unknown", item: item.id, related: target.id });
  }
  let glyphBudget = 256;
  for (const item of texts) {
    if (diagnostics.length >= limit || item.type !== "text") break;
    if ((!ids || ids.has(item.id)) && glyphBudget-- > 0) {
      const measured = measureBoardText(item.props);
      if (measured.missingCharacters)
        push({ code: "glyph-unavailable", item: item.id, characters: measured.missingCharacters });
    }
    const bounds = itemBounds(item.frame);
    let parentId = item.parent;
    while (parentId) {
      const parent = scene.get(parentId);
      if (!parent) break;
      if (parent.type === "frame" && parent.props.clip) {
        const clip = itemBounds(parent.frame);
        if (
          bounds.x < clip.x - 1 ||
          bounds.y < clip.y - 1 ||
          bounds.x + bounds.width > clip.x + clip.width + 1 ||
          bounds.y + bounds.height > clip.y + clip.height + 1
        ) {
          push({ code: "text-clipped", item: item.id, related: parentId });
          break;
        }
      }
      parentId = parent.parent;
    }
  }
  const sorted = texts.map((item) => ({ item, rect: itemBounds(item.frame) })).sort((a, b) => a.rect.x - b.rect.x);
  let comparisons = 0;
  for (let i = 0; i < sorted.length && diagnostics.length < limit; i++) {
    const a = sorted[i];
    if (!a) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if (!b) continue;
      if (b.rect.x >= a.rect.x + a.rect.width) break;
      if (ids && !ids.has(a.item.id) && !ids.has(b.item.id)) continue;
      if (++comparisons > 10000) return diagnostics;
      if (a.item.parent === b.item.parent && rectsIntersect(a.rect, b.rect))
        push({ code: "text-overlap", item: a.item.id, related: b.item.id });
      if (diagnostics.length >= limit) break;
    }
  }
  return diagnostics;
}
