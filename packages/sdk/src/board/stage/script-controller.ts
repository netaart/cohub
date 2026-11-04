import type { BoardDocument, BoardPatch, BoardScript, BoardVec2 } from "@cohub/protocol";
import { applyMatrix, invertMatrix } from "@cohub/protocol/board-layout";
import { boardDragSlop, type BoardEditor, type BoardPointerEvent, selectionTransformControlAt } from "../editor/index.js";
import { withBoardScripts } from "../model/animation.js";
import type { BoardViewport, Rect } from "../model/geometry.js";
import { sameJson } from "../model/json.js";
import { layoutBoardScriptText } from "../model/script-calls.js";
import { boardScriptTarget } from "../model/script-hit.js";
import { createBoardScriptObservers, type BoardScriptWorldGesture } from "../model/script-observers.js";
import { isBoardRootScript } from "../model/script-index.js";
import { BOARD_SCRIPT_EVENT_QUEUE, boardScriptEmit } from "../model/script-events.js";
import { composeBoardScriptItems, prepareBoardScriptOutput } from "../model/script-scene.js";
import { type BoardShaderOwner, boardShaderOwners } from "../render/shader/layers.js";
import type { BoardScriptEvent, BoardScriptOutput, BoardScriptSnapshot } from "../model/script.js";
import type { BoardScriptHostCallbacks, BoardScriptRuntimeHost } from "../render/script-host.js";
import { type BoardScriptTimer, createBoardScriptCommits } from "./script-commits.js";
import {
  type BoardScriptPointerTarget,
  boardScriptPress,
  boardScriptsMayTakeInput,
  boardScriptTakesTool,
  createBoardScriptPointerRouter,
} from "./script-pointer.js";

export type BoardScriptControllerOptions = {
  editor: BoardEditor;
  createHost(callbacks: BoardScriptHostCallbacks): BoardScriptRuntimeHost;
  capabilities?: Record<string, (id: string, input: unknown) => Promise<unknown>>;
  leader?: () => boolean;
  now?: () => number;
  setTimer?: BoardScriptTimer;
  requestFrame(): void;
  requestScriptFrame(): void;
  onChange?(): void;
};

export type BoardScriptPointerResult = false | "capture" | "tap" | "click";

const ACTIVATION_MS = 5_000;
const MOTION_MS = 1_000;
const USER_EVENTS = new Set(["pointerdown", "pointerup", "click", "keydown", "keyup", "transformend", "gesture"]);

function isUserEvent(event: BoardScriptEvent): boolean {
  if (USER_EVENTS.has(event.type)) return true;
  return event.type === "change" && (event.data as { source?: string }).source === "user";
}

type Gesture = { id: string; tool: BoardScriptWorldGesture["tool"]; points: readonly BoardVec2[] };

function gestureKey({ points }: Gesture): string {
  const first = points[0];
  const last = points.at(-1);
  return `${points.length}:${first?.x},${first?.y}:${last?.x},${last?.y}`;
}

export function createBoardScriptController(options: BoardScriptControllerOptions) {
  const { editor } = options;
  const now = options.now ?? (() => performance.now());
  let host: BoardScriptRuntimeHost | null = null;
  let paused = false;
  let time = 0;
  let lastTick = now();
  const outputs = new Map<string, BoardScriptOutput>();
  const interactive = new Set<string>();
  const screens = new Set<string>();
  const activations = new Map<string, number>();
  const emitFailures = new Map<string, string>();
  const moved = new Map<string, number>();
  const listeners = new Set<() => void>();
  let version = 0;
  let composed = { version: -1, document: null as BoardDocument | null, zoom: 0, pan: "", playhead: "", moving: false, gesture: false };
  let hover: BoardScriptPointerTarget | null = null;
  let focus: string | null = null;
  const router = createBoardScriptPointerRouter();
  const presses = new Map<number, { target: BoardScriptPointerTarget; down: BoardPointerEvent; mode: "tap" | "drag" }>();
  let gesture: (Gesture & { key: string }) | null = null;
  let animated: ReadonlyMap<string, BoardScript> = new Map();
  let running = { base: null as BoardDocument | null, animated, document: null as BoardDocument | null };

  function scriptDocument(): BoardDocument {
    const base = editor.document;
    if (!animated.size) return base;
    if (running.base !== base || running.animated !== animated)
      running = { base, animated, document: withBoardScripts(base, animated) };
    return running.document as BoardDocument;
  }

  const send = (owner: string, event: BoardScriptEvent) => {
    if (isUserEvent(event)) activations.set(owner, now());
    host?.event(owner, event);
  };
  const observers = createBoardScriptObservers(send);
  const commits = createBoardScriptCommits({
    target: {
      get document() { return editor.document; },
      readonly: editor.readonly,
      get busy() { return editor.gestureActive || editor.editingId !== null; },
      commitPatch: (patch, commitOptions) => editor.commitPatch(patch, commitOptions),
    },
    leader: options.leader ?? (() => true),
    now,
    setTimer: options.setTimer,
  });
  let stopTransforms: (() => void) | null = null;
  function syncTransformSubscription() {
    if (observers.transforms && !stopTransforms) {
      stopTransforms = editor.subscribeTransforms((event) => {
        if (!paused) observers.transform(editor.document, event);
      });
    } else if (!observers.transforms && stopTransforms) {
      stopTransforms();
      stopTransforms = null;
    }
  }
  const activated = (owner: string) => now() - (activations.get(owner) ?? -Infinity) < ACTIVATION_MS;
  const notify = () => {
    for (const listener of listeners) listener();
  };

  function cancelPointers(owner?: string, retained?: BoardScriptOutput["hits"]) {
    router.cancelScripts((pointerId, target) => {
      presses.delete(pointerId);
      host?.event(target.owner, { type: "pointercancel", target: target.target, pointerId });
    }, owner, retained);
    for (const [pointerId, press] of presses)
      if (press.mode === "tap" && (!owner || press.target.owner === owner) && (!retained || !Object.hasOwn(retained, press.target.target)))
        presses.delete(pointerId);
    if (!retained || (hover && hover.owner === owner && !Object.hasOwn(retained, hover.target))) hover = null;
  }

  function createHost(): BoardScriptRuntimeHost {
    return options.createHost({
      onSchedule: options.requestScriptFrame,
      onFrame: () => {
        options.requestFrame();
        notify();
      },
      onInput: (id, event) => {
        if (isUserEvent(event)) activations.set(id, now());
      },
      capabilities: {
        ...options.capabilities,
        "board.emit": async (id, value) => {
          try {
            const { target, event } = boardScriptEmit(editor.document, id, value);
            if (activated(id)) activations.set(target, activations.get(id) ?? now());
            if (host && !host.event(target, event))
              throw new Error(`emit(${target}, "${event.type}") from ${id}: ${target} already has ${BOARD_SCRIPT_EVENT_QUEUE} events waiting.`);
          } catch (error) {
            emitFailures.set(id, error instanceof Error ? error.message : String(error));
            throw error;
          }
        },
        ...(editor.readonly ? {} : {
          "board.commit": async (id: string, value: unknown) => {
            const { patch, frame } = value as { patch: BoardPatch; frame: boolean };
            return commits.commit(id, patch, !frame && activated(id));
          },
        }),
        "board.layoutText": async (_id, value) => layoutBoardScriptText(value),
      },
      onOutput: (id, output) => {
        const previous = outputs.get(id);
        if (output && previous && output.sceneVersion !== undefined && output.sceneVersion === previous.sceneVersion) {
          Object.assign(previous, { uniforms: output.uniforms, passes: output.passes, version: output.version });
          return false;
        }
        if (output) {
          prepareBoardScriptOutput(editor.document, id, output);
          cancelPointers(id, output.hits);
          outputs.set(id, output);
          if (Object.keys(output.hits).length) interactive.add(id); else interactive.delete(id);
          if (Object.keys(output.screen).length) screens.add(id); else screens.delete(id);
        } else {
          cancelPointers(id);
          outputs.delete(id);
          interactive.delete(id);
          screens.delete(id);
          activations.delete(id);
        }
        observers.update(id, output);
        syncTransformSubscription();
        version++;
        options.requestFrame();
      },
    });
  }

  function stop() {
    const previous = host;
    host = null;
    previous?.destroy();
    commits.flush(true);
    observers.clear();
    syncTransformSubscription();
    interactive.clear();
    screens.clear();
    outputs.clear();
    activations.clear();
    emitFailures.clear();
    presses.clear();
    gesture = null;
    router.clear();
    editor.setScriptItems(new Map());
    moved.clear();
    hover = null;
    composed = { ...composed, version: -1, document: null };
  }

  function update() {
    const wanted = editor.hasScripts;
    if (wanted && !host) {
      host = createHost();
      time = 0;
      lastTick = now();
    } else if (!wanted && host) stop();
  }

  function compose(camera: BoardViewport, moving: boolean) {
    if (!host || (!outputs.size && composed.version === version)) return;
    const playhead = `${editor.playhead?.animationId ?? ""}:${editor.playhead?.time ?? ""}`;
    const gesture = screens.size > 0 && editor.gestureActive;
    const pan = [...screens].some((id) => isBoardRootScript(editor.document, id)) ? `${camera.x},${camera.y}` : "";
    if (
      composed.version === version && composed.document === editor.document && !gesture && !composed.gesture &&
      !moving && !composed.moving && composed.zoom === camera.zoom && composed.pan === pan && composed.playhead === playhead
    )
      return;
    const animation = editor.animationItems();
    const items = composeBoardScriptItems(editor.document, editor.scene, outputs, animation, camera,
      (owner, error) => host?.fault(owner, error instanceof Error ? error.message : String(error)),
      editor.gestureActive ? editor.scene.layout : undefined);
    const presented = new Set([...outputs.values()].flatMap((output) => Object.keys(output.patches)));
    for (const id of animation.keys()) if (!presented.has(id)) items.delete(id);
    const at = now();
    for (const id of editor.setScriptItems(items)) if (items.has(id)) moved.set(id, at);
    composed = { version, document: editor.document, zoom: camera.zoom, pan, playhead, moving, gesture };
  }

  function localGesture(): Gesture | null {
    const interaction = editor.interaction;
    if (interaction.type === "drawing") return { id: interaction.id, tool: "draw", points: interaction.points };
    if (interaction.type === "creatingBox")
      return { id: interaction.id, tool: interaction.kind === "frame" ? "frame" : "shape", points: [interaction.start, interaction.current] };
    if (interaction.type === "creatingArrow")
      return { id: interaction.id, tool: "arrow", points: [interaction.start, interaction.current] };
    return null;
  }

  function syncGesture() {
    const next = localGesture();
    if (gesture && gesture.id !== next?.id) {
      const created = Boolean(editor.document.items[gesture.id]);
      observers.gesture(editor.document, editor.scene, { ...gesture, phase: created ? "end" : "cancel", ...(created ? { item: gesture.id } : {}) });
      gesture = null;
    }
    if (!next) return;
    const key = gestureKey(next);
    if (gesture?.key === key) return;
    const points = next.points.map(({ x, y }) => ({ x, y }));
    observers.gesture(editor.document, editor.scene, { ...next, points, phase: gesture ? "update" : "start" });
    gesture = { ...next, points, key };
  }

  function sync(view: { camera: BoardViewport; surface: { width: number; height: number }; safeRect?: Rect; visibleIds: ReadonlySet<string> | null }) {
    if (!host) return;
    const current = now();
    if (!paused) time += Math.min(250, Math.max(0, current - lastTick));
    lastTick = current;
    if (!paused && observers.size) {
      observers.sync(editor.document, editor.selection, () => ({
        camera: { ...view.camera }, ...view.surface,
        safeRect: view.safeRect ?? { x: 0, y: 0, ...view.surface },
      }), editor.itemSource);
      if (observers.gestures) syncGesture();
    }
    host.sync(scriptDocument(), editor.scene, view.camera, time, !paused, view.visibleIds);
  }

  function pointerEvent(target: BoardScriptPointerTarget, type: string, input: BoardPointerEvent, related?: BoardScriptPointerTarget | null) {
    const point = applyMatrix(invertMatrix(editor.scene.layout.matrix(target.owner)), input.world);
    send(target.owner, {
      type, target: target.target, relatedTarget: related?.target, relatedOwner: related?.owner, point,
      pointerId: input.pointerId, pointerType: input.pointerType, buttons: input.buttons,
      shiftKey: input.shiftKey, altKey: input.altKey, ctrlKey: input.ctrlKey, metaKey: input.metaKey,
    });
  }

  function targetAt(input: BoardPointerEvent): { target: BoardScriptPointerTarget; tapsOnly: boolean } | null {
    if (paused || !outputs.size) return null;
    if (!boardScriptsMayTakeInput(input, {
      busy: editor.gestureActive || editor.spaceHeld,
      onHandle: () => editor.tool === "select" && selectionTransformControlAt(editor.selectionTransform, input.world, editor.camera.zoom, input.pointerType, editor.controlOutset) !== null,
    })) return null;
    const point = input.world;
    const candidates = editor.idsInRect({ x: point.x - 0.01, y: point.y - 0.01, width: 0.02, height: 0.02 }, true);
    const target = boardScriptTarget(editor.scene, candidates, point, outputs, editor.registry.hitTest);
    if (!target) return null;
    const hit = outputs.get(target.owner)?.hits[target.target];
    if (!boardScriptTakesTool(hit?.tools, editor.tool, editor.readonly)) return null;
    return { target, tapsOnly: !editor.readonly && editor.tool === "hand" };
  }

  function pointer(phase: "down" | "move" | "up" | "leave", input: BoardPointerEvent): BoardScriptPointerResult {
    if (!router.needsRouting(input.pointerId, interactive.size > 0) && !presses.has(input.pointerId)) return false;
    const pending = presses.get(input.pointerId);
    const found = phase === "leave" || router.owner(input.pointerId) === "editor" ? null : targetAt(input);
    const target = found?.target ?? null;
    if (pending?.mode !== "tap" && (target?.owner !== hover?.owner || target?.target !== hover?.target)) {
      if (hover) pointerEvent(hover, "pointerleave", input, target);
      if (target) pointerEvent(target, "pointerenter", input, hover);
      hover = target;
    }
    if (phase === "down") {
      focus = target?.owner ?? null;
      const press = target ? boardScriptPress(outputs.get(target.owner)?.listens ?? [], found?.tapsOnly) : "pass";
      router.route("down", input.pointerId, press === "drag" ? target : null, input.screen);
      if (!target || press === "pass") return false;
      presses.set(input.pointerId, { target, down: input, mode: press });
      if (press === "tap") return "tap";
      pointerEvent(target, "pointerdown", input);
      return "capture";
    }
    if (pending?.mode === "tap") {
      if (phase === "move") {
        const { down } = pending;
        if (Math.hypot(input.screen.x - down.screen.x, input.screen.y - down.screen.y) <= boardDragSlop(input.pointerType)) return "tap";
        presses.delete(input.pointerId);
        editor.pointerDown(down);
        return false;
      }
      presses.delete(input.pointerId);
      router.route("up", input.pointerId, null, input.screen, true);
      if (phase === "up" && !input.cancelled) {
        pointerEvent(pending.target, "click", input);
        return "click";
      }
      return "tap";
    }
    const captured = router.owner(input.pointerId) === "script";
    const { recipient, click } = router.route(phase, input.pointerId, target, input.screen, input.cancelled);
    if (recipient && phase !== "leave") pointerEvent(recipient, input.cancelled ? "pointercancel" : `pointer${phase}`, input);
    if (phase === "up") presses.delete(input.pointerId);
    if (click && outputs.get(click.owner)?.listens.includes("click")) {
      pointerEvent(click, "click", input);
      return "click";
    }
    return captured || (recipient !== null && phase !== "move") ? "capture" : false;
  }

  return {
    get host() { return host; },
    get animated() { return !paused && Boolean(host?.animated); },
    get hovering() { return hover !== null; },
    get hovered(): BoardScriptPointerTarget | null { return hover; },
    get paused() { return paused; },
    setPaused(next: boolean) {
      if (next === paused) return;
      if (next) cancelPointers();
      paused = next;
      lastTick = now();
    },
    update,
    animate(next: ReadonlyMap<string, BoardScript>) {
      if (next.size === animated.size && [...next].every(([id, script]) => sameJson(animated.get(id), script))) return;
      animated = next;
    },
    compose,
    moving(): Iterable<string> {
      const at = now();
      for (const [id, changed] of moved) if (at - changed > MOTION_MS) moved.delete(id);
      return moved.keys();
    },
    sync,
    pointer,
    key(event: Pick<BoardScriptEvent, "type" | "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">): boolean {
      if (paused || !hover || (!editor.readonly && focus !== hover.owner) || !outputs.get(hover.owner)?.listens.includes(event.type)) return false;
      send(hover.owner, { ...event, target: hover.target });
      return true;
    },
    cursor(): string | null {
      if (!hover) return null;
      const output = outputs.get(hover.owner);
      return output?.hits[hover.target]?.cursor ?? (output?.listens.includes("click") ? "pointer" : "default");
    },
    cancelPointers: () => cancelPointers(),
    resume() { lastTick = now(); },
    reset(id?: string) {
      if (id) return host?.restart(id);
      time = 0;
      host?.invalidate();
    },
    invalidate: (path: string) => host?.invalidate(path),
    output: (id: string) => host?.output(id) ?? null,
    shaderOwners(): BoardShaderOwner[] {
      const current = host;
      return current && !paused ? boardShaderOwners(scriptDocument(), outputs, (id) => current.clock(id)) : [];
    },
    error: (id: string) => host?.error(id) ?? null,
    emitFailures: emitFailures as ReadonlyMap<string, string>,
    async snapshot(): Promise<Record<string, BoardScriptSnapshot>> {
      const result: Record<string, BoardScriptSnapshot> = {};
      await Promise.all([...outputs.keys()].map(async (id) => {
        const snapshot = await host?.snapshot(id);
        if (snapshot) result[id] = snapshot;
      }));
      return result;
    },
    restore: (id: string, snapshot: BoardScriptSnapshot) => host?.restore(id, snapshot),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    flush: (force = false) => commits.flush(force),
    destroy() {
      stop();
      commits.clear();
      stopTransforms?.();
      stopTransforms = null;
      listeners.clear();
    },
  };
}

export type BoardScriptController = ReturnType<typeof createBoardScriptController>;
