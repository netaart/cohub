import type { BoardDocument, BoardItem, BoardScript } from "@cohub/protocol";
import { sameJson } from "./json.js";
import { isBoardRootScript } from "./script-index.js";

type ScopeSource = Pick<BoardDocument, "items"> & { board?: Pick<BoardDocument["board"], "scripts"> };

const childrenByItems = new WeakMap<BoardDocument["items"], Map<string, string[]>>();
const everyItem = new WeakMap<BoardDocument["items"], ReadonlySet<string>>();

function childIndex(items: BoardDocument["items"]): Map<string, string[]> {
  let index = childrenByItems.get(items);
  if (!index) {
    index = new Map();
    for (const [id, item] of Object.entries(items)) {
      if (!item.parent) continue;
      const siblings = index.get(item.parent);
      if (siblings) siblings.push(id);
      else index.set(item.parent, [id]);
    }
    childrenByItems.set(items, index);
  }
  return index;
}

export function boardScriptOf(document: ScopeSource, id: string): BoardScript | undefined {
  return isBoardRootScript(document, id) ? document.board?.scripts?.[id] : document.items[id]?.script;
}

export function boardScriptScope(document: ScopeSource, id: string): ReadonlySet<string> {
  if (isBoardRootScript(document, id)) {
    let all = everyItem.get(document.items);
    if (!all) {
      all = new Set(Object.keys(document.items));
      everyItem.set(document.items, all);
    }
    return all;
  }
  const item = document.items[id];
  const scope = new Set([id]);
  for (const target of Object.values(item?.script?.targets ?? {})) if (document.items[target]) scope.add(target);
  if (item?.type !== "frame") return scope;
  const children = childIndex(document.items);
  const visited = new Set([id]);
  const queue = [id];
  for (let depth = 0; queue.length && depth < 64; depth++) {
    for (const parent of queue.splice(0)) {
      for (const child of children.get(parent) ?? []) {
        if (visited.has(child)) continue;
        visited.add(child);
        scope.add(child);
        queue.push(child);
      }
    }
  }
  return scope;
}

export function diffBoardScriptItems(
  copy: Map<string, BoardItem>,
  document: Pick<BoardDocument, "items">,
  scope: ReadonlySet<string>,
  note?: (id: string, kind: "added" | "changed" | "removed") => void,
): Record<string, BoardItem | null> | null {
  const changes: Record<string, BoardItem | null> = {};
  let changed = false;
  for (const id of scope) {
    const item = document.items[id];
    const previous = copy.get(id);
    if (!item || previous === item) continue;
    copy.set(id, item);
    if (previous && sameJson(previous, item)) continue;
    changes[id] = item;
    changed = true;
    note?.(id, previous ? "changed" : "added");
  }
  if (copy.size > scope.size)
    for (const id of copy.keys()) {
      if (scope.has(id)) continue;
      copy.delete(id);
      changes[id] = null;
      changed = true;
      note?.(id, "removed");
    }
  return changed ? changes : null;
}
