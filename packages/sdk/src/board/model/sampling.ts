import { arrowBindings, BOARD_CAMERA_VIEWPORT, type BoardDocument, type BoardFrame, type BoardItem } from "@cohub/protocol";
import {
  applyBoardEvaluation,
  boardAnimationTime,
  compileBoardAnimations,
  evaluateBoardAnimations,
  type BoardCameraOverride,
  type BoardEvaluateOptions,
} from "./animation.js";
import { buildBoardScene } from "./scene.js";
import { cameraForFocus, cameraForState, type BoardViewport, type Size } from "./geometry.js";

export function createBoardAnimationSampler(
  document: BoardDocument,
  animation: string | null,
  options: BoardEvaluateOptions = {},
) {
  const selected = animation ? document.animations[animation] : undefined;
  if (animation && !selected) throw new Error(`Animation ${animation} does not exist.`);
  const compiled = compileBoardAnimations(document);
  const cache = new Map<number, ReturnType<typeof sample>>();
  const geometry = new Map<string, BoardFrame | undefined>();
  function sample(time: number) {
    const times = new Map<string, number>();
    for (const [id, entry] of compiled.animations) {
      if (entry.header.play === "always") times.set(id, boardAnimationTime(entry.header, time) ?? 0);
    }
    if (animation && selected) times.set(animation, Math.min(time, selected.duration));
    const evaluation = evaluateBoardAnimations(compiled, times, options);
    const sampled = applyBoardEvaluation(document, evaluation);
    return { document: sampled, evaluation };
  }
  function stateAt(time: number) {
    if (!Number.isFinite(time) || time < 0) throw new Error("Animation time must be finite and non-negative.");
    let value = cache.get(time);
    if (!value) {
      value = sample(time);
      const oldest = cache.keys().next().value;
      if (cache.size >= 64 && oldest !== undefined) cache.delete(oldest);
      cache.set(time, value);
    }
    return value;
  }
  type Sampled = ReturnType<typeof sample> & { readonly scene: ReturnType<typeof buildBoardScene> };
  let current: { time: number; value: Sampled } | undefined;
  return {
    frameAt(id: string, time: number): BoardFrame | undefined {
      const key = `${time}:${id}`;
      if (geometry.has(key)) return geometry.get(key);
      const sampled = stateAt(time).document;
      const items: Record<string, BoardItem> = {};
      const pending = [id];
      while (pending.length) {
        const next = pending.pop();
        if (!next || items[next]) continue;
        const item = sampled.items[next];
        if (!item) continue;
        items[next] = item;
        if (item.parent) pending.push(item.parent);
        pending.push(...arrowBindings(item));
      }
      const frame = buildBoardScene({ ...sampled, items }).get(id)?.frame;
      if (geometry.size >= 2048) geometry.clear();
      geometry.set(key, frame);
      return frame;
    },
    at(time: number) {
      if (current?.time === time) return current.value;
      const sampled = stateAt(time);
      let scene: ReturnType<typeof buildBoardScene> | undefined;
      const value: Sampled = {
        ...sampled,
        get scene() {
          scene ??= buildBoardScene(sampled.document);
          return scene;
        },
      };
      current = { time, value };
      return value;
    },
  };
}
export type BoardAnimationSampler = ReturnType<typeof createBoardAnimationSampler>;

export function boardCameraScale(surface: Size, viewport: Size = BOARD_CAMERA_VIEWPORT): number {
  return Math.min(surface.width / viewport.width, surface.height / viewport.height);
}

export function resolveBoardAnimationCamera(
  override: BoardCameraOverride,
  bounds: (id: string) => BoardFrame | undefined,
  surface: Size,
  time: number,
  base: BoardViewport = { x: 0, y: 0, zoom: 1 },
  viewport: Size = BOARD_CAMERA_VIEWPORT,
): BoardViewport {
  const scale = boardCameraScale(surface, viewport);
  if (!(scale > 0) || Object.keys(override).length === 0) return base;
  const left = (surface.width - viewport.width * scale) / 2;
  const top = (surface.height - viewport.height * scale) / 2;
  const framed = { x: (base.x - left) / scale, y: (base.y - top) / scale, zoom: base.zoom / scale };
  let camera =
    override.focus === undefined ? framed : (cameraForFocus(override.focus, bounds, viewport, { padding: 48 }) ?? framed);
  if (override.zoom !== undefined) camera = { ...camera, zoom: override.zoom };
  if (override.center)
    camera = cameraForState({ centerX: override.center.x, centerY: override.center.y, zoom: camera.zoom }, viewport);
  if (override.shake)
    camera = {
      ...camera,
      x: camera.x + Math.sin((time / 1000) * 91.3) * override.shake,
      y: camera.y + Math.cos((time / 1000) * 77.9) * override.shake,
    };
  return { x: camera.x * scale + left, y: camera.y * scale + top, zoom: camera.zoom * scale };
}
