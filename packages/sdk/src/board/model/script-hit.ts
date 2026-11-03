import { applyMatrix, invertMatrix } from "@cohub/protocol/board-layout";
import { frameContainsPoint, type WorldPoint, type BoardViewport } from "./geometry.js";
import type { BoardScene, BoardSceneItem } from "./scene.js";
import type { BoardScriptHit, BoardScriptOutput } from "./script.js";
import { scriptTemporaryPrefix } from "./script-scene.js";

export function resolveBoardScriptHit(scene: BoardScene, owner: string, hit: BoardScriptHit) {
  const id = "item" in hit ? `${scriptTemporaryPrefix(owner)}${hit.item}` : owner;
  const item = scene.get(id);
  if (!item || scene.opacity(id) <= 0) return null;
  const box = scene.layout.box(id);
  return { id, item, rect: "x" in hit ? hit : { x: 0, y: 0, width: box.width, height: box.height } };
}

export function boardScriptHitVisible(
  scene: BoardScene,
  hit: NonNullable<ReturnType<typeof resolveBoardScriptHit>>,
  camera: BoardViewport,
  surface: { width: number; height: number },
): boolean {
  const { x, y, width, height } = hit.rect;
  if (width <= 0 || height <= 0) return false;
  const matrix = scene.layout.matrix(hit.id);
  const corners = [
    applyMatrix(matrix, { x, y }),
    applyMatrix(matrix, { x: x + width, y }),
    applyMatrix(matrix, { x, y: y + height }),
    applyMatrix(matrix, { x: x + width, y: y + height }),
  ];
  const xs = corners.map((point) => point.x * camera.zoom + camera.x);
  const ys = corners.map((point) => point.y * camera.zoom + camera.y);
  return Math.max(...xs) > 0 && Math.min(...xs) < surface.width &&
    Math.max(...ys) > 0 && Math.min(...ys) < surface.height;
}

type Binding = { owner: string; target: string; hit: BoardScriptHit };
const bindings = new WeakMap<BoardScriptOutput, { owner: string; byItem: Map<string, Binding[]> }>();
function bindingsFor(owner: string, output: BoardScriptOutput) {
  const cached = bindings.get(output);
  if (cached?.owner === owner) return cached.byItem;
  const byItem = new Map<string, Binding[]>();
  for (const [target, hit] of Object.entries(output.hits)) {
    const id = "item" in hit ? `${scriptTemporaryPrefix(owner)}${hit.item}` : owner;
    const list = byItem.get(id) ?? [];
    list.push({ owner, target, hit });
    byItem.set(id, list);
  }
  bindings.set(output, { owner, byItem });
  return byItem;
}

export function boardScriptTarget(
  scene: BoardScene,
  candidates: readonly string[],
  point: WorldPoint,
  outputs: ReadonlyMap<string, BoardScriptOutput>,
  hitTest: (item: BoardSceneItem, point: WorldPoint) => boolean,
): { owner: string; target: string } | null {
  const declared = [...outputs].map(([owner, output]) => bindingsFor(owner, output));
  const prefixes = [...outputs.keys()].map(scriptTemporaryPrefix);
  const ordered = [...candidates].sort((a, b) => scene.indexOf(b) - scene.indexOf(a));
  const scan = (over: boolean) => {
    for (const id of ordered) {
      const item = scene.get(id);
      if (!item || scene.opacity(id) <= 0) continue;
      let parent = item.parent;
      let clipped = false;
      for (let depth = 0; parent && depth < 64; depth++) {
        const ancestor = scene.get(parent);
        if (!ancestor) break;
        if (ancestor.type === "frame" && ancestor.props.clip && !frameContainsPoint(ancestor.frame, point)) {
          clipped = true;
          break;
        }
        parent = ancestor.parent;
      }
      if (clipped) continue;
      for (const byItem of declared) {
        const hits = byItem.get(id);
        if (!hits) continue;
        const local = applyMatrix(invertMatrix(scene.layout.matrix(id)), point);
        for (let i = hits.length - 1; i >= 0; i--) {
          const binding = hits[i];
          if (!binding || (over && !binding.hit.over)) continue;
          const resolved = resolveBoardScriptHit(scene, binding.owner, binding.hit);
          if (!resolved) continue;
          const r = resolved.rect;
          if (local.x >= r.x && local.y >= r.y && local.x <= r.x + r.width && local.y <= r.y + r.height &&
              ("x" in binding.hit || hitTest(item, point)))
            return { owner: binding.owner, target: binding.target };
        }
      }
      if (over || prefixes.some((prefix) => id.startsWith(prefix))) continue;
      if (item.type === "frame" && item.props.decoration === "none") continue;
      if (hitTest(item, point)) return null;
    }
    return null;
  };
  const anyOver = [...outputs.values()].some((output) => Object.values(output.hits).some((hit) => hit.over));
  return (anyOver ? scan(true) : null) ?? scan(false);
}
