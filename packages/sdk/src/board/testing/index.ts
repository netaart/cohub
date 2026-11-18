import type { BoardDocument, BoardPatch, BoardVec2 } from "@cohub/protocol";
import { type BoardEditor, type BoardPointerEvent, type BoardToolId, createBoardEditor, selectionTransformControlAt } from "../editor/index.js";
import type { BoardExportRegion } from "../model/export-plan.js";
import { type BoardViewport, pointToWorld, screenPoint, worldPoint } from "../model/geometry.js";
import { resolveBoardAnimationCamera } from "../model/sampling.js";
import { boardProjection, isBoardViewLevel } from "../model/view-camera.js";
import type {
  BoardScriptBrowserEvent,
  BoardScriptBrowserEvents,
  BoardScriptCamera,
  BoardScriptEnv,
  BoardScriptOutput,
  BoardScriptPeer,
  BoardScriptSense,
} from "../model/script.js";
import { BOARD_SCRIPT_EXPORT_ENV, type BoardScriptInputLog, boardScriptSenseStates } from "../model/script-senses.js";
import type { BoardScriptHost } from "../render/renderers/board-renderer-registry.js";
import { createNodeBoardRenderer, exportBoardImageBytes, type BoardNodeRenderer } from "../export/node/index.js";
import { createNodeBoardScriptRuntime } from "../export/node/scripts.js";
import { type BoardScriptDevice, createBoardScriptController } from "../stage/script-controller.js";

export type BoardScriptHarnessMode = "edit" | "play" | "view";

export type BoardScriptHarnessOptions = {
  document: BoardDocument;
  readModule(path: string): Promise<string>;
  renderer?: BoardNodeRenderer;
  mode?: BoardScriptHarnessMode;
  viewport?: { width: number; height: number };
  view?: BoardScriptCamera;
  leader?: boolean;
  timeoutMs?: number;
  device?: Partial<BoardScriptDevice>;
  onFrame?(time: number): Promise<void> | void;
};

export type BoardScriptHarnessPointer = {
  pointerId?: number;
  pointerType?: "mouse" | "pen" | "touch";
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
};

export type BoardScriptHarnessHit =
  | { on: "script"; owner: string; target: string }
  | { on: "handle"; handle: string }
  | { on: "item"; id: string; type: string }
  | { on: "empty"; under?: string };

export type BoardScriptHarnessPress = { down: BoardScriptHarnessHit; taken: string };

export type BoardScriptHarnessPeer = Partial<BoardScriptPeer> & { name: string };

export type BoardScriptHarnessBroadcast = { owner: string; type: string; data: unknown };

function harnessPeer(peer: BoardScriptHarnessPeer): BoardScriptPeer {
  return {
    id: peer.id ?? `peer-${peer.name}`,
    actorId: peer.actorId ?? peer.name,
    name: peer.name,
    color: peer.color ?? "#3b82f6",
    point: peer.point ?? null,
    pointerType: peer.pointerType ?? (peer.point ? "mouse" : null),
    pressed: peer.pressed ?? false,
  };
}

const FRAME_MS = 1000 / 60;

function describeInteraction(editor: BoardEditor): string | null {
  const interaction = editor.interaction;
  const ids = () => editor.selection.join(", ");
  switch (interaction.type) {
    case "idle":
    case "pressing":
      return null;
    case "translating":
      return interaction.moved ? `move ${[...interaction.origin.keys()].join(", ")}` : null;
    case "resizing":
      return `resize ${ids()}`;
    case "rotating":
      return `rotate ${ids()}`;
    case "brushing":
      return "select box";
    case "panning":
      return interaction.moved ? "pan" : null;
    case "drawing":
      return "draw";
    case "creatingBox":
      return `create ${interaction.kind}`;
    case "creatingArrow":
      return "create arrow";
    case "creatingText":
      return "create text";
    case "draggingArrowHandle":
      return `arrow ${interaction.which} handle`;
  }
}

export async function createBoardScriptHarness(options: BoardScriptHarnessOptions) {
  const renderer = options.renderer ?? await createNodeBoardRenderer();
  const commits: BoardPatch[] = [];
  let clock = 0;
  let timers: Array<{ at: number; run: () => void }> = [];
  let runtime: ReturnType<typeof createNodeBoardScriptRuntime> | null = null;
  let peers: readonly BoardScriptPeer[] = [];
  const broadcasts: BoardScriptHarnessBroadcast[] = [];
  const editor: BoardEditor = createBoardEditor({
    document: options.document,
    readonly: options.mode === "view",
    initialTool: options.mode === "play" ? "play" : "select",
    onCommit(patch) {
      commits.push(patch);
    },
  });
  const surface = { ...(options.viewport ?? { width: 1280, height: 800 }) };
  editor.surfaceSize = surface;
  editor.fitView({ animate: false, maxZoom: 1 });
  const device: BoardScriptDevice = {
    ...BOARD_SCRIPT_EXPORT_ENV,
    orientation: surface.height > surface.width ? "portrait" : "landscape",
    senses: boardScriptSenseStates("on"),
    ...options.device,
  };
  const controller = createBoardScriptController({
    editor,
    device: () => device,
    leader: () => options.leader ?? true,
    models: () => Object.keys(editor.document.items),
    peers: { list: () => peers, broadcast: (owner, type, data) => broadcasts.push({ owner, type, data }) },
    now: () => clock,
    setTimer(run, ms) {
      const timer = { at: clock + ms, run };
      timers.push(timer);
      return () => {
        timers = timers.filter((entry) => entry !== timer);
      };
    },
    requestFrame() {},
    requestScriptFrame() {},
    createHost: (callbacks) => {
      runtime = createNodeBoardScriptRuntime(renderer, { readModule: options.readModule, timeoutMs: options.timeoutMs, callbacks });
      return runtime;
    },
  });

  function runTimers(): boolean {
    const due = timers.filter((timer) => timer.at <= clock);
    timers = timers.filter((timer) => timer.at > clock);
    for (const timer of due) timer.run();
    return due.length > 0;
  }

  let shown: BoardViewport = editor.camera;
  let directed = false;
  function follow(): BoardViewport {
    const directing = options.view ?? controller.camera();
    const follows = editor.cameraPolicy === "follow" && directing !== null && Object.keys(directing).length > 0;
    const followed = follows ? resolveBoardAnimationCamera(directing, (id) => editor.scene.get(id)?.frame, surface, clock, editor.camera) : null;
    editor.followCamera(followed, { settle: directed });
    directed = directing !== null && follows;
    shown = followed ?? editor.camera;
    return shown;
  }

  function compose(camera: BoardViewport) {
    const projection = isBoardViewLevel(camera) ? null : boardProjection(camera, surface);
    controller.compose(camera, false, projection ? (point) => pointToWorld(projection.project(point.x, point.y), camera) : undefined);
  }

  async function frame() {
    controller.update();
    for (let round = 0; round < 16; round++) {
      controller.sync({ camera: shown, surface, visibleIds: null });
      await runtime?.settle();
      compose(follow());
      if (!runTimers() && !runtime?.queued) break;
    }
    await options.onFrame?.(clock);
  }

  function pointerEvent(point: BoardVec2, phase: "down" | "move" | "up", input: BoardScriptHarnessPointer = {}, pressed = phase !== "up"): BoardPointerEvent {
    const { x, y, zoom } = shown;
    return {
      pointerId: input.pointerId ?? 1,
      world: worldPoint(point.x, point.y),
      screen: screenPoint(point.x * zoom + x, point.y * zoom + y),
      shiftKey: input.shiftKey ?? false,
      altKey: input.altKey ?? false,
      ctrlKey: input.ctrlKey ?? false,
      metaKey: input.metaKey ?? false,
      button: 0,
      buttons: pressed ? 1 : 0,
      pointerType: input.pointerType ?? "mouse",
      cancelled: false,
      pressure: 0.5,
    };
  }

  let press: { down: BoardScriptHarnessHit; taken: string | null } | null = null;

  function editorHit(event: BoardPointerEvent): BoardScriptHarnessHit {
    const control = editor.tool === "select" && selectionTransformControlAt(editor.selectionTransform, event.world, editor.camera.zoom, event.pointerType, editor.controlOutset);
    if (control) return { on: "handle", handle: control.kind === "rotate" ? "rotate" : control.handle };
    const item = editor.pickAt(event.world, event.pointerType);
    if (item) return { on: "item", id: item.id, type: item.type };
    const under = editor.itemAt(event.world);
    return { on: "empty", ...(under ? { under: under.id } : {}) };
  }

  async function pointer(phase: "down" | "move" | "up", point: BoardVec2, input?: BoardScriptHarnessPointer, pressed?: boolean): Promise<BoardScriptHarnessPress | null> {
    const event = pointerEvent(point, phase, input, pressed);
    const hit = phase === "down" ? editorHit(event) : null;
    const routed = controller.pointer(phase, event);
    const target = routed ? controller.hovered : null;
    if (phase === "down") press = { down: target ? { on: "script", ...target } : (hit as BoardScriptHarnessHit), taken: target ? `script ${target.owner}/${target.target}` : null };
    if (!routed) {
      if (phase === "down") editor.pointerDown(event);
      else if (phase === "move") editor.pointerMove(event);
      else editor.pointerUp(event);
    }
    if (press && !routed) press.taken = describeInteraction(editor) ?? press.taken;
    clock += FRAME_MS;
    await frame();
    if (phase !== "up" || !press) return null;
    const done = { down: press.down, taken: press.taken ?? (press.down.on === "empty" ? "nothing" : "tap") };
    press = null;
    return done;
  }

  await frame();

  return {
    editor,
    get document(): BoardDocument {
      return editor.document;
    },
    get commits(): readonly BoardPatch[] {
      return commits;
    },
    get time() {
      return clock;
    },
    get camera(): BoardScriptCamera | null {
      return controller.camera();
    },
    get env(): BoardScriptEnv {
      return { ...device, mode: editor.scriptMode, ready: true };
    },
    get view(): { camera: BoardViewport; width: number; height: number } {
      return { camera: shown, ...surface };
    },
    output: (id: string): BoardScriptOutput | null => controller.output(id),
    error: (id: string): string | null => controller.error(id),
    get emitFailures(): ReadonlyMap<string, string> {
      return controller.emitFailures;
    },
    status: () => runtime?.status() ?? [],
    get senses(): BoardScriptSense[] {
      return controller.senses;
    },
    async advance(ms = FRAME_MS) {
      const end = clock + ms;
      while (clock < end) {
        clock = Math.min(end, clock + FRAME_MS);
        await frame();
      }
    },
    pointer,
    async tap(point: BoardVec2, input?: BoardScriptHarnessPointer) {
      await pointer("down", point, input);
      return (await pointer("up", point, input)) as BoardScriptHarnessPress;
    },
    async drag(points: readonly BoardVec2[], input?: BoardScriptHarnessPointer) {
      const [first, ...rest] = points;
      if (!first) return null;
      await pointer("down", first, input);
      for (const point of rest) await pointer("move", point, input);
      return pointer("up", points.at(-1) ?? first, input);
    },
    async move(points: readonly BoardVec2[], input?: BoardScriptHarnessPointer) {
      for (const point of points) await pointer("move", point, input, false);
    },
    snapshot: () => controller.snapshot(),
    async key(type: "keydown" | "keyup", key: string) {
      controller.key({ type, key });
      await frame();
    },
    async input<Type extends BoardScriptBrowserEvent>(type: Type, data: BoardScriptBrowserEvents[Type]) {
      controller.input(type, data);
      await frame();
    },
    async replay(log: BoardScriptInputLog) {
      const start = clock;
      for (const { t, type, data } of log.inputs) {
        if (start + t > clock) await this.advance(start + t - clock);
        controller.input(type as BoardScriptBrowserEvent, data as never);
      }
      await frame();
    },
    get broadcasts(): readonly BoardScriptHarnessBroadcast[] {
      return broadcasts;
    },
    async peers(next: readonly BoardScriptHarnessPeer[]) {
      peers = next.map(harnessPeer);
      await frame();
    },
    async broadcast(owner: string, type: string, data: unknown = null, from: BoardScriptHarnessPeer = { name: "Peer" }) {
      const { point: _point, pointerType: _type, pressed: _pressed, ...peer } = harnessPeer(from);
      controller.receive(owner, type, data, peer);
      await frame();
    },
    async flush() {
      controller.flush(true);
      await frame();
    },
    async select(ids: string[]) {
      editor.setSelection(ids);
      await frame();
    },
    set tool(value: BoardToolId) {
      editor.tool = value;
    },
    async shown(scale = 1): Promise<{ document: BoardDocument; scripts?: BoardScriptHost }> {
      const host = runtime;
      const document = editor.document;
      if (!host) return { document };
      await host.draw(scale);
      const scene = editor.scene;
      return {
        document,
        scripts: {
          frame: host.frame, error: host.error, ready: host.ready, release() {}, shaders: () => controller.shaderOwners(),
          document: (input, _time, screen) => host.document(input, input === document ? scene : undefined, screen),
        },
      };
    },
    async render(region: BoardExportRegion = { kind: "all" }, scale = 1): Promise<Uint8Array> {
      const { document, scripts } = await this.shown(scale);
      const result = exportBoardImageBytes(renderer, document, { region, scale, colorScheme: "light", screen: true, ...(scripts ? { scripts } : {}) });
      if (!result) throw new Error("Nothing to render.");
      return result.bytes;
    },
    destroy() {
      controller.destroy();
      editor.destroy();
      if (!options.renderer) renderer.destroy();
    },
  };
}

export type BoardScriptHarness = Awaited<ReturnType<typeof createBoardScriptHarness>>;
