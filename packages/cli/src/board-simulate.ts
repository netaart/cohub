import { diffMergePatch } from "@neta-art/cohub/board";
import type { BoardDocument, BoardExportRegion, BoardThemeId } from "@neta-art/cohub/board";
import type { BoardNodeExportFormat } from "@neta-art/cohub/board/export/node";
import type { BoardScriptHarness, BoardScriptHarnessPointer } from "@neta-art/cohub/board/testing";
import { gpuResources, loadBoardDocument, readSpaceFileBytes, resolveBundledFonts, runBoardExport } from "./board-export.js";
import { openBoardGpu } from "./board-gpu/daemon.js";
import { type BoardGpuShader, findBoardGpuBrowser } from "./board-gpu/index.js";
import {
  boardScriptAttachments,
  boardShaderParameters,
  buildBoardScene,
  checkBoardShader,
  createBoardScriptHarness,
  createNodeBoardRenderer,
  itemBounds,
  planBoardExport,
  rectsIntersect,
} from "./board-kernel.js";
import { settleBoardDocument } from "./board-media.js";
import { parseBoardTime } from "./board-time.js";
import { createClient } from "./client.js";

const TOOLS = ["select", "hand", "text", "shape", "draw", "arrow", "frame"] as const;
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
  | { select: string[] };

function point(value: unknown, name: string): Point {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => typeof n === "number" && Number.isFinite(n)))
    throw new Error(`${name} must be [x, y]`);
  return { x: value[0] as number, y: value[1] as number };
}

function pointerInput(step: Record<string, unknown>, name: string): BoardScriptHarnessPointer {
  const pointerType = step.pointerType ?? "mouse";
  if (!POINTER_TYPES.includes(pointerType as never)) throw new Error(`${name}.pointerType must be one of ${POINTER_TYPES.join(", ")}`);
  const input: BoardScriptHarnessPointer = { pointerType: pointerType as BoardScriptHarnessPointer["pointerType"] };
  for (const key of ["shiftKey", "altKey", "ctrlKey", "metaKey"] as const) {
    if (step[key] === undefined) continue;
    if (typeof step[key] !== "boolean") throw new Error(`${name}.${key} must be a boolean`);
    input[key] = step[key];
  }
  return input;
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
  throw new Error(`${name} must be one of wait, tool, tap, drag, move, pointer, key or select`);
}

async function run(harness: BoardScriptHarness, steps: readonly BoardSimulationStep[]) {
  for (const step of steps) {
    if ("wait" in step) await harness.advance(step.wait);
    else if ("tool" in step) harness.tool = step.tool;
    else if ("tap" in step) await harness.tap(step.tap, step.input);
    else if ("drag" in step) await harness.drag(step.drag, step.input);
    else if ("move" in step) await harness.move(step.move, step.input);
    else if ("pointer" in step) await harness.pointer(step.pointer, step.at, step.input);
    else if ("key" in step) {
      await harness.key("keydown", step.key);
      await harness.key("keyup", step.key);
    } else await harness.select(step.select);
  }
}

export type BoardSimulationResult = {
  time: number;
  commits: number;
  changes: Record<string, unknown>;
  errors: Record<string, string>;
  shaders?: { count: number; compiled: boolean };
  image?: { bytes: Uint8Array; width: number; height: number };
};

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

export async function runBoardSimulation(options: {
  spaceId: string;
  target: string;
  steps: readonly BoardSimulationStep[];
  leader: boolean;
  image?: {
    region: BoardExportRegion;
    scale: number;
    theme: BoardThemeId;
    format: BoardNodeExportFormat;
    withImages: boolean;
  };
}): Promise<BoardSimulationResult> {
  const client = createClient();
  const document: BoardDocument = await settleBoardDocument(options.spaceId, (await loadBoardDocument(options.spaceId, options.target)).document);
  const renderer = await createNodeBoardRenderer({ fonts: resolveBundledFonts() });
  const harness = await createBoardScriptHarness({
    document,
    renderer,
    leader: options.leader,
    readModule: async (path) => new TextDecoder().decode((await readSpaceFileBytes(client, options.spaceId, path)).bytes),
  });
  try {
    await run(harness, options.steps);
    await harness.flush();
    const shown = options.image ? await harness.shown(options.image.scale) : null;
    const errors: Record<string, string> = {};
    const shaders: BoardGpuShader[] = [];
    for (const { id } of boardScriptAttachments(harness.document)) {
      const message = harness.error(id);
      const output = harness.output(id);
      if (message) errors[id] = message;
      else if (output?.shader) shaders.push({ id, shader: output.shader, ...(output.parameters ? { parameters: output.parameters } : {}) });
    }
    const checked = shaders.length ? await checkShaders(shaders, options.spaceId, harness.document) : null;
    Object.assign(errors, checked?.errors);
    const result: BoardSimulationResult = {
      time: Math.round(harness.time),
      commits: harness.commits.length,
      changes: (diffMergePatch(document, harness.document) as Record<string, unknown> | undefined) ?? {},
      errors,
      ...(checked ? { shaders: { count: shaders.length, compiled: checked.compiled } } : {}),
    };
    if (options.image && shown) {
      const gpu = checked?.compiled && !Object.keys(checked.errors).length && shaderShown(harness.document, shaders, options.image.region);
      const exported = await runBoardExport({
        spaceId: options.spaceId,
        target: options.target,
        ...(gpu
          ? { document: harness.document, snapshots: await harness.snapshot(), renderer: "gpu" as const }
          : { document: shown.document, ...(shown.scripts ? { scripts: shown.scripts } : {}) }),
        region: options.image.region,
        scale: options.image.scale,
        theme: options.image.theme,
        background: "paper",
        format: options.image.format,
        withImages: options.image.withImages,
      });
      const frame = exported?.frames[0];
      if (frame) result.image = { bytes: frame.bytes, width: frame.width, height: frame.height };
    }
    return result;
  } finally {
    harness.destroy();
    renderer.destroy();
  }
}

function shaderShown(document: BoardDocument, shaders: readonly BoardGpuShader[], region: BoardExportRegion): boolean {
  const scene = buildBoardScene(document);
  const plan = planBoardExport({ scene, region, scale: 1 });
  if (!plan) return false;
  return shaders.some(({ id }) => {
    const item = scene.get(id);
    return !item || rectsIntersect(itemBounds(item.frame), plan.world);
  });
}
