import { boardScriptSenseOf, diffMergePatch, parseBoardScriptInputs, stateForCamera } from "@neta-art/cohub/board";
import type { BoardDocument, BoardScriptBrowserEvent, BoardScriptCamera } from "@neta-art/cohub/board";
import type {
  BoardScriptHarness,
  BoardScriptHarnessBroadcast,
  BoardScriptHarnessMode,
  BoardScriptHarnessPeer,
  BoardScriptHarnessPointer,
  BoardScriptHarnessPress,
} from "@neta-art/cohub/board/testing";
import { BOARD_SIMULATION_MODES, BOARD_SIMULATION_POINTERS, BOARD_SIMULATION_VIEWPORT, parseBoardSize } from "./board-command-support.js";
import { loadBoardDocument } from "./board-document.js";
import { type BoardExportRunOptions, type BoardExportSource, gpuResources, readSpaceFileBytes, resolveBundledFonts } from "./board-export.js";
import { openBoardGpu } from "./board-gpu/daemon.js";
import { type BoardGpuShader, findBoardGpuBrowser } from "./board-gpu/index.js";
import {
  boardScriptAttachments,
  boardShaderParameters,
  checkBoardShader,
  createBoardScriptHarness,
  createNodeBoardRenderer,
  describeBoardScriptLanes,
} from "./board-kernel.js";
import { settleBoardDocument } from "./board-media.js";
import { parseBoardTime } from "./board-time.js";
import { createClient } from "./client.js";

const TOOLS = ["select", "hand", "play", "text", "shape", "draw", "arrow", "frame"] as const;
const POINTER_TYPES = ["mouse", "pen", "touch"] as const;
const MAX_STEPS = 10_000;
const MAX_TIME_MS = 600_000;
const FRAME_MS = 1000 / 60;

type Point = { x: number; y: number };
export type BoardSimulationStep =
  | { wait: number }
  | { tool: (typeof TOOLS)[number] }
  | { tap: Point; input: BoardScriptHarnessPointer }
  | { drag: Point[]; input: BoardScriptHarnessPointer }
  | { move: Point[]; input: BoardScriptHarnessPointer }
  | { pointer: "down" | "move" | "up"; at: Point; input: BoardScriptHarnessPointer }
  | { key: string }
  | { select: string[] }
  | { input: BoardScriptBrowserEvent; data: unknown }
  | { inputs: string }
  | { peers: BoardScriptHarnessPeer[] }
  | { broadcast: string; to: string; data: unknown; from: string };

function point(value: unknown, name: string): Point {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => typeof n === "number" && Number.isFinite(n)))
    throw new Error(`${name} must be [x, y]`);
  return { x: value[0] as number, y: value[1] as number };
}

function pointerInput(step: Record<string, unknown>, name: string): BoardScriptHarnessPointer {
  const input: BoardScriptHarnessPointer = {};
  if (step.pointerType !== undefined) {
    if (!POINTER_TYPES.includes(step.pointerType as never)) throw new Error(`${name}.pointerType must be one of ${POINTER_TYPES.join(", ")}`);
    input.pointerType = step.pointerType as BoardScriptHarnessPointer["pointerType"];
  }
  for (const key of ["shiftKey", "altKey", "ctrlKey", "metaKey"] as const) {
    if (step[key] === undefined) continue;
    if (typeof step[key] !== "boolean") throw new Error(`${name}.${key} must be a boolean`);
    input[key] = step[key];
  }
  return input;
}

export type BoardSimulationMode = (typeof BOARD_SIMULATION_MODES)[number] & BoardScriptHarnessMode;
export type BoardSimulationPointer = (typeof BOARD_SIMULATION_POINTERS)[number];

export type BoardSimulation = {
  steps: BoardSimulationStep[];
  mode?: BoardSimulationMode;
  viewport?: { width: number; height: number };
  pointer?: BoardSimulationPointer;
};

export function parseBoardSimulation(value: Record<string, unknown>): BoardSimulation {
  const simulation: BoardSimulation = { steps: parseBoardSimulationSteps(value.steps ?? []) };
  if (value.mode !== undefined) {
    if (!BOARD_SIMULATION_MODES.includes(value.mode as never)) throw new Error(`mode must be one of ${BOARD_SIMULATION_MODES.join(", ")}`);
    simulation.mode = value.mode as BoardSimulationMode;
  }
  if (value.viewport !== undefined) simulation.viewport = parseBoardSize(String(value.viewport), "viewport");
  if (value.pointer !== undefined) {
    if (!BOARD_SIMULATION_POINTERS.includes(value.pointer as never)) throw new Error(`pointer must be one of ${BOARD_SIMULATION_POINTERS.join(", ")}`);
    simulation.pointer = value.pointer as BoardSimulationPointer;
  }
  if (simulation.mode === "view" && simulation.steps.some((step) => "tool" in step)) throw new Error("view mode has no tools; drop the tool steps or use edit or play.");
  return simulation;
}

export function parseBoardSimulationSteps(value: unknown): BoardSimulationStep[] {
  if (!Array.isArray(value)) throw new Error("steps must be an array");
  if (value.length > MAX_STEPS) throw new Error(`steps exceed the limit of ${MAX_STEPS}`);
  const steps = value.map(parseStep);
  const elapsed = steps.reduce((total, step) =>
    total + ("wait" in step ? step.wait : "tap" in step ? 2 * FRAME_MS : "drag" in step ? (step.drag.length + 1) * FRAME_MS : "move" in step ? step.move.length * FRAME_MS : "pointer" in step ? FRAME_MS : 0), 0);
  if (elapsed > MAX_TIME_MS) throw new Error(`steps exceed ${MAX_TIME_MS / 60_000} minutes of simulated time`);
  return steps;
}

function parseStep(entry: unknown, index: number): BoardSimulationStep {
  const name = `steps[${index}]`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${name} must be an object`);
  const step = entry as Record<string, unknown>;
  if ("wait" in step) {
    const wait = typeof step.wait === "number" ? step.wait : parseBoardTime(String(step.wait), `${name}.wait`);
    if (!Number.isFinite(wait) || wait < 0) throw new Error(`${name}.wait must not be negative`);
    return { wait };
  }
  if ("tool" in step) {
    if (!TOOLS.includes(step.tool as never)) throw new Error(`${name}.tool must be one of ${TOOLS.join(", ")}`);
    return { tool: step.tool as (typeof TOOLS)[number] };
  }
  if ("tap" in step) return { tap: point(step.tap, `${name}.tap`), input: pointerInput(step, name) };
  if ("drag" in step) {
    if (!Array.isArray(step.drag) || step.drag.length < 2) throw new Error(`${name}.drag must list at least two points`);
    return { drag: step.drag.map((entry, at) => point(entry, `${name}.drag[${at}]`)), input: pointerInput(step, name) };
  }
  if ("move" in step) {
    if (!Array.isArray(step.move) || !step.move.length) throw new Error(`${name}.move must list points`);
    return { move: step.move.map((entry, at) => point(entry, `${name}.move[${at}]`)), input: pointerInput(step, name) };
  }
  if ("pointer" in step) {
    if (step.pointer !== "down" && step.pointer !== "move" && step.pointer !== "up") throw new Error(`${name}.pointer must be down, move or up`);
    return { pointer: step.pointer, at: point(step.at, `${name}.at`), input: pointerInput(step, name) };
  }
  if ("key" in step) {
    if (typeof step.key !== "string" || !step.key) throw new Error(`${name}.key must be a key name`);
    return { key: step.key };
  }
  if ("select" in step) {
    if (!Array.isArray(step.select) || !step.select.every((id) => typeof id === "string")) throw new Error(`${name}.select must list item ids`);
    return { select: step.select as string[] };
  }
  if ("input" in step) {
    if (typeof step.input !== "string" || !boardScriptSenseOf(step.input)) throw new Error(`${name}.input must be a browser event, such as browser:devicemotion`);
    if (!step.data || typeof step.data !== "object" || Array.isArray(step.data)) throw new Error(`${name}.data must be an object`);
    return { input: step.input as BoardScriptBrowserEvent, data: step.data };
  }
  if ("inputs" in step) {
    if (typeof step.inputs !== "string" || !step.inputs) throw new Error(`${name}.inputs must be a Space file path`);
    return { inputs: step.inputs };
  }
  if ("peers" in step) {
    if (!Array.isArray(step.peers)) throw new Error(`${name}.peers must list viewers`);
    return { peers: step.peers.map((entry, at) => parsePeer(entry, `${name}.peers[${at}]`)) };
  }
  if ("broadcast" in step) {
    if (typeof step.broadcast !== "string" || !step.broadcast) throw new Error(`${name}.broadcast must be an event type`);
    if (typeof step.to !== "string" || !step.to) throw new Error(`${name}.to must be the id of the script that receives it`);
    if (step.from !== undefined && typeof step.from !== "string") throw new Error(`${name}.from must be a viewer name`);
    return { broadcast: step.broadcast, to: step.to, data: step.data ?? null, from: (step.from as string | undefined) ?? "Peer" };
  }
  throw new Error(`${name} must be one of wait, tool, tap, drag, move, pointer, key, select, input, inputs, peers or broadcast`);
}

function parsePeer(entry: unknown, name: string): BoardScriptHarnessPeer {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${name} must be an object`);
  const peer = entry as Record<string, unknown>;
  if (typeof peer.name !== "string" || !peer.name) throw new Error(`${name}.name must be a viewer name`);
  if (peer.pointerType !== undefined && !POINTER_TYPES.includes(peer.pointerType as never))
    throw new Error(`${name}.pointerType must be one of ${POINTER_TYPES.join(", ")}`);
  if (peer.pressed !== undefined && typeof peer.pressed !== "boolean") throw new Error(`${name}.pressed must be a boolean`);
  return {
    name: peer.name,
    ...(peer.at !== undefined ? { point: point(peer.at, `${name}.at`) } : {}),
    ...(peer.pointerType !== undefined ? { pointerType: peer.pointerType as BoardScriptHarnessPeer["pointerType"] } : {}),
    ...(peer.pressed !== undefined ? { pressed: peer.pressed } : {}),
  };
}

export type BoardSimulationPress = BoardScriptHarnessPress & { step: number };

async function run(
  harness: BoardScriptHarness,
  steps: readonly BoardSimulationStep[],
  pointerType: NonNullable<BoardScriptHarnessPointer["pointerType"]>,
  progress: { step: number },
  presses: BoardSimulationPress[],
  readInputs: (path: string) => Promise<string>,
) {
  for (const [index, step] of steps.entries()) {
    progress.step = index;
    let press: BoardScriptHarnessPress | null = null;
    const input = "input" in step && typeof step.input === "object" ? { pointerType, ...step.input } : undefined;
    if ("wait" in step) await harness.advance(step.wait);
    else if ("tool" in step) harness.tool = step.tool;
    else if ("tap" in step) press = await harness.tap(step.tap, input);
    else if ("drag" in step) press = await harness.drag(step.drag, input);
    else if ("move" in step) await harness.move(step.move, input);
    else if ("pointer" in step) press = await harness.pointer(step.pointer, step.at, input);
    else if ("key" in step) {
      await harness.key("keydown", step.key);
      await harness.key("keyup", step.key);
    } else if ("input" in step) await harness.input(step.input, step.data as never);
    else if ("inputs" in step) await harness.replay(parseBoardScriptInputs(await readInputs(step.inputs)));
    else if ("peers" in step) await harness.peers(step.peers);
    else if ("broadcast" in step) await harness.broadcast(step.to, step.broadcast, step.data, { name: step.from });
    else await harness.select(step.select);
    if (press) presses.push({ step: index, ...press });
  }
}

export type BoardSimulationResult<Rendered = never> = {
  time: number;
  commits: number;
  changes: Record<string, unknown>;
  errors: Record<string, string>;
  presses: BoardSimulationPress[];
  broadcasts: BoardScriptHarnessBroadcast[];
  camera?: BoardScriptCamera;
  warnings: string[];
  shaders?: { count: number; compiled: boolean };
  rendered?: Rendered;
};

export type BoardSimulationRender<Rendered> = {
  times?: number[];
  camera: boolean;
  scale: number;
  size?: { width: number; height: number };
  export(options: Required<Pick<BoardExportRunOptions, "document" | "viewport" | "drive" | "signal">> & Pick<BoardExportRunOptions, "view">): Promise<Rendered>;
};

export const BOARD_SIMULATION_TIMEOUT_MS = 120_000;

function shadersOf(harness: BoardScriptHarness): { shaders: BoardGpuShader[]; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const shaders: BoardGpuShader[] = [];
  for (const { id } of boardScriptAttachments(harness.document)) {
    const message = harness.error(id);
    const output = harness.output(id);
    if (message) errors[id] = message;
    else if (output?.shader) shaders.push({ id, shader: output.shader, ...(output.parameters ? { parameters: output.parameters } : {}) });
  }
  return { shaders, errors };
}

async function checkShaders(shaders: BoardGpuShader[], spaceId: string, document: BoardDocument): Promise<{ errors: Record<string, string>; compiled: boolean }> {
  const browser = findBoardGpuBrowser();
  const exporter = browser ? await openBoardGpu(gpuResources(spaceId, document), { browser }).catch(() => null) : null;
  if (exporter) {
    try {
      return { errors: await exporter.compile(shaders), compiled: true };
    } finally {
      await exporter.close();
    }
  }
  const errors: Record<string, string> = {};
  for (const { id, shader, parameters } of shaders) {
    try {
      checkBoardShader(shader, boardShaderParameters(parameters), id);
    } catch (error) {
      errors[id] = error instanceof Error ? error.message : String(error);
    }
  }
  return { errors, compiled: false };
}

export async function runBoardSimulation<Rendered = never>(options: {
  spaceId: string;
  target: string;
  simulation: BoardSimulation;
  leader: boolean;
  view?: BoardScriptCamera;
  timeoutMs?: number;
  signal?: AbortSignal;
  render?: BoardSimulationRender<Rendered>;
}): Promise<BoardSimulationResult<Rendered>> {
  const client = createClient();
  const { steps, mode, pointer } = options.simulation;
  const viewport = options.simulation.viewport ?? BOARD_SIMULATION_VIEWPORT;
  const document: BoardDocument = await settleBoardDocument(options.spaceId, (await loadBoardDocument(options.spaceId, options.target)).document);
  const renderer = await createNodeBoardRenderer({ fonts: resolveBundledFonts() });
  const readText = async (path: string) => new TextDecoder().decode((await readSpaceFileBytes(client, options.spaceId, path)).bytes);
  const progress = { step: -1, phase: "starting the scripts" };
  let harness: BoardScriptHarness | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = options.timeoutMs ?? BOARD_SIMULATION_TIMEOUT_MS;
  let remaining = timeoutMs;
  let armed = 0;
  let stopped = false;
  const controller = new AbortController();
  const expired = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => {
      stopped = true;
      reject(controller.signal.reason);
    }, { once: true });
  });
  expired.catch(() => {});
  const cancel = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const expire = () => {
    const busy = harness ? describeBoardScriptLanes(harness.status()) : [];
    const at = harness ? ` at ${Math.round(harness.time)} ms of simulated time` : "";
    const step = progress.step >= 0 ? `, step ${progress.step + 1} of ${steps.length}` : "";
    controller.abort(new Error([
      `The simulation did not finish in ${timeoutMs / 1000} s${at}${step}, while ${progress.phase}.`,
      ...busy.map((line) => `  ${line}`),
      ...(!busy.length && progress.phase === "running the steps" ? ["  No script was busy: the scripts keep handing each other work, or a step waits on something else."] : []),
    ].join("\n")));
  };
  const arm = () => {
    armed = Date.now();
    timer = setTimeout(expire, remaining);
  };
  const paused = async <T>(work: () => Promise<T>) => {
    clearTimeout(timer);
    remaining -= Date.now() - armed;
    try {
      return await work();
    } finally {
      if (!controller.signal.aborted) arm();
    }
  };
  let onFrame: ((time: number) => Promise<void>) | null = null;
  let exporting: Promise<Rendered> | null = null;
  const work = async (): Promise<BoardSimulationResult<Rendered>> => {
    harness = await createBoardScriptHarness({
      document,
      renderer,
      leader: options.leader,
      viewport,
      ...(mode ? { mode } : {}),
      ...(options.view ? { view: options.view } : {}),
      ...(pointer ? { device: { pointer } } : {}),
      readModule: readText,
      onFrame: (time) => {
        controller.signal.throwIfAborted();
        return onFrame?.(time);
      },
    });
    const current = harness;
    if (stopped) {
      current.destroy();
      throw new Error("The simulation timed out.");
    }
    progress.phase = "compiling shaders";
    const initial = shadersOf(current);
    const early = initial.shaders.length ? await checkShaders(initial.shaders, options.spaceId, current.document) : null;
    const presses: BoardSimulationPress[] = [];
    if (early && Object.keys(early.errors).length) {
      return {
        time: Math.round(current.time), commits: 0, changes: {}, errors: { ...initial.errors, ...early.errors }, presses, broadcasts: [],
        warnings: ["Stopped before the steps: fix the shader errors first."],
        shaders: { count: initial.shaders.length, compiled: early.compiled },
      };
    }
    const runSteps = async () => {
      progress.phase = "running the steps";
      await run(current, steps, pointer === "coarse" ? "touch" : "mouse", progress, presses, readText);
      progress.phase = "settling the scripts";
      await current.flush();
    };
    let rendered: Rendered | undefined;
    const render = options.render;
    if (render) {
      const screen = () => {
        const { camera, width, height } = current.view;
        const state = stateForCamera(camera, { width, height });
        return { zoom: camera.zoom, view: { center: { x: state.centerX, y: state.centerY }, zoom: state.zoom, pitch: state.pitch ?? 0, bearing: state.bearing ?? 0 } };
      };
      const density = render.size ? Math.min(render.size.width / viewport.width, render.size.height / viewport.height) : 1;
      const source = async (): Promise<BoardExportSource> => {
        const { zoom, view } = screen();
        const shown = await current.shown(render.camera ? zoom * density : render.scale);
        return {
          document: shown.document,
          ...(shown.scripts ? { scripts: shown.scripts } : {}),
          snapshots: await current.snapshot(),
          env: current.env,
          ...(render.camera ? { view } : {}),
        };
      };
      let driven = false;
      exporting = render.export({
        document: current.document,
        viewport,
        signal: controller.signal,
        ...(render.camera ? { view: screen().view } : {}),
        drive: async (draw) => {
          driven = true;
          const capture = (time: number) => paused(async () => {
            const phase = progress.phase;
            progress.phase = "drawing a frame";
            await draw(time, await source());
            progress.phase = phase;
          });
          if (!render.times) {
            await runSteps();
            await capture(Math.round(current.time));
            return;
          }
          const due = [...render.times];
          onFrame = async (time) => {
            while (due.length && (due[0] as number) <= time + 0.001) await capture(due.shift() as number);
          };
          await onFrame(current.time);
          await runSteps();
          progress.phase = "drawing the frames after the steps";
          while (due.length) await current.advance(Math.max(0.001, (due[0] as number) - current.time));
          onFrame = null;
        },
      });
      rendered = await exporting;
      if (!driven) await runSteps();
    } else await runSteps();
    const { shaders, errors } = shadersOf(current);
    const checked = new Set(initial.shaders.map(({ id }) => id));
    const added = shaders.filter(({ id }) => !checked.has(id));
    progress.phase = "compiling shaders";
    const late = added.length ? await checkShaders(added, options.spaceId, current.document) : null;
    Object.assign(errors, late?.errors);
    const compiled = (early?.compiled ?? true) && (late?.compiled ?? true);
    const finalMode = current.editor.scriptMode;
    const warnings = [
      ...[...current.emitFailures].map(([id, message]) => `${id}: ${message}`),
      ...boardScriptAttachments(current.document).flatMap(({ id, script }) =>
        script.modes && !script.modes.includes(finalMode) ? [`${id}: runs only in ${script.modes.join(", ")}, not in ${finalMode} mode.`] : []),
    ];
    return {
      time: Math.round(current.time),
      commits: current.commits.length,
      changes: (diffMergePatch(document, current.document) as Record<string, unknown> | undefined) ?? {},
      errors,
      presses,
      broadcasts: [...current.broadcasts],
      ...(current.camera ? { camera: current.camera } : {}),
      warnings,
      ...(shaders.length ? { shaders: { count: shaders.length, compiled } } : {}),
      ...(rendered === undefined ? {} : { rendered }),
    };
  };
  arm();
  try {
    return await Promise.race([work(), expired]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    controller.abort(new Error("The simulation stopped."));
    (harness as BoardScriptHarness | null)?.destroy();
    await (exporting as Promise<Rendered> | null)?.catch(() => {});
    renderer.destroy();
  }
}
