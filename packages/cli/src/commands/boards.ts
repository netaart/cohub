import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  BoardApplyResult,
  BoardCreateInput,
  BoardPatch,
  BoardPlaybackSnapshot,
  BoardReadInput,
} from "@neta-art/cohub";
import {
  BOARD_PRESET_NAMES,
  BOARD_SCHEMA_TARGETS,
  BOARD_SCRIPT_API,
  BOARD_THEME_IDS,
  type BoardExportRegion,
  boardJsonSchema,
  boardPresetTracks,
  boardSchemaOverview,
  isBoardPresetName,
  listBoardPresets,
} from "@neta-art/cohub/board";
import type { BoardNodeExportFormat } from "@neta-art/cohub/board/export/node";
import type { Command } from "commander";
import {
  BOARD_CREATE_INPUT_MAX_BYTES,
  BOARD_TRANSACTION_INPUT_MAX_BYTES,
  parseBoardJsonObject,
  readBoardJsonObject,
  writeBoardOutput,
} from "../board-command-support.js";
import { BOARD_EXPORT_IMAGE_MEMORY_MIB, BOARD_EXPORT_RENDERERS } from "../board-export-resources.js";
import { settleBoardPatch } from "../board-media.js";
import { formatBoardTime, parseBoardTime, parseBoardTimes } from "../board-time.js";
import { createClient, createRealtimeClient } from "../client.js";
import { error, handleHttp, json as outJson, jsonRequested, ok, table } from "../output.js";
import { resolveSpace } from "../space.js";
import { registerBoardExampleCommands } from "./boards/examples.js";
import { registerBoardAuthoringCommands } from "./boards/authoring.js";

type JsonOptions = { json?: boolean };

export const parseJsonObject = parseBoardJsonObject;

export function boardSchemaField(schema: Record<string, unknown> | undefined, path: string): unknown {
  let field = schema;
  for (const part of path.split(".")) {
    const properties = field?.properties as Record<string, Record<string, unknown>> | undefined;
    if (!part || !properties || !Object.hasOwn(properties, part)) throw new Error(`Unknown schema field ${path}.`);
    field = properties[part];
  }
  return field;
}

function withJson(command: Command): Command {
  return command.option("--json", "Output as JSON");
}

function parseNumber(value: string, name: string, options: { min?: number; max?: number; integer?: boolean } = {}): number {
  if (!value.trim()) throw new Error(`${name} must be a finite number`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  if (options.integer && !Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`);
  if (options.min !== undefined && parsed < options.min) throw new Error(`${name} must be at least ${options.min}`);
  if (options.max !== undefined && parsed > options.max) throw new Error(`${name} must be at most ${options.max}`);
  return parsed;
}

export function parseRect(value: string, name = "--rect"): { x: number; y: number; width: number; height: number } {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length !== 4) throw new Error(`${name} must be x,y,width,height`);
  const [x, y, width, height] = parts.map((part, index) => parseNumber(part, `${name} ${["x", "y", "width", "height"][index]}`)) as [number, number, number, number];
  if (width <= 0 || height <= 0) throw new Error(`${name} width and height must be greater than zero`);
  return { x, y, width, height };
}

function list(value: string | undefined): string[] | undefined {
  const entries = value?.split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries?.length ? entries : undefined;
}

async function boardClient(boards: Command, target: string, spaceId?: string) {
  spaceId ??= await resolveSpace(boards);
  return createClient().space(spaceId).boards.open(target);
}

/** A patch from an inline argument, a file, or stdin (`-`). */
async function readPatch(inline: string | undefined, input: string | undefined, maxBytes: number): Promise<BoardPatch> {
  if (inline !== undefined && input !== undefined) throw new Error("Pass the patch inline or with --input, not both.");
  if (inline !== undefined) return parseBoardJsonObject(inline, "patch") as BoardPatch;
  if (input !== undefined) return (await readBoardJsonObject(input, maxBytes)) as BoardPatch;
  throw new Error("Pass a patch inline or with --input <file|->.");
}

function describeChanges(result: BoardApplyResult): string {
  const parts = [
    result.changed.board ? "board" : null,
    result.changed.items.length ? `${result.changed.items.length} item${result.changed.items.length === 1 ? "" : "s"}` : null,
    result.changed.animations.length ? `${result.changed.animations.length} animation${result.changed.animations.length === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "nothing";
}

function showApplied(result: BoardApplyResult): void {
  if (result.status === "validated") ok(`Valid: would change ${describeChanges(result)}`);
  else if (result.status === "unchanged") ok(`Unchanged at version ${result.version}`);
  else ok(`Applied version ${result.version}${result.replayed ? " (replayed)" : ""}: ${describeChanges(result)}`);
  for (const diagnostic of result.diagnostics) console.log(`  ! ${diagnostic.path}: ${diagnostic.message}`);
}

function showPlayback(playback: BoardPlaybackSnapshot | null): void {
  if (!playback) {
    ok("Stopped");
    return;
  }
  table([{ ...playback, position: formatBoardTime(Math.round(playback.position)) }], [
    { key: "animationId", label: "Animation" },
    { key: "status", label: "Status" },
    { key: "position", label: "Position" },
    { key: "timeScale", label: "Speed" },
  ]);
}

// ─── Export ──────────────────────────────────────────────────────────────────

type ExportOptions = JsonOptions & {
  out?: string;
  at?: string;
  animation?: string;
  camera?: boolean;
  size?: string;
  scale?: string;
  padding?: string;
  frame?: string;
  items?: string;
  rect?: string;
  theme?: string;
  paper?: string;
  format?: string;
  quality?: string;
  images?: boolean;
  imageMemory?: string;
  renderer?: string;
  fps?: string;
  force?: boolean;
  async?: boolean;
  timeout?: string;
};

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function runExportTask(boards: Command, options: ExportOptions): Promise<void> {
  try {
    const command = ["cohub", ...process.argv.slice(2).filter((arg) => arg !== "--async")].map(shellQuote).join(" ");
    const { taskRunId } = await createClient().space(await resolveSpace(boards)).runCommand({ command });
    if (jsonRequested(options)) return outJson({ taskRunId, command });
    ok(`Exporting as Task ${taskRunId}`);
    console.log(`  Follow it with: cohub tasks get ${taskRunId}`);
  } catch (cause) {
    handleHttp(cause);
  }
}

function parseSize(value: string): { width: number; height: number } {
  const size = /^(\d+)x(\d+)$/.exec(value);
  if (!size?.[1] || !size[2]) throw new Error("--size must be widthxheight, e.g. 1600x900.");
  return { width: parseNumber(size[1], "width", { min: 1, max: 8192 }), height: parseNumber(size[2], "height", { min: 1, max: 8192 }) };
}

/** One region flag at most: being told to pick beats guessing which one wins. */
function parseExportRegion(options: ExportOptions): BoardExportRegion {
  const chosen = [options.camera && "--camera", options.frame && "--frame", options.items && "--items", options.rect && "--rect"].filter(Boolean);
  if (chosen.length > 1) throw new Error(`Pick one region: ${chosen.join(", ")} cannot be combined.`);
  if (options.frame) return { kind: "frame", id: options.frame };
  if (options.items) {
    const ids = list(options.items);
    if (!ids) throw new Error("--items needs at least one item id.");
    return { kind: "items", ids };
  }
  if (options.rect) return { kind: "rect", rect: parseRect(options.rect) };
  return { kind: "all" };
}

const BOARD_EXPORT_FORMATS: BoardNodeExportFormat[] = ["png", "jpeg", "webp"];
const BOARD_VIDEO_FORMATS = ["mp4", "webm"] as const;

type BoardVideoExportFormat = (typeof BOARD_VIDEO_FORMATS)[number];

function videoFormatFromPath(path: string): BoardVideoExportFormat | null {
  const lower = path.toLowerCase();
  return lower.endsWith(".webm") ? "webm" : lower.endsWith(".mp4") ? "mp4" : null;
}


function formatFromPath(path: string): BoardNodeExportFormat {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "jpeg";
  if (lower.endsWith(".webp")) return "webp";
  return "png";
}

function parseExportFormat(options: ExportOptions, outPath: string): BoardNodeExportFormat {
  if (!options.format) return formatFromPath(outPath);
  const format = options.format.toLowerCase() as BoardNodeExportFormat;
  if (!BOARD_EXPORT_FORMATS.includes(format)) throw new Error(`--format must be one of ${BOARD_EXPORT_FORMATS.join(", ")}.`);
  return format;
}

function parseChoice<T extends string>(value: string | undefined, name: string, choices: readonly T[]): T {
  const chosen = (value ?? choices[0]) as T;
  if (!choices.includes(chosen)) throw new Error(`${name} must be ${choices.join(" or ")}.`);
  return chosen;
}

/** `frames/%04d.png` → `frames/0012.png`; a sequence needs a `%d` placeholder. */
export function framePath(pattern: string, index: number): string {
  return pattern.replace(/%(0?)(\d*)d/, (_match, zero: string, width: string) => String(index).padStart(Number(width || 0), zero ? "0" : " "));
}

function registerExportCommand(boards: Command): void {
  withJson(boards.command("export <board>")
    .description("Render a Board to an image, or an animation to a frame sequence")
    .requiredOption("-o, --out <file>", "Output file; the extension picks the format. Sequences need %d, e.g. frames/%04d.png")
    .option("--at <time>", "A moment, comma-separated moments, or start:end:step")
    .option("--camera", "Follow the animation camera")
    .option("--size <widthxheight>", "Camera output in pixels; frames keep their own size", "1600x900")
    .option("--animation <id>", "Animation the --at times refer to")
    .option("--frame <item-id>", "Export one frame as a page")
    .option("--items <ids>", "Comma-separated item ids")
    .option("--rect <rect>", "World rect as x,y,width,height")
    .option("--scale <factor>", "Output pixels per board unit", "2")
    .option("--padding <units>", "Padding around the content in board units")
    .option("--theme <name>", `Cohub theme: ${BOARD_THEME_IDS.join(", ")}`, "dark")
    .option("--paper <mode>", "Output paper: paper or transparent", "paper")
    .option("--format <format>", `Override the format (${BOARD_EXPORT_FORMATS.join(", ")}, ${BOARD_VIDEO_FORMATS.join(", ")})`)
    .option("--quality <q>", "JPEG/WebP quality from 0 to 1", "0.92")
    .option("--fps <rate>", "Video frame rate; defaults to the --at step")
    .option("--image-memory <mib>", "Decoded image memory budget in MiB", String(BOARD_EXPORT_IMAGE_MEMORY_MIB))
    .option("--no-images", "Draw placeholders instead of downloading images")
    .option("--renderer <renderer>", "auto draws in Node and uses local Chrome for shaders; canvas or gpu forces one", "auto")
    .option("--force", "Replace existing output files")
    .option("--timeout <time>", "Fail a frame that takes longer, naming the scripts still running", "2m")
    .option("--async", "Run as a Task in the Space's sandbox and return at once; paths are Space paths"))
    .addHelpText("after", `
Shaders draw in a shared headless Chrome that stays up a few minutes between calls;
Boards without shaders never start it. Set COHUB_BOARD_GPU_DAEMON=0 to start one per call.

Examples:
  cohub boards export plan.board -o plan.png
  cohub boards export plan.board --animation intro --at 0:20s:40ms -o intro.mp4 --async
  cohub boards export plan.board --frame s2 -o slide-2.png
  cohub boards export plan.board --animation lecture --at 4.5s -o moment.png
  cohub boards export plan.board --animation lecture --at 0:6s:40ms -o frames/%04d.png

Scripts see the exported area as their view (viewchange), and emit() between them is
delivered within the same moment, in document order. --frame draws the frame as a
page: its fill and shaders, without its outline and label.`)
    .action(async (target: string, options: ExportOptions) => {
      if (options.async) return runExportTask(boards, options);
      const controller = new AbortController();
      const cancel = () => controller.abort(new Error("Export cancelled."));
      process.once("SIGINT", cancel);
      try {
        const out = options.out as string;
        const times = options.at ? parseBoardTimes(options.at) : undefined;
        let camera: { width: number; height: number } | undefined;
        if (options.camera) {
          if (!options.animation || !times) throw new Error("--camera needs --animation and --at.");
          camera = parseSize(options.size ?? "1600x900");
        }
        const progress = (completed: number, total: number) => {
          if (!jsonRequested(options) && (completed === total || completed % 30 === 0)) process.stderr.write(`Rendered ${completed}/${total} frames\n`);
        };
        const imageMemoryMiB = parseNumber(options.imageMemory ?? String(BOARD_EXPORT_IMAGE_MEMORY_MIB), "--image-memory", { min: 1, max: 65536, integer: true });
        const onPlan = ({ width, height, frames }: { width: number; height: number; frames: number }) => {
          if (!jsonRequested(options)) process.stderr.write(`Rendering ${width}x${height}, ${frames} frame(s)\n`);
        };
        const pathVideoFormat = videoFormatFromPath(out);
        const requestedFormat = options.format?.toLowerCase();
        if (requestedFormat && ![...BOARD_EXPORT_FORMATS, ...BOARD_VIDEO_FORMATS].includes(requestedFormat as BoardNodeExportFormat | BoardVideoExportFormat)) throw new Error(`--format must be one of ${[...BOARD_EXPORT_FORMATS, ...BOARD_VIDEO_FORMATS].join(", ")}.`);
        const videoFormat = requestedFormat
          ? BOARD_VIDEO_FORMATS.includes(requestedFormat as BoardVideoExportFormat) ? requestedFormat as BoardVideoExportFormat : null
          : pathVideoFormat;
        const sequence = (times?.length ?? 0) > 1;
        if (sequence && !videoFormat && !/%0?\d*d/.test(out)) throw new Error("A range needs %d in --out, e.g. frames/%04d.png.");
        if (videoFormat) {
          if (!times || times.length < 2) throw new Error("Video export needs an --at range.");
          const step = (times[1] as number) - (times[0] as number);
          const fps = options.fps ? parseNumber(options.fps, "--fps", { min: 0.01, max: 240 }) : 1000 / step;
          if (existsSync(out) && !options.force) throw new Error(`${out} already exists; use --force to replace it.`);
          await mkdir(dirname(out), { recursive: true });
          const { runBoardVideoExport } = await import("../board-export.js");
          const result = await runBoardVideoExport({
            spaceId: await resolveSpace(boards),
            target,
            camera,
            timeoutMs: parseBoardTime(options.timeout ?? "2m", "--timeout"),
            onProgress: progress,
            onPlan,
            imageMemoryMiB,
            signal: controller.signal,
            force: options.force,
            region: parseExportRegion(options),
            times,
            ...(options.animation ? { animation: options.animation } : {}),
            scale: parseNumber(options.scale ?? "2", "--scale", { min: 0.01, max: 16 }),
            ...(options.padding === undefined ? {} : { padding: parseNumber(options.padding, "--padding", { min: 0 }) }),
            theme: parseChoice(options.theme, "--theme", BOARD_THEME_IDS),
            background: parseChoice(options.paper, "--paper", ["paper", "transparent"] as const),
            format: videoFormat,
            fps,
            output: out,
            quality: parseNumber(options.quality ?? "0.92", "--quality", { min: 0, max: 1 }),
            withImages: options.images !== false,
            renderer: parseChoice(options.renderer, "--renderer", BOARD_EXPORT_RENDERERS),
          });
          if (jsonRequested(options)) return outJson({ file: out, ...result });
          ok(`Exported ${result.width}×${result.height} ${videoFormat.toUpperCase()} to ${out}`);
          for (const warning of result.warnings) console.log(`  ! ${warning}`);
          return;
        }
        const written: Array<{ path: string; time: number | null; width: number; height: number; bytes: number }> = [];
        for (let index = 0; index < (times?.length ?? 1); index++) {
          const path = sequence ? framePath(out, index) : out;
          if (!options.force && existsSync(path)) throw new Error(`${path} already exists; use --force to replace it.`);
        }
        const { runBoardExport } = await import("../board-export.js");
        const result = await runBoardExport({
          spaceId: await resolveSpace(boards),
          target,
          camera,
          timeoutMs: parseBoardTime(options.timeout ?? "2m", "--timeout"),
          onProgress: progress,
          onPlan,
          imageMemoryMiB,
          signal: controller.signal,
          onFrame: async (frame, index) => {
            const path = sequence ? framePath(out, index) : out;
            await mkdir(dirname(path), { recursive: true });
            await writeBoardOutput(path, frame.bytes, Boolean(options.force));
            written.push({ path, time: frame.time, width: frame.width, height: frame.height, bytes: frame.bytes.length });
          },
          region: parseExportRegion(options),
          ...(times ? { times } : {}),
          ...(options.animation ? { animation: options.animation } : {}),
          scale: parseNumber(options.scale ?? "2", "--scale", { min: 0.01, max: 16 }),
          ...(options.padding === undefined ? {} : { padding: parseNumber(options.padding, "--padding", { min: 0 }) }),
          theme: parseChoice(options.theme, "--theme", BOARD_THEME_IDS),
          background: parseChoice(options.paper, "--paper", ["paper", "transparent"] as const),
          format: parseExportFormat(options, out),
          quality: parseNumber(options.quality ?? "0.92", "--quality", { min: 0, max: 1 }),
          withImages: options.images !== false,
          renderer: parseChoice(options.renderer, "--renderer", BOARD_EXPORT_RENDERERS),
        });
        if (!result) return error("Nothing to export: the region contains no items.");
        if (jsonRequested(options)) return outJson({ files: written, warnings: result.warnings });
        const first = written[0];
        if (first) {
          const what = sequence ? `${written.length} frames` : parseExportFormat(options, out).toUpperCase();
          ok(`Exported ${first.width}×${first.height} ${what} to ${sequence ? dirname(out) || "." : out}`);
        }
        for (const warning of result.warnings) console.log(`  ! ${warning}`);
      } catch (cause) {
        handleHttp(cause);
      } finally {
        process.removeListener("SIGINT", cancel);
      }
    });
}

function registerSimulateCommand(boards: Command): void {
  withJson(boards.command("simulate <board> [steps]")
    .description("Run a Board's scripts locally through input steps; nothing is saved")
    .option("-i, --input <file>", "Steps JSON; - for stdin")
    .option("-o, --out <file>", "Also render the result, screen UI included; the extension picks the format")
    .option("--follower", "Simulate an editor that does not write autonomous commits")
    .option("--timeout <time>", "Give up after this long and report what is still running", "2m")
    .option("--frame <item-id>", "Render one frame")
    .option("--items <ids>", "Render comma-separated item ids")
    .option("--rect <rect>", "Render a world rect as x,y,width,height")
    .option("--scale <factor>", "Output pixels per board unit", "2")
    .option("--theme <name>", `Cohub theme: ${BOARD_THEME_IDS.join(", ")}`, "dark")
    .option("--no-images", "Draw placeholders instead of downloading images")
    .option("--force", "Replace an existing output file"))
    .addHelpText("after", `
Steps are {"steps": [...]}, points in board coordinates, run on a virtual clock:
  {"wait": "500ms"}  {"tool": "draw"}  {"tap": [x, y]}  {"drag": [[x, y], ...], "pointerType": "pen"}
  {"pointer": "down", "at": [x, y]}  {"key": "Enter"}  {"select": ["id"]}

Shaders are compiled with a local Chrome, Chromium or Edge when one is found, before
the steps run; their errors join the scripts' errors and stop the run.
Each tap and drag reports where it landed (a script's hit region, a selection handle,
an item, or empty board) and what took it (a script, move, resize, rotate, select box).

Examples:
  cohub boards simulate farm.board '{"steps":[{"wait":"2s"}]}' -o farm.png
  cohub boards simulate farm.board -i steps.json --json`)
    .action(async (target: string, inline: string | undefined, options: ExportOptions & { input?: string; follower?: boolean; timeout?: string }) => {
      try {
        if (inline !== undefined && options.input !== undefined) throw new Error("Pass steps inline or with --input, not both.");
        const input = inline !== undefined
          ? parseBoardJsonObject(inline, "steps")
          : options.input !== undefined ? await readBoardJsonObject(options.input) : { steps: [] };
        const { parseBoardSimulationSteps, runBoardSimulation } = await import("../board-simulate.js");
        const steps = parseBoardSimulationSteps(input.steps);
        const out = options.out;
        if (out && !options.force && existsSync(out)) throw new Error(`${out} already exists; use --force to replace it.`);
        const result = await runBoardSimulation({
          spaceId: await resolveSpace(boards),
          target,
          steps,
          leader: !options.follower,
          timeoutMs: parseBoardTime(options.timeout ?? "2m", "--timeout"),
          ...(out ? { image: {
            region: parseExportRegion(options),
            scale: parseNumber(options.scale ?? "2", "--scale", { min: 0.01, max: 16 }),
            theme: parseChoice(options.theme, "--theme", BOARD_THEME_IDS),
            format: parseExportFormat(options, out),
            withImages: options.images !== false,
          } } : {}),
        });
        if (out && result.image) {
          await mkdir(dirname(out), { recursive: true });
          await writeBoardOutput(out, result.image.bytes, Boolean(options.force));
        }
        const { image, ...summary } = result;
        if (jsonRequested(options)) return outJson({ ...summary, ...(out && image ? { file: out, width: image.width, height: image.height } : {}) });
        const changed = Object.keys((result.changes as { items?: object }).items ?? {}).length;
        ok(`Simulated ${formatBoardTime(result.time)}: ${result.commits} commit${result.commits === 1 ? "" : "s"}, ${changed} item${changed === 1 ? "" : "s"} changed (not saved)`);
        for (const press of result.presses) console.log(`  step ${press.step + 1}: ${describePress(press)}`);
        for (const [id, message] of Object.entries(result.errors)) console.log(`  ! ${id}: ${message.split("\n")[0]}`);
        for (const warning of result.warnings) console.log(`  ! ${warning}`);
        if (result.shaders && !result.shaders.compiled)
          console.log("  Shaders were checked but not compiled; install Chrome, Chromium or Edge, or set COHUB_CHROME, to compile them.");
        if (out && image) console.log(`  Rendered ${image.width}×${image.height} to ${out}`);
        else if (out) console.log("  ! Nothing to render: the region contains no items.");
      } catch (cause) {
        handleHttp(cause);
      }
    });
}

function describePress({ down, taken }: { down: { on: string; owner?: string; target?: string; handle?: string; id?: string; type?: string; under?: string }; taken: string }): string {
  const where = down.on === "script" ? `script ${down.owner}/${down.target}`
    : down.on === "handle" ? `${down.handle} handle`
    : down.on === "item" ? `${down.type} ${down.id}`
    : `empty board${down.under ? ` over ${down.under}` : ""}`;
  return `pressed on ${where}, taken by ${taken}`;
}

function registerProfileCommand(boards: Command): void {
  withJson(boards.command("profile <board>")
    .description("Measure what a Board costs to draw, shader by shader, and say what to change")
    .option("--at <time>", "A moment of --animation, or a script time without one", "2s")
    .option("--animation <id>", "Animation --at refers to")
    .option("--frame <item-id>", "Profile one frame")
    .option("--items <ids>", "Profile comma-separated item ids")
    .option("--rect <rect>", "Profile a world rect as x,y,width,height")
    .option("--size <widthxheight>", "Fit the region into this many pixels, like a screen", "1600x900")
    .option("--frames <count>", "Frames to time per measurement", "5")
    .option("--rounds <count>", "Measurements per shader owner; reports their median and range", "3")
    .option("--budget <time>", "Time the measurements may take; past it, size and frames go down", "60s")
    .option("--no-images", "Draw placeholders instead of downloading images"))
    .addHelpText("after", `
Draws in a headless Chrome; without a GPU it uses software WebGL (reported as
"software"), so compare the numbers with each other rather than with a real display.
Scripts receive the profiled view as viewchange, as on a screen of --size.

Examples:
  cohub boards profile demo.board
  cohub boards profile demo.board --rect 0,0,1600,900 --at 8s --json`)
    .action(async (target: string, options: ExportOptions & { frames?: string; rounds?: string; budget?: string }) => {
      try {
        const { profileBoard } = await import("../board-profile.js");
        const profile = await profileBoard({
          spaceId: await resolveSpace(boards),
          target,
          time: parseBoardTime(options.at ?? "2s", "--at"),
          ...(options.animation ? { animation: options.animation } : {}),
          region: parseExportRegion(options),
          size: parseSize(options.size ?? "1600x900"),
          frames: parseNumber(options.frames ?? "5", "--frames", { min: 3, max: 240, integer: true }),
          rounds: parseNumber(options.rounds ?? "3", "--rounds", { min: 1, max: 20, integer: true }),
          budgetMs: parseBoardTime(options.budget ?? "60s", "--budget"),
          withImages: options.images !== false,
        });
        if (jsonRequested(options)) return outJson(profile);
        const ms = (value: number) => `${value.toFixed(1)} ms`;
        ok(`${profile.width}×${profile.height} on ${profile.gpu} WebGL (${profile.renderer}): ${ms(profile.frame.p50)} a frame (p95 ${ms(profile.frame.p95)}), ${profile.items} items`);
        if (profile.reduced)
          console.log(`  ! ${profile.reduced.width}×${profile.reduced.height} × ${profile.reduced.frames} frames took ${ms(profile.reduced.frameMs)} a frame, past the budget; measured ${profile.width}×${profile.height} × ${profile.frames} frames instead.`);
        console.log(`  ${profile.rounds} round${profile.rounds === 1 ? "" : "s"} × ${profile.frames} frames in ${(profile.elapsedMs / 1000).toFixed(1)} s; owner cost is the median, with the range across rounds`);
        for (const owner of profile.owners) {
          const traits = [owner.filter !== "none" && `filter ${owner.filter}`, owner.sprites && `${owner.sprites} sprites`, owner.state && `state ${owner.state.width}×${owner.state.height}`].filter(Boolean);
          const range = profile.rounds > 1 ? ` (${owner.range[0].toFixed(0)}–${owner.range[1].toFixed(0)})` : "";
          console.log(`  ${owner.id.padEnd(24)} ${ms(owner.ms).padStart(9)}${range.padEnd(12)}${traits.length ? `  ${traits.join(", ")}` : ""}`);
        }
        for (const hint of profile.hints) console.log(`  ! ${hint}`);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  boards.command("gpu-daemon", { hidden: true })
    .requiredOption("--browser <path>")
    .action(async (options: { browser: string }) => {
      const { serveBoardGpu } = await import("../board-gpu/daemon.js");
      await serveBoardGpu(options.browser);
    });
}

// ─── Commands ────────────────────────────────────────────────────────────────

export function registerBoards(program: Command): Command {
  const boards = program
    .command("boards")
    .description("Read, write, animate and export Boards (by id or .board path)")
    .addHelpText("after", `
A Board is one JSON document: { board, items, animations }.
  get       read it
  apply     write it with a JSON Merge Patch; null deletes
  schema    the fields of any part and what they mean; also the script API
  examples  starter documents and a custom script module
  preset    tracks for a preset motion, ready to apply
  sequence  join chapter animations into one timeline
  path      sample a polyline into a position track
  inspect   measure items and report layout hints
  frames    the frames viewers step through, in order
  export    render an image, a frame sequence or a video
  play      shared playback; also pause, resume, next, seek, stop
  watch     stream changes and playback
  history   list versions, or restore one
  diff      what changed between two versions
Times are milliseconds; 500ms, 12.5s and 2m also work on the command line.`);

  withJson(boards.command("create <path>")
    .description("Create a Board file, optionally with an initial document")
    .option("--title <title>", "Board title")
    .option("-i, --input <file>", "Initial document JSON; - for stdin")
    .option("--mutation-id <id>", "Stable id for safe retries"))
    .addHelpText("after", `
  cohub boards examples lesson > lesson.json
  cohub boards create lesson.board -i lesson.json`)
    .action(async (path: string, options: JsonOptions & { title?: string; input?: string; mutationId?: string }) => {
      try {
        const spaceId = await resolveSpace(boards);
        const read = options.input ? await readBoardJsonObject(options.input, BOARD_CREATE_INPUT_MAX_BYTES) : undefined;
        const document = read && await settleBoardPatch(spaceId, read, async () => ({}));
        const input: BoardCreateInput = {
          path,
          mutationId: options.mutationId ?? randomUUID(),
          ...(options.title ? { title: options.title } : {}),
          ...(document ? { document: document as BoardCreateInput["document"] } : {}),
        };
        const result = await createClient().space(spaceId).boards.create(input);
        if (jsonRequested(options)) return outJson({ path, id: result.id, title: result.title, version: result.version });
        ok(`Created ${path}`);
        table([{ path, id: result.id, title: result.title, version: result.version }], [
          { key: "path", label: "Path" },
          { key: "id", label: "ID" },
          { key: "title", label: "Title" },
          { key: "version", label: "Version" },
        ]);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  boards.command("get <board>")
    .description("Print the Board document as JSON")
    .option("--only <sections>", "board, items, animations (comma-separated)")
    .option("--items <ids>", "Only these items")
    .option("--within <frame-id>", "A frame and everything inside it")
    .option("--rect <rect>", "Items intersecting x,y,width,height")
    .option("--animations <ids>", "Only these animations")
    .option("--limit <n>", "Page size for items")
    .option("--cursor <cursor>", "Continue from a previous page's next")
    .option("--since <version>", "Only the changes after this version; the whole Board when they are unavailable")
    .addHelpText("after", `
  cohub boards get plan.board
  cohub boards get plan.board --within s2
  cohub boards get plan.board --only board
  cohub boards get plan.board --since 12`)
    .action(async (target: string, options: { only?: string; items?: string; within?: string; rect?: string; animations?: string; limit?: string; cursor?: string; since?: string }) => {
      try {
        const only = list(options.only);
        if (only?.some((section) => section !== "board" && section !== "items" && section !== "animations")) throw new Error("--only takes board, items, animations, or a combination.");
        const sections = only ? new Set(only) : null;
        const input: BoardReadInput = {
          ...(only ? { only: only.filter((section): section is NonNullable<BoardReadInput["only"]>[number] => section !== "board") as BoardReadInput["only"] } : {}),
          ...(list(options.items) ? { items: list(options.items) } : {}),
          ...(options.within ? { within: options.within } : {}),
          ...(options.rect ? { rect: parseRect(options.rect) } : {}),
          ...(list(options.animations) ? { animations: list(options.animations) } : {}),
          ...(options.limit ? { limit: parseNumber(options.limit, "--limit", { min: 1, integer: true }) } : {}),
          ...(options.cursor ? { cursor: options.cursor } : {}),
          ...(options.since ? { since: parseNumber(options.since, "--since", { min: 0, integer: true }) } : {}),
        };
        const result = await (await boardClient(boards, target)).get(input);
        if (!sections) return outJson(result);
        outJson({
          id: result.id,
          title: result.title,
          version: result.version,
          updatedAt: result.updatedAt,
          playback: result.playback,
          ...(sections.has("board") ? { board: result.board } : {}),
          ...(sections.has("items") && result.items ? { items: result.items } : {}),
          ...(sections.has("animations") && result.animations ? { animations: result.animations } : {}),
          ...(result.next ? { next: result.next } : {}),
        });
      } catch (cause) {
        handleHttp(cause);
      }
    });

  withJson(boards.command("apply <board> [patch]")
    .description("Merge a patch into the Board: fields merge, null deletes")
    .option("-i, --input <file>", "Patch JSON; - for stdin")
    .option("--replace", "Make the document equal to the input instead of merging")
    .option("--cascade", "Also delete children and tracks of deleted items, and tracks of deleted Board scripts")
    .option("--dry-run", "Validate without writing")
    .option("--base-version <n>", "Fail if the Board moved past this version")
    .option("--mutation-id <id>", "Stable id; retries never apply twice"))
    .addHelpText("after", `
  cohub boards apply plan.board '{"items":{"t1":{"type":"text","props":{"text":"Hi","fontSize":48}}}}'
  cohub boards apply plan.board '{"items":{"t1":{"position":{"x":200}}}}'
  cohub boards apply plan.board '{"items":{"t1":null}}'
  cohub boards preset rise --targets a,b --animation intro | cohub boards apply plan.board -i -`)
    .action(async (target: string, inline: string | undefined, options: JsonOptions & { input?: string; replace?: boolean; cascade?: boolean; dryRun?: boolean; baseVersion?: string; mutationId?: string }) => {
      try {
        const spaceId = await resolveSpace(boards);
        const board = await boardClient(boards, target, spaceId);
        const read = await readPatch(inline, options.input, BOARD_TRANSACTION_INPUT_MAX_BYTES);
        const patch = await settleBoardPatch(spaceId, read, async (items) =>
          options.replace ? {} : board.get({ only: ["items"], items }).then((result) => result.items ?? {}, () => null));
        const result = await board.apply(patch, {
          ...(options.replace ? { replace: true } : {}),
          ...(options.cascade ? { cascade: true } : {}),
          ...(options.dryRun ? { dryRun: true } : {}),
          ...(options.baseVersion === undefined ? {} : { baseVersion: parseNumber(options.baseVersion, "--base-version", { min: 0, integer: true }) }),
          ...(options.mutationId ? { mutationId: options.mutationId } : {}),
        });
        if (jsonRequested(options)) return outJson(result);
        showApplied(result);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  withJson(boards.command("history <board>")
    .description("List Board versions, or restore one")
    .option("--before <version>", "Versions older than this")
    .option("--limit <n>", "Number of versions", "20")
    .option("--restore <version>", "Return the Board to this version as a new write"))
    .action(async (target: string, options: JsonOptions & { before?: string; limit?: string; restore?: string }) => {
      try {
        const board = await boardClient(boards, target);
        if (options.restore !== undefined) {
          const result = await board.restore(parseNumber(options.restore, "--restore", { min: 0, integer: true }));
          if (jsonRequested(options)) return outJson(result);
          return showApplied(result);
        }
        const page = await board.history({
          ...(options.before ? { before: parseNumber(options.before, "--before", { min: 1, integer: true }) } : {}),
          limit: parseNumber(options.limit ?? "20", "--limit", { min: 1, max: 500, integer: true }),
        });
        if (jsonRequested(options)) return outJson(page);
        table(page.transactions.map((transaction) => ({
          version: transaction.version,
          at: transaction.createdAt,
          actor: transaction.source?.via ?? transaction.actorId,
          items: Object.keys(transaction.after?.items ?? {}).length,
          animations: new Set([...Object.keys(transaction.after?.animations ?? {}), ...Object.keys(transaction.after?.tracks ?? {})]).size,
        })), [
          { key: "version", label: "Version" },
          { key: "at", label: "At" },
          { key: "actor", label: "By" },
          { key: "items", label: "Items" },
          { key: "animations", label: "Animations" },
        ]);
        if (page.nextBefore) console.log(`  More: --before ${page.nextBefore}`);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  withJson(boards.command("diff <board>")
    .description("List what changed between two versions, element by element")
    .requiredOption("--from <version>", "The version to compare from")
    .option("--to <version>", "The version to compare to; the latest by default"))
    .addHelpText("after", `
Before rewriting a Board with apply --replace, see what others changed since the version you read:
  cohub boards diff plan.board --from 41
  cohub boards diff plan.board --from 41 --to 44 --json`)
    .action(async (target: string, options: JsonOptions & { from: string; to?: string }) => {
      try {
        const board = await boardClient(boards, target);
        const result = await board.diff(
          parseNumber(options.from, "--from", { min: 0, integer: true }),
          options.to === undefined ? undefined : parseNumber(options.to, "--to", { min: 1, integer: true }),
        );
        if (jsonRequested(options)) return outJson(result);
        const by = new Map<string, number>();
        for (const { kind } of result.versions) by.set(kind, (by.get(kind) ?? 0) + 1);
        ok(`v${result.from} → v${result.to}: ${result.changes.length} element${result.changes.length === 1 ? "" : "s"} changed in ${result.versions.length} version${result.versions.length === 1 ? "" : "s"}${by.size ? ` (${[...by].map(([kind, count]) => `${count} by ${kind}`).join(", ")})` : ""}`);
        const show = (value: unknown) => {
          const text = value === undefined ? "∅" : JSON.stringify(value);
          return text.length > 60 ? `${text.slice(0, 57)}…` : text;
        };
        for (const change of result.changes) {
          const sign = change.change === "added" ? "+" : change.change === "removed" ? "-" : "~";
          const name = change.kind === "board" ? "board" : `${change.kind} ${change.id}${change.type ? ` (${change.type})` : ""}`;
          console.log(`  ${sign} ${name}`);
          for (const field of change.fields.slice(0, 12)) console.log(`      ${field.path}: ${show(field.from)} → ${show(field.to)}`);
          if (change.fields.length > 12) console.log(`      … ${change.fields.length - 12} more fields; --json lists them all`);
        }
      } catch (cause) {
        handleHttp(cause);
      }
    });

  boards.command("schema [target]")
    .description("Print JSON Schema for a part of a Board")
    .option("--field <path>", "Print one field, e.g. props.decoration or props.geometry")
    .addHelpText("after", `
Without a target: units, item types, colors and every animatable property.
With a target: its fields and what they mean; script also lists the module API.
Targets: ${BOARD_SCHEMA_TARGETS.join(", ")}`)
    .action((target: string | undefined, options: { field?: string }) => {
      try {
        if (options.field && !target) throw new Error("--field needs a schema target, e.g. schema frame --field props.decoration.");
        if (!target) return outJson({ ...boardSchemaOverview(), presets: listBoardPresets() });
        const schema = boardJsonSchema(target);
        if (!schema) throw new Error(`Unknown target ${target}; expected ${BOARD_SCHEMA_TARGETS.join(", ")}.`);
        if (options.field) return outJson(boardSchemaField(schema.schema, options.field));
        outJson(target === "script" ? { ...schema, api: BOARD_SCRIPT_API } : schema);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  boards.command("preset <name>")
    .description("Print tracks for a preset motion as a patch for apply")
    .requiredOption("--targets <ids>", "Comma-separated item ids")
    .option("--animation <id>", "Wrap the tracks in this animation; omit to get bare tracks")
    .option("--at <time>", "Start of the first target", "0")
    .option("--stagger <time>", "Delay added per target", "0")
    .option("--duration <time>", "Length of each target's motion")
    .option("--ease <ease>", "CSS easing, e.g. ease-out or cubic-bezier(.2,.8,.2,1)")
    .addHelpText("after", `
Presets: ${BOARD_PRESET_NAMES.join(", ")}
  cohub boards preset rise --targets a,b,c --animation intro --stagger 120ms | cohub boards apply plan.board -i -
  cohub boards preset float --targets ship | jq -c '{animations:{idle:.}}' | cohub boards apply plan.board -i -`)
    .action((name: string, options: { targets: string; animation?: string; at: string; stagger: string; duration?: string; ease?: string }) => {
      try {
        if (!isBoardPresetName(name)) throw new Error(`Unknown preset ${name}; expected ${BOARD_PRESET_NAMES.join(", ")}.`);
        const targets = list(options.targets);
        if (!targets) throw new Error("--targets needs at least one item id.");
        const tracks = boardPresetTracks(name, {
          targets,
          at: parseBoardTime(options.at, "--at"),
          stagger: parseBoardTime(options.stagger, "--stagger"),
          ...(options.duration ? { duration: parseBoardTime(options.duration, "--duration") } : {}),
          ...(options.ease ? { ease: options.ease } : {}),
        });
        outJson(options.animation ? { animations: { [options.animation]: { tracks } } } : { tracks });
      } catch (cause) {
        handleHttp(cause);
      }
    });

  registerBoardExampleCommands(boards);
  registerExportCommand(boards);
  registerSimulateCommand(boards);
  registerProfileCommand(boards);
  registerBoardAuthoringCommands(boards);
  registerPlaybackCommands(boards);

  withJson(boards.command("watch <board>")
    .description("Stream Board changes and playback as they happen"))
    .action(async (target: string, options: JsonOptions) => {
      try {
        const spaceId = await resolveSpace(boards);
        const client = createRealtimeClient();
        const board = await client.space(spaceId).boards.open(target);
        const boardId = board.id;
        if (!jsonRequested(options)) process.stderr.write(`Watching Board ${boardId}…\n`);
        const offConnection = client.onConnection((state) => {
          if (jsonRequested(options)) process.stdout.write(`${JSON.stringify({ type: "connection", ...state })}\n`);
          else process.stderr.write(`${state.state}${state.state === "reconnecting" && state.attempt ? ` (attempt ${state.attempt})` : ""}\n`);
        });
        const offBoard = board.subscribe({
          event(event) {
            if (jsonRequested(options)) {
              process.stdout.write(`${JSON.stringify(event)}\n`);
              return;
            }
            if (event.type === "board.changed") {
              const { changed } = event.payload;
              process.stdout.write(`version ${event.payload.version}  ${[changed.board ? "board" : "", ...changed.items, ...changed.animations].filter(Boolean).join(", ")}\n`);
            } else if (event.type === "board.playback.changed") {
              const { playback } = event.payload;
              process.stdout.write(playback ? `${playback.status}  ${playback.animationId}  ${formatBoardTime(Math.round(playback.position))}\n` : "stopped\n");
            }
          },
        });
        process.once("SIGINT", () => {
          offBoard();
          offConnection();
          process.exit(0);
        });
      } catch (cause) {
        handleHttp(cause);
      }
    });

  return boards;
}

function registerPlaybackCommands(boards: Command): void {
  const run = async (target: string, options: JsonOptions, command: (board: Awaited<ReturnType<typeof boardClient>>) => Promise<BoardPlaybackSnapshot | null>) => {
    try {
      const playback = await command(await boardClient(boards, target));
      if (jsonRequested(options)) return outJson({ playback });
      showPlayback(playback);
    } catch (cause) {
      handleHttp(cause);
    }
  };

  withJson(boards.command("play <board> <animation>")
    .description("Play an animation for everyone viewing the Board")
    .option("--at <time>", "Start position, e.g. 2.5s")
    .option("--speed <factor>", "Playback speed, up to 4")
    .option("--seed <seed>", "Seed for procedural effects"))
    .action((target: string, animation: string, options: JsonOptions & { at?: string; speed?: string; seed?: string }) =>
      run(target, options, (board) => board.play(animation, {
        ...(options.at ? { position: parseBoardTime(options.at, "--at") } : {}),
        ...(options.speed ? { timeScale: parseNumber(options.speed, "--speed", { min: Number.EPSILON, max: 4 }) } : {}),
        ...(options.seed ? { seed: options.seed } : {}),
      })));

  withJson(boards.command("pause <board>").description("Pause playback")).action((target: string, options: JsonOptions) => run(target, options, (board) => board.pause()));
  withJson(boards.command("resume <board>").description("Resume paused playback")).action((target: string, options: JsonOptions) => run(target, options, (board) => board.resume()));
  withJson(boards.command("seek <board> <time>").description("Move the playhead, e.g. 12.5s"))
    .action((target: string, time: string, options: JsonOptions) => run(target, options, (board) => board.seek(parseBoardTime(time))));
  withJson(boards.command("next <board>").description("Continue past the marker a presentation holds at")).action((target: string, options: JsonOptions) => run(target, options, (board) => board.next()));
  withJson(boards.command("stop <board>").description("Stop playback")).action((target: string, options: JsonOptions) => run(target, options, (board) => board.stop()));
}
