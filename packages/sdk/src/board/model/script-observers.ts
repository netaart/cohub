import type { BoardDocument, BoardItem, BoardVec2 } from "@cohub/protocol";
import { applyMatrix, invertMatrix } from "@cohub/protocol/board-layout";
import { rectsIntersect, type Rect } from "./geometry.js";
import type { BoardScene } from "./scene.js";
import { isBoardRootScript } from "./script-index.js";
import { boardScriptScope, diffBoardScriptItems } from "./script-scope.js";
import type { BoardScriptChangeSource, BoardScriptEvent, BoardScriptGesture, BoardScriptOutput, BoardScriptPeer, BoardScriptView } from "./script.js";

const EVENTS = ["viewchange", "selectionchange", "transformend", "change", "gesture", "peerschange"] as const;
type Subscription = {
  listens: Set<string>;
  document?: BoardDocument;
  scope: ReadonlySet<string>;
  selection?: readonly string[];
  selected?: { ids: string[]; total: number };
  view?: string;
  items?: Map<string, BoardItem>;
  diffed?: BoardDocument;
  peers?: { from: readonly BoardScriptPeer[]; scene: BoardScene; key: string };
};

export type BoardScriptWorldGesture = Omit<BoardScriptGesture, "points" | "item"> & {
  points: readonly BoardVec2[];
  item?: string;
};

function pointsRect(points: readonly BoardVec2[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { x, y } of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) };
}

export function createBoardScriptObservers(send: (owner: string, event: BoardScriptEvent) => void) {
  const subscribers = new Map<string, Subscription>();
  function scope(owner: string, entry: Subscription, document: BoardDocument) {
    if (entry.document !== document) {
      entry.scope = boardScriptScope(document, owner);
      entry.document = document;
      entry.selection = undefined;
    }
    return entry.scope;
  }
  function diff(
    owner: string,
    entry: Subscription,
    document: BoardDocument,
    sourceOf: (id: string) => BoardScriptChangeSource | undefined,
  ) {
    const first = !entry.items;
    const copy = entry.items ?? new Map<string, BoardItem>();
    entry.items = copy;
    entry.diffed = document;
    const groups = new Map<BoardScriptChangeSource, { added: string[]; changed: string[]; removed: string[] }>();
    diffBoardScriptItems(copy, document, scope(owner, entry, document), first ? undefined : (id, kind) => {
      const source = sourceOf(id) ?? "remote";
      let group = groups.get(source);
      if (!group) {
        group = { added: [], changed: [], removed: [] };
        groups.set(source, group);
      }
      group[kind].push(id);
    });
    for (const [source, group] of groups) send(owner, { type: "change", data: { ...group, source } });
  }
  return {
    get size() { return subscribers.size; },
    get transforms() { return [...subscribers.values()].some((entry) => entry.listens.has("transformend")); },
    get gestures() { return [...subscribers.values()].some((entry) => entry.listens.has("gesture")); },
    get watchesPeers() { return [...subscribers.values()].some((entry) => entry.listens.has("peerschange")); },
    update(owner: string, output: BoardScriptOutput | null) {
      const listens = new Set(EVENTS.filter((type) => output?.listens.includes(type)));
      if (!listens.size) { subscribers.delete(owner); return; }
      const entry = subscribers.get(owner) ?? { listens, scope: new Set<string>() };
      if (!listens.has("viewchange")) entry.view = undefined;
      if (!listens.has("selectionchange")) { entry.selection = undefined; entry.selected = undefined; }
      if (!listens.has("change")) {
        entry.items = undefined;
        entry.diffed = undefined;
      }
      if (!listens.has("peerschange")) entry.peers = undefined;
      entry.listens = listens;
      subscribers.set(owner, entry);
    },
    sync(
      document: BoardDocument,
      selection: readonly string[],
      readView: () => BoardScriptView,
      sourceOf: (id: string) => BoardScriptChangeSource | undefined = () => undefined,
    ) {
      let view: BoardScriptView | undefined;
      let key: string | undefined;
      for (const [owner, entry] of subscribers) {
        if (entry.listens.has("change") && entry.diffed !== document)
          diff(owner, entry, document, sourceOf);
        if (entry.listens.has("viewchange")) {
          view ??= readView();
          key ??= JSON.stringify(view);
          if (entry.view !== key) {
            entry.view = key;
            send(owner, { type: "viewchange", data: view });
          }
        }
        if (entry.listens.has("selectionchange")) {
          const allowed = scope(owner, entry, document);
          if (entry.selection === selection) continue;
          entry.selection = selection;
          const ids = selection.filter((id) => allowed.has(id));
          const previous = entry.selected;
          if (previous && previous.total === selection.length && ids.length === previous.ids.length && ids.every((id, i) => id === previous.ids[i])) continue;
          entry.selected = { ids, total: selection.length };
          send(owner, { type: "selectionchange", data: { ids, total: selection.length } });
        }
      }
    },
    transform(document: BoardDocument, event: { ids: readonly string[]; operation: string; cancelled: boolean }) {
      for (const [owner, entry] of subscribers) {
        if (!entry.listens.has("transformend")) continue;
        const allowed = scope(owner, entry, document);
        const ids = event.ids.filter((id) => allowed.has(id));
        if (ids.length) send(owner, { type: "transformend", data: { ...event, ids } });
      }
    },
    gesture(document: BoardDocument, scene: BoardScene, gesture: BoardScriptWorldGesture) {
      const bounds = pointsRect(gesture.points);
      for (const [owner, entry] of subscribers) {
        const root = isBoardRootScript(document, owner);
        if (!entry.listens.has("gesture") || (!root && !scene.get(owner))) continue;
        const allowed = scope(owner, entry, document);
        const item = gesture.item && allowed.has(gesture.item) ? gesture.item : undefined;
        if (!item && !root && !rectsIntersect(scene.layout.bounds(owner), bounds)) continue;
        const local = invertMatrix(scene.layout.matrix(owner));
        const data: BoardScriptGesture = {
          id: gesture.id,
          tool: gesture.tool,
          phase: gesture.phase,
          points: gesture.points.map((point) => applyMatrix(local, point)),
          ...(item ? { item } : {}),
        };
        send(owner, { type: "gesture", data });
      }
    },
    peers(document: BoardDocument, scene: BoardScene, list: readonly BoardScriptPeer[]) {
      for (const [owner, entry] of subscribers) {
        if (!entry.listens.has("peerschange") || (entry.peers?.from === list && entry.peers.scene === scene)) continue;
        if (!isBoardRootScript(document, owner) && !scene.get(owner)) continue;
        const local = invertMatrix(scene.layout.matrix(owner));
        const data = list.map((peer) => ({ ...peer, point: peer.point && applyMatrix(local, peer.point) }));
        const key = JSON.stringify(data);
        const changed = entry.peers?.key !== key;
        entry.peers = { from: list, scene, key };
        if (changed) send(owner, { type: "peerschange", data });
      }
    },
    clear() { subscribers.clear(); },
  };
}
