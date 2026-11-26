import { boardScriptAttachments, boardScriptSenseOf, diffMergePatch, parseBoardScriptInputs, stateForCamera } from "@neta-art/cohub/board";
import type { BoardDocument, BoardScriptBrowserEvent, BoardScriptCamera, BoardScriptParameter, BoardShader } from "@neta-art/cohub/board";
import type { BoardScriptHost } from "@neta-art/cohub/board/render";
import {
  type BoardScriptHarness,
  type BoardScriptHarnessBroadcast,
  type BoardScriptHarnessLog,
  type BoardScriptHarnessMode,
  type BoardScriptHarnessOptions,
  type BoardScriptHarnessPeer,
  type BoardScriptHarnessPointer,
  type BoardScriptHarnessPress,
  createBoardScriptHarness,
} from "@neta-art/cohub/board/testing";
import { BOARD_SIMULATION_MODES, BOARD_SIMULATION_POINTERS, parseBoardSize } from "./board-simulation-options.js";
import { parseBoardTime } from "./board-time.js";

export const BOARD_SIMULATION_TIMEOUT_MS = 120_000;

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

export function boardSimulationRecordings(steps: readonly BoardSimulationStep[]): string[] {
  return [...new Set(steps.flatMap((step) => ("inputs" in step ? [step.inputs] : [])))];
}

export type BoardSimulationPress = BoardScriptHarnessPress & { step: number };

export type BoardSimulationRender = {
  times?: number[];
  camera: boolean;
  scale: number;
  size?: { width: number; height: number };
};

export type BoardSimulationSpec = {
  steps: BoardSimulationStep[];
  mode?: BoardSimulationMode;
  viewport: { width: number; height: number };
  pointer?: BoardSimulationPointer;
  leader: boolean;
  view?: BoardScriptCamera;
  render?: BoardSimulationRender;
};

export type BoardSimulationShot = {
  time: number;
  document: BoardDocument;
  scripts?: BoardScriptHost;
  view?: BoardScriptCamera;
};

export type BoardSimulationShader = { id: string; shader: BoardShader; parameters?: Record<string, BoardScriptParameter> };

export type BoardSimulationResult = {
  time: number;
  commits: number;
  changes: Record<string, unknown>;
  errors: Record<string, string>;
  presses: BoardSimulationPress[];
  broadcasts: BoardScriptHarnessBroadcast[];
  logs: BoardScriptHarnessLog[];
  camera?: BoardScriptCamera;
  warnings: string[];
  shaders?: { count: number };
};

type Progress = { step: number; phase: string; harness: BoardScriptHarness | null };

function shadersOf(harness: BoardScriptHarness): { shaders: BoardSimulationShader[]; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const shaders: BoardSimulationShader[] = [];
  for (const { id } of boardScriptAttachments(harness.document)) {
    const message = harness.error(id);
    const output = harness.output(id);
    if (message) errors[id] = message;
    else if (output?.shader) shaders.push({ id, shader: output.shader, ...(output.parameters ? { parameters: output.parameters } : {}) });
  }
  return { shaders, errors };
}

async function runSteps(
  harness: BoardScriptHarness,
  steps: readonly BoardSimulationStep[],
  pointerType: NonNullable<BoardScriptHarnessPointer["pointerType"]>,
  progress: Progress,
  presses: BoardSimulationPress[],
  recording: (path: string) => string,
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
    else if ("inputs" in step) await harness.replay(parseBoardScriptInputs(recording(step.inputs)));
    else if ("peers" in step) await harness.peers(step.peers);
    else if ("broadcast" in step) await harness.broadcast(step.to, step.broadcast, step.data, { name: step.from });
    else await harness.select(step.select);
    if (press) presses.push({ step: index, ...press });
  }
}

type SimulationOptions = {
  document: BoardDocument;
  spec: BoardSimulationSpec;
  scripts?: BoardScriptHarnessOptions["scripts"];
  recordings: Readonly<Record<string, string>>;
  timeoutMs: number;
  compile?: (shaders: BoardSimulationShader[]) => Promise<Record<string, string>>;
  capture?: (shot: BoardSimulationShot) => Promise<void>;
};

export async function simulateBoard(options: SimulationOptions): Promise<BoardSimulationResult> {
  const progress: Progress = { step: -1, phase: "starting the scripts", harness: null };
  let remaining = options.timeoutMs;
  let armed = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  let expire: (error: Error) => void = () => {};
  const expired = new Promise<never>((_resolve, reject) => {
    expire = reject;
  });
  const clock = {
    hold() {
      clearTimeout(timer);
      remaining -= Date.now() - armed;
    },
    arm() {
      if (done) return;
      armed = Date.now();
      timer = setTimeout(() => expire(new Error(describeStall(progress, options.spec.steps.length, options.timeoutMs))), remaining);
    },
  };
  clock.arm();
  const running = runSimulation(options, progress, clock);
  running.catch(() => {});
  try {
    return await Promise.race([running, expired]);
  } finally {
    done = true;
    clearTimeout(timer);
    progress.harness?.destroy();
  }
}

async function runSimulation(options: SimulationOptions, progress: Progress, clock: { hold(): void; arm(): void }): Promise<BoardSimulationResult> {
  const { document, spec, compile, capture } = options;
  const recording = (path: string) => {
    const text = options.recordings[path];
    if (text === undefined) throw new Error(`${path} was not read.`);
    return text;
  };
  let onFrame: ((time: number) => Promise<void>) | null = null;
  const harness = await createBoardScriptHarness({
    document,
    leader: spec.leader,
    viewport: spec.viewport,
    ...(spec.mode ? { mode: spec.mode } : {}),
    ...(spec.view ? { view: spec.view } : {}),
    ...(spec.pointer ? { device: { pointer: spec.pointer } } : {}),
    ...(options.scripts ? { scripts: options.scripts } : {}),
    onFrame: (time) => onFrame?.(time),
  });
  progress.harness = harness;
  try {
    progress.phase = "compiling shaders";
    const initial = shadersOf(harness);
    const early = initial.shaders.length && compile ? await compile(initial.shaders) : {};
    const presses: BoardSimulationPress[] = [];
    if (Object.keys(early).length) {
      return {
        time: Math.round(harness.time), commits: 0, changes: {}, errors: { ...initial.errors, ...early }, presses, broadcasts: [], logs: [...harness.logs],
        warnings: ["Stopped before the steps: fix the shader errors first."],
        shaders: { count: initial.shaders.length },
      };
    }
    const runAll = async () => {
      progress.phase = "running the steps";
      await runSteps(harness, spec.steps, spec.pointer === "coarse" ? "touch" : "mouse", progress, presses, recording);
      progress.phase = "settling the scripts";
      await harness.flush();
    };
    const render = spec.render;
    if (render && capture) {
      const density = render.size ? Math.min(render.size.width / spec.viewport.width, render.size.height / spec.viewport.height) : 1;
      const shoot = async (time: number) => {
        const { camera, width, height } = harness.view;
        const state = stateForCamera(camera, { width, height });
        const shown = await harness.shown(render.camera ? camera.zoom * density : render.scale);
        clock.hold();
        try {
          await capture({
            time,
            document: shown.document,
            ...(shown.scripts ? { scripts: shown.scripts } : {}),
            ...(render.camera ? { view: { center: { x: state.centerX, y: state.centerY }, zoom: state.zoom, pitch: state.pitch ?? 0, bearing: state.bearing ?? 0 } } : {}),
          });
        } finally {
          clock.arm();
        }
      };
      if (!render.times) {
        await runAll();
        await shoot(Math.round(harness.time));
      } else {
        const due = [...render.times];
        onFrame = async (time) => {
          while (due.length && (due[0] as number) <= time + 0.001) await shoot(due.shift() as number);
        };
        await onFrame(harness.time);
        await runAll();
        progress.phase = "drawing the frames after the steps";
        while (due.length) await harness.advance(Math.max(0.001, (due[0] as number) - harness.time));
        onFrame = null;
      }
    } else await runAll();
    const { shaders, errors } = shadersOf(harness);
    const checked = new Set(initial.shaders.map(({ id }) => id));
    const added = shaders.filter(({ id }) => !checked.has(id));
    progress.phase = "compiling shaders";
    if (added.length && compile) Object.assign(errors, await compile(added));
    const finalMode = harness.editor.scriptMode;
    const warnings = [
      ...[...harness.emitFailures].map(([id, message]) => `${id}: ${message}`),
      ...boardScriptAttachments(harness.document).flatMap(({ id, script }) =>
        script.modes && !script.modes.includes(finalMode) ? [`${id}: runs only in ${script.modes.join(", ")}, not in ${finalMode} mode.`] : []),
    ];
    return {
      time: Math.round(harness.time),
      commits: harness.commits.length,
      changes: (diffMergePatch(document, harness.document) as Record<string, unknown> | undefined) ?? {},
      errors,
      presses,
      broadcasts: [...harness.broadcasts],
      logs: [...harness.logs],
      ...(harness.camera ? { camera: harness.camera } : {}),
      warnings,
      ...(shaders.length ? { shaders: { count: shaders.length } } : {}),
    };
  } finally {
    progress.harness = null;
    harness.destroy();
  }
}

function describeStall(progress: Progress, steps: number, timeoutMs: number): string {
  const harness = progress.harness;
  const busy = harness?.busy() ?? [];
  const at = harness ? ` at ${Math.round(harness.time)} ms of simulated time` : "";
  const step = progress.step >= 0 ? `, step ${progress.step + 1} of ${steps}` : "";
  return [
    `The simulation did not finish in ${timeoutMs / 1000} s${at}${step}, while ${progress.phase}.`,
    ...busy.map((line) => `  ${line}`),
    ...(!busy.length && progress.phase === "running the steps" ? ["  No script was busy: the scripts keep handing each other work, or a step waits on something else."] : []),
  ].join("\n");
}
