import {
  applyBoardPatchToDocument,
  mergePatch,
} from "@cohub/protocol/board-patch";
import {
  parseBoardItem as parseItem,
  type BoardDocument,
  type BoardItem,
  type BoardPatch,
} from "@cohub/protocol/board-model";
import type { BoardScriptOutput } from "./script.js";
import { applyMatrix, createBoardLayout } from "@cohub/protocol/board-layout";
import type { BoardScene } from "./scene.js";
import { boardScriptAttachments, isBoardRootScript } from "./script-index.js";
import { boardScriptScope } from "./script-scope.js";
import { validateBoardShader } from "./shader.js";

export { boardScriptOf, boardScriptScope, diffBoardScriptItems } from "./script-scope.js";

function parseBoardItem(value: unknown): BoardItem {
  const parsed = parseItem(value);
  if (!parsed.ok)
    throw new Error(parsed.diagnostics[0]?.message ?? "Invalid script item.");
  return parsed.item;
}

const DISPLAY_FIELDS = new Set([
  "position",
  "size",
  "rotation",
  "scale",
  "opacity",
  "style",
  "props",
  "z",
]);
const CURSORS = new Set(["default", "pointer", "grab", "grabbing", "crosshair", "text", "move", "ew-resize", "ns-resize", "not-allowed"]);
const TOOLS = new Set(["select", "hand", "text", "shape", "draw", "arrow", "frame"]);
const SCREEN_Z = 1e9;
const ROOT_WORLD_Z = 1e8;

export function validateBoardScriptOutput(output: BoardScriptOutput): void {
  if (
    !output ||
    typeof output !== "object" ||
    !output.patches ||
    !output.world ||
    !output.screen ||
    !output.hits ||
    !Array.isArray(output.listens)
  )
    throw new Error("Invalid script output.");
  if (output.anchor) {
    const { item, point } = output.anchor;
    if (typeof item !== "string" || !item ||
        (point && ![point.x, point.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)))
      throw new Error("Invalid screen scene anchor.");
  }
  if (output.shader !== undefined) validateBoardShader(output.shader);
  if (output.frameRate !== undefined && !(Number.isFinite(output.frameRate) && output.frameRate >= 1 && output.frameRate <= 60))
    throw new Error("frameRate must be a number from 1 to 60.");
  if (output.parameters) {
    if (Object.keys(output.parameters).length > 64)
      throw new Error("A script may declare at most 64 parameters.");
    for (const spec of Object.values(output.parameters)) {
      if (
        !spec ||
        !["number", "boolean", "string", "color"].includes(spec.type)
      )
        throw new Error("Invalid script parameter type.");
      if (spec.label !== undefined && typeof spec.label !== "string")
        throw new Error("Invalid script parameter label.");
      if (
        [spec.min, spec.max, spec.step].some(
          (value) => value !== undefined && !Number.isFinite(value),
        )
      )
        throw new Error("Invalid script parameter range.");
    }
  }
  if (Object.keys(output.world).some((id) => Object.hasOwn(output.screen, id)))
    throw new Error("Temporary item IDs must be unique across scenes.");
  if (
    Object.keys(output.world).length + Object.keys(output.screen).length > 1000 ||
    Object.keys(output.hits).length > 1000
  )
    throw new Error(
      "A script may create at most 1000 temporary items or hit regions.",
    );
  for (const patch of Object.values(output.patches)) {
    if (
      !patch ||
      typeof patch !== "object" ||
      Object.keys(patch).some((key) => !DISPLAY_FIELDS.has(key))
    )
      throw new Error(`Scripts may only present ${[...DISPLAY_FIELDS].join(", ")}.`);
  }
  for (const hit of Object.values(output.hits)) {
    if (!hit || typeof hit !== "object") throw new Error("Invalid script hit region.");
    if (hit.cursor && !CURSORS.has(hit.cursor))
      throw new Error("Invalid script cursor.");
    if (hit.tools !== undefined && (!Array.isArray(hit.tools) || hit.tools.some((tool) => !TOOLS.has(tool))))
      throw new Error("Invalid script hit tools.");
    if ("target" in hit) {
      if (hit.target !== "self" || "item" in hit || "x" in hit) throw new Error("Invalid script hit target.");
    } else if ("item" in hit) {
      if (typeof hit.item !== "string" || !(Object.hasOwn(output.world, hit.item) || Object.hasOwn(output.screen, hit.item)) || "x" in hit)
        throw new Error("Hit items must belong to the temporary scene.");
    } else if (
      ![hit.x, hit.y, hit.width, hit.height].every(Number.isFinite) ||
      hit.width < 0 || hit.height < 0
    ) throw new Error("Invalid script hit region.");
  }
}

function scopedModules(document: BoardDocument, owner: string, scope: ReadonlySet<string>): Set<string> {
  const modules = new Set<string>();
  if (isBoardRootScript(document, owner))
    for (const { script } of boardScriptAttachments(document)) modules.add(script.src);
  for (const id of scope) {
    const script = document.items[id]?.script;
    if (script?.enabled) modules.add(script.src);
  }
  return modules;
}

export function validateBoardScriptCommit(
  document: BoardDocument,
  id: string,
  patch: BoardPatch,
): BoardDocument {
  if (
    !patch ||
    typeof patch !== "object" ||
    Object.keys(patch).some((key) => key !== "items")
  )
    throw new Error("Scripts may only commit items in their scope.");
  const scope = boardScriptScope(document, id);
  const root = isBoardRootScript(document, id);
  const items = patch.items ?? {};
  const created = new Set(Object.keys(items).filter((target) => !scope.has(target) && !document.items[target]));
  const reachable = (target: string) => scope.has(target) || created.has(target);
  const scripted: string[] = [];
  for (const [target, value] of Object.entries(items)) {
    const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
    if (!scope.has(target)) {
      if (document.items[target])
        throw new Error(`Item is outside the script scope: ${target}`);
      if (!record || !("type" in record))
        throw new Error(`Item no longer exists: ${target}`);
      if (root && record.parent === undefined) {
        if (record.script) scripted.push(target);
        continue;
      }
      if (
        typeof record.parent !== "string" ||
        !reachable(record.parent) ||
        (scope.has(record.parent) ? document.items[record.parent]?.type : (items[record.parent] as { type?: unknown } | null)?.type) !== "frame"
      )
        throw new Error(
          "New items must belong to a frame in the script scope.",
        );
    } else if (record && ("parent" in record || "type" in record))
      throw new Error("A script cannot change item types or parent relationships.");
    if (record?.script) scripted.push(target);
  }
  const result = applyBoardPatchToDocument(document, patch);
  if (!result.ok)
    throw new Error(result.diagnostics[0]?.message ?? "Invalid script commit.");
  if (!scripted.length) return result.document;
  const modules = scopedModules(document, id, scope);
  for (const target of scripted) {
    const script = result.document.items[target]?.script;
    if (script?.enabled && !modules.has(script.src))
      throw new Error("Scripts may only attach modules already running in their scope.");
    if (root) continue;
    for (const reached of boardScriptScope(result.document, target))
      if (!reachable(reached)) throw new Error("A script cannot start a script that reaches beyond its scope.");
  }
  return result.document;
}

export function scriptTemporaryPrefix(owner: string): string {
  let hash = 2166136261;
  for (const char of owner)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return `~script-${hash.toString(36)}-`;
}

type Layer = { root: string; items: Map<string, BoardItem> };
type PreparedOutput = {
  document: BoardDocument;
  owner: string;
  world: Layer;
  screen: Layer;
  presented: Map<string, { base: BoardItem; item: BoardItem }>;
};
const preparedOutputs = new WeakMap<BoardScriptOutput, PreparedOutput>();
const preparedScopes = new WeakMap<BoardDocument, Map<string, ReadonlySet<string>>>();
function orderedScriptOwners(document: BoardDocument, outputs: ReadonlyMap<string, BoardScriptOutput>): string[] {
  return boardScriptAttachments(document).map(({ id }) => id).filter((id) => outputs.has(id));
}

function scopeOf(document: BoardDocument, owner: string): ReadonlySet<string> {
  let scopes = preparedScopes.get(document);
  if (!scopes) {
    scopes = new Map();
    preparedScopes.set(document, scopes);
  }
  let scope = scopes.get(owner);
  if (!scope) {
    scope = boardScriptScope(document, owner);
    scopes.set(owner, scope);
  }
  return scope;
}

function prepareLayer(
  document: BoardDocument,
  scope: ReadonlySet<string>,
  prefix: string,
  root: string,
  values: Record<string, unknown>,
): Layer {
  const items = new Map<string, BoardItem>();
  const parsed = new Map(Object.entries(values).map(([id, value]) => [id, parseBoardItem(value)]));
  let order = 0;
  for (const [local, value] of parsed) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(local))
      throw new Error("Temporary IDs must be 1–80 letters, digits, underscores or hyphens.");
    if (value.script) throw new Error("Temporary items cannot start scripts.");
    if (value.parent && !parsed.has(value.parent))
      throw new Error("Temporary parents must belong to the same scene.");
    let cursor = value.parent;
    const visited = new Set([local]);
    while (cursor) {
      if (visited.has(cursor))
        throw new Error("Temporary parents must not form a cycle.");
      visited.add(cursor);
      const parentItem = parsed.get(cursor);
      if (!parentItem) throw new Error("Temporary parent is missing.");
      if (parentItem.type !== "frame")
        throw new Error("Only frames can contain temporary items.");
      cursor = parentItem.parent;
    }
    const id = `${prefix}${local}`;
    if (document.items[id])
      throw new Error("Temporary item ID conflicts with the document.");
    const placed = {
      ...value,
      parent: value.parent ? `${prefix}${value.parent}` : root,
      z: value.z ?? order++,
    } as BoardItem;
    if (placed.type === "arrow") {
      const remap = (endpoint: typeof placed.props.start) =>
        "item" in endpoint && parsed.has(endpoint.item) ? { ...endpoint, item: `${prefix}${endpoint.item}` } : endpoint;
      const ends = [placed.props.start, placed.props.end];
      if (ends.some((end) => "item" in end && !parsed.has(end.item) && !scope.has(end.item))) continue;
      placed.props = { ...placed.props, start: remap(placed.props.start), end: remap(placed.props.end) };
    }
    items.set(id, placed);
  }
  return { root, items };
}

export function prepareBoardScriptOutput(
  document: BoardDocument,
  owner: string,
  output: BoardScriptOutput,
): PreparedOutput {
  const previous = preparedOutputs.get(output);
  if (previous?.document === document && previous.owner === owner)
    return previous;
  const scope = scopeOf(document, owner);
  validateBoardScriptOutput(output);
  if (isBoardRootScript(document, owner) && Object.values(output.hits).some((hit) => !("item" in hit)))
    throw new Error("A Board script takes input only on its scene items.");
  const presented = new Map<string, { base: BoardItem; item: BoardItem }>();
  for (const [id, patch] of Object.entries(output.patches)) {
    const base = document.items[id];
    if (base && scope.has(id))
      presented.set(id, { base, item: parseBoardItem(mergePatch(base, patch)) });
  }
  const prefix = scriptTemporaryPrefix(owner);
  const prepared = {
    document,
    owner,
    world: prepareLayer(document, scope, prefix, `${prefix}~world`, output.world),
    screen: prepareLayer(document, scope, prefix, `${prefix}~screen`, output.screen),
    presented,
  };
  preparedOutputs.set(output, prepared);
  return prepared;
}

export function composeBoardScriptItems(
  document: BoardDocument,
  scene: BoardScene,
  outputs: ReadonlyMap<string, BoardScriptOutput>,
  incoming: ReadonlyMap<string, BoardItem> = new Map(),
  screen?: { zoom: number; x?: number; y?: number },
  onError?: (owner: string, error: unknown) => void,
  gestureLayout?: BoardScene["layout"],
): Map<string, BoardItem> {
  const result = new Map(incoming);
  const screenRoots = new Map<string, string>();
  if (outputs.size === 0) return result;
  const owners = orderedScriptOwners(document, outputs);
  for (const [rank, owner] of owners.entries()) {
    const output = outputs.get(owner);
    if (!output) continue;
    try {
      const changes = new Map<string, BoardItem>();
      const prepared = prepareBoardScriptOutput(document, owner, output);
      for (const [id, cached] of prepared.presented) {
        const base = result.get(id) ?? document.items[id];
        if (!base) continue;
        let current = cached;
        if (current.base !== base) {
          current = { base, item: parseBoardItem(mergePatch(base, output.patches[id])) };
          prepared.presented.set(id, current);
        }
        changes.set(id, current.item);
      }
      const root = isBoardRootScript(document, owner);
      const owned = changes.get(owner) ?? result.get(owner) ?? document.items[owner];
      if (root && prepared.world.items.size) {
        changes.set(prepared.world.root, parseBoardItem({
          type: "frame",
          size: { width: 1, height: 1 },
          z: ROOT_WORLD_Z + rank,
          props: { decoration: "none", clip: false },
        }));
        for (const [id, item] of prepared.world.items) changes.set(id, item);
      } else if (owned && prepared.world.items.size) {
        const box = scene.layout.box(owner);
        changes.set(prepared.world.root, parseBoardItem({
          type: "frame",
          parent: owned.parent,
          position: owned.position,
          rotation: owned.rotation,
          scale: owned.scale,
          origin: owned.origin,
          opacity: owned.opacity,
          size: { width: Math.max(1, box.width), height: Math.max(1, box.height) },
          z: (owned.z ?? 0) + 0.001,
          props: { decoration: "none", clip: false },
        }));
        for (const [id, item] of prepared.world.items) changes.set(id, item);
      }
      if (screen && prepared.screen.items.size) {
        changes.set(prepared.screen.root, parseBoardItem({
          type: "frame",
          position: { x: 0, y: 0 },
          scale: 1 / screen.zoom,
          origin: { x: 0, y: 0 },
          size: { width: 1, height: 1 },
          z: SCREEN_Z + rank,
          props: { decoration: "none", clip: false },
        }));
        for (const [id, item] of prepared.screen.items) changes.set(id, item);
        screenRoots.set(owner, prepared.screen.root);
      }
      for (const [id, item] of changes) result.set(id, item);
    } catch (error) {
      if (!onError) throw error;
      onError(owner, error);
    }
  }
  if (screenRoots.size) {
    const layout = gestureLayout ?? createBoardLayout(
      (id) => result.get(id) ?? document.items[id],
    );
    for (const [owner, rootId] of screenRoots) {
      const root = result.get(rootId);
      const anchor = outputs.get(owner)?.anchor;
      if (!anchor && isBoardRootScript(document, owner)) {
        if (root) result.set(rootId, { ...root, position: { x: -(screen?.x ?? 0) / (screen?.zoom ?? 1), y: -(screen?.y ?? 0) / (screen?.zoom ?? 1) } });
        continue;
      }
      const target = anchor?.item ?? owner;
      const shown = Boolean(document.items[target]) && scopeOf(document, owner).has(target);
      const box = shown ? layout.box(target) : { width: 0, height: 0 };
      if (root)
        result.set(rootId, {
          ...root,
          opacity: shown ? root.opacity : 0,
          position: shown ? applyMatrix(layout.matrix(target), {
            x: (anchor?.point?.x ?? 0) * box.width,
            y: (anchor?.point?.y ?? 0) * box.height,
          }) : root.position,
        });
    }
  }
  return result;
}
