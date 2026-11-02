import type { BoardDocument, BoardPatch, BoardVec2 } from "@cohub/protocol";
import { type BoardEditor, type BoardPointerEvent, type BoardToolId, createBoardEditor } from "../editor/index.js";
import type { BoardExportRegion } from "../model/export-plan.js";
import { worldPoint, screenPoint } from "../model/geometry.js";
import type { BoardScriptOutput } from "../model/script.js";
import type { BoardScriptHost } from "../render/renderers/board-renderer-registry.js";
import { createNodeBoardRenderer, exportBoardImageBytes, type BoardNodeRenderer } from "../export/node/index.js";
import { createNodeBoardScriptRuntime } from "../export/node/scripts.js";
import { createBoardScriptController } from "../stage/script-controller.js";

export type BoardScriptHarnessOptions = {
  document: BoardDocument;
  readModule(path: string): Promise<string>;
  renderer?: BoardNodeRenderer;
  readonly?: boolean;
  tool?: BoardToolId;
  leader?: boolean;
  timeoutMs?: number;
};

export type BoardScriptHarnessPointer = {
  pointerId?: number;
  pointerType?: "mouse" | "pen" | "touch";
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
};

const FRAME_MS = 1000 / 60;

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
  const controller = createBoardScriptController({
    editor,
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

  function pointerEvent(point: BoardVec2, phase: "down" | "move" | "up", input: BoardScriptHarnessPointer = {}): BoardPointerEvent {
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
      buttons: phase === "up" ? 0 : 1,
      pointerType: input.pointerType ?? "mouse",
      cancelled: false,
      pressure: 0.5,
    };
  }

  async function pointer(phase: "down" | "move" | "up", point: BoardVec2, input?: BoardScriptHarnessPointer) {
    const event = pointerEvent(point, phase, input);
    const routed = controller.pointer(phase, event);
    if (!routed) {
      if (phase === "down") editor.pointerDown(event);
      else if (phase === "move") editor.pointerMove(event);
      else editor.pointerUp(event);
    }
    clock += FRAME_MS;
    await frame();
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
      await pointer("up", point, input);
    },
    async drag(points: readonly BoardVec2[], input?: BoardScriptHarnessPointer) {
      const [first, ...rest] = points;
      if (!first) return;
      await pointer("down", first, input);
      for (const point of rest) await pointer("move", point, input);
      await pointer("up", points.at(-1) ?? first, input);
    },
    async key(type: "keydown" | "keyup", key: string) {
      controller.key({ type, key });
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
