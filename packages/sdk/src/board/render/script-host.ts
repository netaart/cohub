import type { BoardDocument, BoardItem } from "@cohub/protocol";
import { BoardBitmapTexture } from "./bitmap-texture.js";
import { boardBitmapResolution } from "./bitmap-resolution.js";
import { getBoardResolution } from "./text-resolution.js";
import { boardScriptItems } from "../model/script-index.js";
import { boardScriptScope } from "../model/script-scene.js";
import { boardScriptHitVisible, resolveBoardScriptHit } from "../model/script-hit.js";
import type { BoardScene } from "../model/scene.js";
import type { BoardViewport } from "../model/geometry.js";
import type {
  BoardScriptEvent,
  BoardScriptOutput,
  BoardScriptSnapshot,
} from "../model/script.js";
import type { BoardScriptHost } from "./renderers/board-renderer-registry.js";
import {
  loadBoardScriptSources,
  createBoardScriptModuleReader,
  type BoardScriptSources,
} from "./script-modules.js";
import { boardScriptFrameSource } from "./script-sandbox.js";
import type { ScriptRuntimeInput } from "./script-runtime.js";

type Graph = { key: string; sources: BoardScriptSources };

type Entry = {
  id: string;
  signature: string;
  token: number;
  graph: string | null;
  input: ScriptRuntimeInput;
  sentInput?: ScriptRuntimeInput;
  inputKey: string;
  inputDocument: BoardDocument | null;
  startedAt: number;
  capture?: {
    promise: Promise<BoardScriptSnapshot | null>;
    resolve(value: BoardScriptSnapshot | null): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  };
  texture: BoardBitmapTexture;
  error: string | null;
  output: BoardScriptOutput | null;
  events: BoardScriptEvent[];
  dirty: boolean;
  request: number;
  pending: boolean;
  timer?: ReturnType<typeof setTimeout>;
  time: number;
  tick: number;
  visible: boolean;
  draw: boolean;
  scale: number;
};

export type BoardScriptHostOptions = {
  readModule(path: string): Promise<string>;
  host: HTMLElement;
  onFrame(): void;
  onSchedule?(): void;
  isMaterialized?(id: string): boolean;
  onOutput(id: string, output: BoardScriptOutput | null): void;
  onInput?(id: string, event: BoardScriptEvent): void;
  capabilities?: Record<
    string,
    (id: string, input: unknown) => Promise<unknown>
  >;
  timeoutMs?: number;
  export?: boolean;
  snapshots?: Readonly<Record<string, BoardScriptSnapshot>>;
  poolSize?: number;
};

export type BoardScriptHostCallbacks = {
  onOutput(id: string, output: BoardScriptOutput | null): void;
  onInput(id: string, event: BoardScriptEvent): void;
  onFrame(): void;
  onSchedule(): void;
  capabilities: Record<string, (id: string, input: unknown) => Promise<unknown>>;
};

export const BOARD_SCRIPT_INSTANCE_LIMIT = 1000;

export type BrowserBoardScriptHost = BoardScriptHost & {
  sync(
    document: BoardDocument,
    scene: BoardScene,
    camera: BoardViewport,
    time: number,
    interactive: boolean,
    visibleIds?: ReadonlySet<string> | null,
  ): void;
  event(id: string, event: BoardScriptEvent): void;
  output(id: string): BoardScriptOutput | null;
  snapshot(id: string): Promise<BoardScriptSnapshot | null>;
  restore(id: string, snapshot: BoardScriptSnapshot): void;
  fault(id: string, message: string): void;
  restart(id: string): void;
  readonly animated: boolean;
  invalidate(src?: string): void;
  destroy(): void;
};

export type BoardScriptRuntimeHost = Omit<BrowserBoardScriptHost, "document">;

function supersedes(pending: BoardScriptEvent, event: BoardScriptEvent): boolean {
  if (pending.type !== event.type) return false;
  if (event.type === "viewchange" || event.type === "selectionchange") return true;
  if (event.type === "pointermove") return pending.pointerId === event.pointerId;
  if (event.type !== "gesture") return false;
  const a = pending.data as { id: string; phase: string };
  const b = event.data as { id: string; phase: string };
  return a.id === b.id && a.phase === "update" && b.phase === "update";
}

export function createBoardScriptHost(
  options: BoardScriptHostOptions,
): BrowserBoardScriptHost {
  const revisions = new Map<string, number>();
  const entries = new Map<string, Entry>();
  const restored = new Map(Object.entries(options.snapshots ?? {}));
  const graphs = new Map<string, Promise<Graph>>();
  const dependencies = new Map<string, Set<string>>();
  const limited = new Set<string>();
  const unsent = new Map<string, BoardScriptSources>();
  const modules = createBoardScriptModuleReader(options.readModule);
  const tokens = new Map<number, Entry>();
  let nextToken = 0;
  let nextGraph = 0;
  let brokerReady = false;
  let broker: HTMLIFrameElement | null = null;
  const signatures = new WeakMap<BoardItem, string>();
  function entrySignature(item: BoardItem): string {
    let value = signatures.get(item);
    if (value === undefined) {
      value = JSON.stringify(item.script);
      signatures.set(item, value);
    }
    return value;
  }
  const focusTargets = new Map<string, HTMLButtonElement>();
  const focusStyles = new WeakMap<HTMLButtonElement, string>();
  const layer = document.createElement("div");
  let interactive = false;
  layer.style.cssText =
    "position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:2";
  layer.dataset.boardScripts = "";
  options.host.appendChild(layer);
  let disposed = false;
  const schedule = () => (options.onSchedule ?? options.onFrame)();
  let lastZoom = Number.NaN;
  let settledAt = 0;
  let resolutionTimer: ReturnType<typeof setTimeout> | undefined;
  const needsTick = (entry: Entry) => !entry.error && brokerReady && entry.graph !== null && !entry.pending &&
    (entry.dirty || Boolean(entry.output?.updating || (entry.output?.animated && entry.draw)));
  const retiredTextures = new Set<BoardBitmapTexture>();
  let retirementFrame = 0;

  function retireTexture(texture: BoardBitmapTexture) {
    if (!texture.current) return;
    retiredTextures.add(texture);
    if (retirementFrame) return;
    // Keep queued renders alive until consumers switch textures.
    retirementFrame = requestAnimationFrame(() => {
      retirementFrame = requestAnimationFrame(() => {
        retirementFrame = 0;
        for (const retired of retiredTextures) retired.destroy();
        retiredTextures.clear();
      });
    });
  }

  function ensureBroker() {
    if (broker) return;
    broker = document.createElement("iframe");
    broker.setAttribute("sandbox", "allow-scripts");
    broker.setAttribute("aria-hidden", "true");
    broker.tabIndex = -1;
    broker.style.cssText =
      "position:absolute;visibility:hidden;width:0;height:0;border:0";
    broker.srcdoc = boardScriptFrameSource({ timeoutMs: options.timeoutMs, poolSize: options.poolSize });
    layer.appendChild(broker);
  }
  function toBroker(data: unknown, token?: number) {
    broker?.contentWindow?.postMessage({ token, data }, "*");
  }
  function removeFrame(entry: Entry) {
    if (entry.capture) {
      clearTimeout(entry.capture.timer);
      entry.capture.reject(
        new Error("Script stopped before its snapshot completed."),
      );
      entry.capture = undefined;
    }
    tokens.delete(entry.token);
    toBroker({ kind: "terminate" }, entry.token);
  }
  function release(entry: Entry) {
    clearTimeout(entry.timer);
    if (entry.output && !entry.error) {
      toBroker({ kind: "dispose" }, entry.token);
      entry.timer = setTimeout(() => removeFrame(entry), 100);
    } else removeFrame(entry);
    retireTexture(entry.texture);
    entries.delete(entry.id);
    revisions.set(entry.id, (revisions.get(entry.id) ?? 0) + 1);
    options.onOutput(entry.id, null);
  }
  function fail(entry: Entry, error: string) {
    clearTimeout(entry.timer);
    entry.error = error;
    revisions.set(entry.id, (revisions.get(entry.id) ?? 0) + 1);
    entry.pending = false;
    removeFrame(entry);
    options.onOutput(entry.id, null);
    options.onFrame();
  }
  function loadGraph(src: string): Promise<Graph> {
    let loading = graphs.get(src);
    if (!loading) {
      const paths = new Set([src]);
      dependencies.set(src, paths);
      const key = `${++nextGraph}:${src}`;
      loading = loadBoardScriptSources(src, (path) => {
        paths.add(path);
        return modules.read(path);
      }).then((sources) => {
        unsent.set(key, sources);
        return { key, sources };
      });
      graphs.set(src, loading);
      void loading.catch(() => {
        if (graphs.get(src) === loading) graphs.delete(src);
      });
    }
    return loading;
  }
  function dropGraph(src: string) {
    dependencies.delete(src);
    const loading = graphs.get(src);
    if (!loading) return;
    graphs.delete(src);
    void loading.then(({ key }) => {
      if (!unsent.delete(key)) toBroker({ kind: "graph.release", key });
    }, () => {});
  }
  const onMessage = (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== "object" || !broker || event.source !== broker.contentWindow) return;
    if (data.kind === "ready" && data.token === undefined) {
      brokerReady = true;
      options.onFrame();
      return;
    }
    const entry = tokens.get(data.token);
    if (!entry || entry.error) {
      data.bitmap?.close?.();
      return;
    }
    if (data.kind === "disposed") {
      clearTimeout(entry.timer);
      removeFrame(entry);
      return;
    }
    if (entries.get(entry.id) !== entry) {
      data.bitmap?.close?.();
      return;
    }
    if (data.kind === "crashed") {
      restored.delete(entry.id);
      tokens.delete(entry.token);
      entry.output = null;
      release(entry);
      options.onFrame();
      return;
    }
    if (data.kind === "dirty") {
      entry.dirty = true;
      schedule();
      return;
    }
    if (data.kind === "call") {
      const capability =
        typeof data.name === "string" &&
        options.capabilities &&
        Object.hasOwn(options.capabilities, data.name)
          ? options.capabilities[data.name]
          : undefined;
      void Promise.resolve()
        .then(() => {
          if (!capability)
            throw new Error(`Capability unavailable: ${data.name}`);
          return capability(entry.id, data.input);
        })
        .then(
          (value) => toBroker({ kind: "result", call: data.call, value }, entry.token),
          (error: unknown) =>
            toBroker({
              kind: "result",
              call: data.call,
              error: error instanceof Error ? error.message : String(error),
            }, entry.token),
        );
      return;
    }
    if (data.kind === "snapshot") {
      const capture = entry.capture;
      if (!capture) return;
      clearTimeout(capture.timer);
      entry.capture = undefined;
      if (data.error) capture.reject(new Error(String(data.error)));
      else
        capture.resolve(
          data.snapshot
            ? { ...data.snapshot, configuration: entry.signature }
            : null,
        );
      return;
    }
    if (data.kind === "error") {
      fail(entry, String(data.error));
      return;
    }
    if (data.kind !== "frame" || data.request !== entry.request) {
      data.bitmap?.close?.();
      return;
    }
    entry.pending = false;
    const output = data.output as BoardScriptOutput | undefined;
    const acceptsBitmap = Boolean(data.bitmap) && (options.export || !options.isMaterialized || options.isMaterialized(entry.id)) && entry.draw;
    if (acceptsBitmap) entry.texture.update(data.bitmap, (output ?? entry.output)?.pixelated === true);
    else data.bitmap?.close?.();
    const changed = acceptsBitmap || Boolean(output);
    if (changed) revisions.set(entry.id, (revisions.get(entry.id) ?? 0) + 1);
    try {
      if (output) {
        options.onOutput(entry.id, output);
        entry.output = output;
      }
    } catch (error) {
      fail(entry, error instanceof Error ? error.message : String(error));
      return;
    }
    if (changed) options.onFrame();
    else if (needsTick(entry)) schedule();
  };
  window.addEventListener("message", onMessage);

  function focusTarget(id: string, target: string): HTMLButtonElement {
    const key = `${id}/${target}`;
    let button = focusTargets.get(key);
    if (button) return button;
    button = document.createElement("button");
    button.type = "button";
    const emit = (type: string, key?: string) => {
      const current = entries.get(id);
      if (!interactive || !current || current.error || !current.output?.listens.includes(type)) return;
      const event = { type, target, key };
      options.onInput?.(id, event);
      current.events.push(event);
      current.dirty = true;
      options.onFrame();
    };
    button.onfocus = () => emit("focus");
    button.onblur = () => emit("blur");
    button.onclick = () => emit("click");
    button.onkeydown = (event) => emit("keydown", event.key);
    button.onkeyup = (event) => emit("keyup", event.key);
    focusTargets.set(key, button);
    layer.appendChild(button);
    return button;
  }

  return {
    revision: (id) => revisions.get(id) ?? 0,
    ready: (id) =>
      entries.get(id)?.output !== null && entries.get(id)?.output !== undefined,
    frame: (item) => entries.get(item.id)?.texture.current ?? null,
    error: (id) => entries.get(id)?.error ?? (limited.has(id) ? `A Board runs at most ${BOARD_SCRIPT_INSTANCE_LIMIT} scripts.` : null),
    release: () => {}, // Render culling never disposes the script instance.
    fault(id, message) {
      const entry = entries.get(id);
      if (entry) fail(entry, message);
    },
    restart(id) {
      const entry = entries.get(id);
      if (!entry) return;
      restored.delete(id);
      release(entry);
      options.onFrame();
    },
    snapshot(id) {
      const entry = entries.get(id);
      if (!entry?.output || entry.error) return Promise.resolve(null);
      if (entry.capture) return entry.capture.promise;
      let resolve: (value: BoardScriptSnapshot | null) => void = () => {};
      let reject: (error: Error) => void = () => {};
      const promise = new Promise<BoardScriptSnapshot | null>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const timer = setTimeout(() => {
        entry.capture = undefined;
        reject(new Error("Script snapshot timed out."));
      }, options.timeoutMs ?? 2_000);
      entry.capture = { promise, resolve, reject, timer };
      toBroker({ kind: "snapshot", events: entry.events.splice(0) }, entry.token);
      return promise;
    },
    restore(id, snapshot) {
      const entry = entries.get(id);
      if (
        entry &&
        snapshot.configuration &&
        snapshot.configuration !== entry.signature
      )
        throw new Error("Snapshot configuration does not match the script.");
      if (
        !Number.isFinite(snapshot.time) ||
        snapshot.time < 0 ||
        !Number.isInteger(snapshot.random)
      )
        throw new Error("Invalid script snapshot.");
      restored.set(id, structuredClone(snapshot));
      if (entry) release(entry);
      options.onFrame();
    },
    output: (id) => entries.get(id)?.output ?? null,
    get animated() {
      for (const entry of entries.values()) if (needsTick(entry)) return true;
      return false;
    },
    sync(board, scene, camera, time, inputEnabled, visibleIds) {
      if (disposed) return;
      interactive = inputEnabled;
      const now = performance.now();
      if (!options.export && camera.zoom !== lastZoom) {
        const first = Number.isNaN(lastZoom);
        lastZoom = camera.zoom;
        settledAt = first ? now : now + 120;
        clearTimeout(resolutionTimer);
        if (!first) resolutionTimer = setTimeout(schedule, 120);
      }
      const alive = new Set<string>();
      const liveFocusTargets = new Set<string>();
      let focusSurface: { width: number; height: number } | undefined;
      for (const [id, item] of boardScriptItems(board)) {
        if (!item.script?.enabled) continue;
        alive.add(id);
        const signature = entrySignature(item);
        let entry = entries.get(id);
        if (entry && entry.signature !== signature) {
          release(entry);
          entry = undefined;
        }
        const box = scene.layout.box(id);
        const scoped: Record<string, BoardItem> =
          entry?.inputDocument === board ? entry.input.items : { [id]: item };
        if (entry?.inputDocument !== board)
          for (const child of boardScriptScope(board, id)) {
            const value = board.items[child];
            if (value) scoped[child] = value;
          }
        const input: ScriptRuntimeInput =
          entry?.inputDocument === board &&
          entry.input.width === box.width &&
          entry.input.height === box.height
            ? entry.input
            : {
                id,
                item,
                items: scoped,
                width: box.width,
                height: box.height,
                capabilities: Object.keys(options.capabilities ?? {}),
                snapshot: restored.get(id),
              };
        if (!entry && entries.size >= BOARD_SCRIPT_INSTANCE_LIMIT) {
          limited.add(id);
          continue;
        }
        limited.delete(id);
        if (!entry) {
          entry = {
            id,
            signature,
            token: ++nextToken,
            graph: null,
            input,
            inputKey: "",
            inputDocument: null,
            startedAt:
              (options.export ? 0 : time) - (input.snapshot?.time ?? 0),
            texture: new BoardBitmapTexture(),
            error: null,
            output: null,
            events: [],
            dirty: true,
            request: 0,
            pending: false,
            time: -1,
            tick: -1,
            visible: true,
            draw: false,
            scale: 0,
          };
          entries.set(id, entry);
          restored.delete(id);
          ensureBroker();
          tokens.set(entry.token, entry);
          const current = entry;
          current.timer = setTimeout(
            () => fail(current, "Script loading timed out."),
            15_000,
          );
          void loadGraph(item.script.src).then(
            (graph) => {
              if (disposed || entries.get(id) !== current) return;
              clearTimeout(current.timer);
              current.graph = graph.key;
              options.onFrame();
            },
            (error: unknown) => {
              if (!disposed && entries.get(id) === current)
                fail(current, error instanceof Error ? error.message : String(error));
            },
          );
        }
        if (entry.error) continue;
        const visible = !visibleIds || visibleIds.has(id);
        if (entry.visible !== visible) {
          entry.visible = visible;
          if (visible) entry.dirty = true;
        }
        const draw = Boolean(options.export || (visible && (options.isMaterialized?.(id) ?? true)));
        if (entry.draw !== draw) {
          entry.draw = draw;
          if (draw) entry.dirty = true;
        }
        const frame = scene.get(id)?.frame;
        const itemScale = Math.max((frame?.width ?? box.width) / Math.max(1, box.width),
          (frame?.height ?? box.height) / Math.max(1, box.height));
        const scale = entry.output?.pixelated
          ? boardBitmapResolution(box.width, box.height, 1)
          : options.export
            ? Math.min(2, 2048 / Math.max(1, box.width, box.height))
            : boardBitmapResolution(box.width, box.height,
                now < settledAt && entry.scale > 0 ? entry.scale : camera.zoom * getBoardResolution() * itemScale, entry.scale);
        if (scale !== entry.scale) {
          entry.scale = scale;
          if (draw) entry.dirty = true;
        }
        if (entry.input !== input || entry.inputDocument !== board) {
          const inputKey = JSON.stringify(input);
          if (entry.inputKey !== inputKey) {
            entry.inputKey = inputKey;
            entry.input = input;
            entry.dirty = true;
          }
          entry.inputDocument = board;
        }
        if (entry.output && !options.export) {
          for (const [target, hit] of Object.entries(entry.output.hits)) {
            if (!hit.label) continue;
            const resolved = resolveBoardScriptHit(scene, id, hit);
            if (!resolved) continue;
            const { rect } = resolved;
            if (interactive) focusSurface ??= { width: options.host.clientWidth, height: options.host.clientHeight };
            const focusable = Boolean(focusSurface && interactive && boardScriptHitVisible(scene, resolved, camera, focusSurface));
            liveFocusTargets.add(`${id}/${target}`);
            const button = focusTarget(id, target);
            const label = hit.label ?? target;
            if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
            const tabIndex = focusable ? 0 : -1;
            if (button.tabIndex !== tabIndex) button.tabIndex = tabIndex;
            const [a, b, c, d, x, y] = scene.layout.matrix(resolved.id);
            const style = `position:absolute;pointer-events:none;background:transparent;border:0;padding:0;transform-origin:0 0;width:${rect.width}px;height:${rect.height}px;transform:matrix(${a * camera.zoom},${b * camera.zoom},${c * camera.zoom},${d * camera.zoom},${(x + a * rect.x + c * rect.y) * camera.zoom + camera.x},${(y + b * rect.x + d * rect.y) * camera.zoom + camera.y})`;
            if (focusStyles.get(button) !== style) {
              button.style.cssText = style;
              focusStyles.set(button, style);
            }
          }
        }
        if (!brokerReady || !entry.graph || entry.pending) continue;
        const elapsed = time - entry.startedAt;
        const tick = entry.output?.frameRate ? Math.floor((elapsed * entry.output.frameRate) / 1000) : elapsed;
        if (
          !entry.dirty &&
          (!entry.output?.animated ||
            (!entry.draw && !entry.output.updating) ||
            entry.tick === tick)
        )
          continue;
        entry.pending = true;
        entry.dirty = false;
        entry.time = time;
        entry.tick = tick;
        entry.request++;
        const sources = unsent.get(entry.graph);
        if (sources) {
          unsent.delete(entry.graph);
          toBroker({ kind: "graph", key: entry.graph, sources });
        }
        toBroker({
          request: entry.request,
          graph: entry.graph,
          input: entry.sentInput === entry.input ? undefined : entry.input,
          draw: entry.draw,
          t: elapsed,
          scale: entry.scale,
          events: entry.events.splice(0),
        }, entry.token);
        entry.sentInput = entry.input;
      }
      for (const [key, button] of focusTargets)
        if (!liveFocusTargets.has(key)) {
          button.remove();
          focusTargets.delete(key);
        }
      for (const entry of entries.values())
        if (!alive.has(entry.id)) release(entry);
      for (const id of limited) if (!alive.has(id)) limited.delete(id);
    },
    event(id, event) {
      const entry = entries.get(id);
      if (
        !entry ||
        entry.error ||
        (entry.output && !entry.output.listens.includes(event.type))
      )
        return;
      let queued = entry.events.length - 1;
      while (queued >= 0 && !supersedes(entry.events[queued] as BoardScriptEvent, event)) queued--;
      if (queued >= 0 && (event.type !== "pointermove" || queued === entry.events.length - 1))
        entry.events.splice(queued, 1);
      if (entry.events.length >= 128) return;
      entry.events.push(event);
      entry.dirty = true;
      options.onFrame();
    },
    invalidate(path) {
      modules.invalidate(path);
      const affected = new Set(
        [...dependencies].filter(([src, paths]) => !path || src === path || paths.has(path)).map(([src]) => src),
      );
      for (const src of affected) dropGraph(src);
      let changed = false;
      for (const entry of [...entries.values()]) {
        const src = entry.input.item.script?.src ?? "";
        if (path && !affected.has(src) && src !== path) continue;
        restored.delete(entry.id);
        release(entry);
        changed = true;
      }
      if (!path) restored.clear();
      if (changed) options.onFrame();
    },
    destroy() {
      disposed = true;
      clearTimeout(resolutionTimer);
      window.removeEventListener("message", onMessage);
      for (const entry of [...entries.values()]) release(entry);
      layer.remove();
      graphs.clear();
      dependencies.clear();
      unsent.clear();
      modules.destroy();
      focusTargets.clear();
      restored.clear();
      tokens.clear();
      revisions.clear();
      broker = null;
    },
  };
}
