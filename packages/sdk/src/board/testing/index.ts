import type { BoardDocument, BoardPatch, BoardVec2 } from "@cohub/protocol";
import { type BoardEditor, type BoardPointerEvent, type BoardToolId, createBoardEditor, selectionTransformControlAt } from "../editor/index.js";
import type { BoardExportRegion } from "../model/export-plan.js";
import { worldPoint, screenPoint } from "../model/geometry.js";
import type { BoardScriptOutput, BoardScriptSense, BoardScriptSenseEvents } from "../model/script.js";
import { BOARD_SCRIPT_EXPORT_ENV, boardScriptSenseStates } from "../model/script-senses.js";
import type { BoardScriptHost } from "../render/renderers/board-renderer-registry.js";
import { createNodeBoardRenderer, exportBoardImageBytes, type BoardNodeRenderer } from "../export/node/index.js";
import { createNodeBoardScriptRuntime } from "../export/node/scripts.js";
import { type BoardScriptDevice, createBoardScriptController } from "../stage/script-controller.js";

export type BoardScriptHarnessOptions = {
  document: BoardDocument;
  readModule(path: string): Promise<string>;
  renderer?: BoardNodeRenderer;
  readonly?: boolean;
  tool?: BoardToolId;
  leader?: boolean;
  timeoutMs?: number;
  device?: Partial<BoardScriptDevice>;
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
  const editor: BoardEditor = createBoardEditor({
    document: options.document,
    readonly: options.readonly === true,
    initialTool: options.tool ?? "select",
    onCommit(patch) {
      commits.push(patch);
    },
  });
  const surface = { width: 1280, height: 800 };
  editor.surfaceSize = surface;
  const device: BoardScriptDevice = {
    ...BOARD_SCRIPT_EXPORT_ENV,
    senses: boardScriptSenseStates("on"),
    ...options.device,
  };
  const controller = createBoardScriptController({
    editor,
    device: () => device,
    leader: () => options.leader ?? true,
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

  async function frame() {
    controller.update();
    for (let round = 0; round < 16; round++) {
      controller.sync({ camera: editor.camera, surface, visibleIds: null });
      await runtime?.settle();
      controller.compose(editor.camera, false);
      if (!runTimers() && !runtime?.queued) break;
    }
  }

  function pointerEvent(point: BoardVec2, phase: "down" | "move" | "up", input: BoardScriptHarnessPointer = {}, pressed = phase !== "up"): BoardPointerEvent {
    const { x, y, zoom } = editor.camera;
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
    async sense<Type extends BoardScriptSense>(type: Type, data: BoardScriptSenseEvents[Type]) {
      controller.sense(type, data);
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
      if (!host) return { document: editor.document };
      await host.draw(scale);
      return {
        document: host.document(editor.document, editor.scene),
        scripts: { frame: host.frame, error: host.error, ready: host.ready, release() {}, shaders: () => controller.shaderOwners() },
      };
    },
    async render(region: BoardExportRegion = { kind: "all" }, scale = 1): Promise<Uint8Array> {
      const { document, scripts } = await this.shown(scale);
      const result = exportBoardImageBytes(renderer, document, { region, scale, colorScheme: "light", ...(scripts ? { scripts } : {}) });
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
