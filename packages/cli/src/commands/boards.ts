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
  type BoardExportRegion,
  boardJsonSchema,
  boardPresetTracks,
  boardSchemaOverview,
  isBoardPresetName,
  listBoardPresets,
} from "@neta-art/cohub/board";
import type { BoardHeadlessExportFormat } from "@neta-art/cohub/board/headless";
import type { Command } from "commander";
import {
  BOARD_CREATE_INPUT_MAX_BYTES,
  BOARD_TRANSACTION_INPUT_MAX_BYTES,
  parseBoardJsonObject,
  readBoardJsonObject,
  resolveBoardId,
  writeBoardOutput,
} from "../board-command-support.js";
import { formatBoardTime, parseBoardTime, parseBoardTimes } from "../board-time.js";
import { createClient, createRealtimeClient } from "../client.js";
import { error, handleHttp, json as outJson, jsonRequested, ok, table } from "../output.js";
import { resolveSpace } from "../space.js";
import { registerBoardExampleCommands } from "./boards/examples.js";

type JsonOptions = { json?: boolean };

export const parseJsonObject = parseBoardJsonObject;

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

async function boardClient(boards: Command, target: string) {
  const spaceId = await resolveSpace(boards);
  return createClient().space(spaceId).board(await resolveBoardId(spaceId, target));
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
  fps?: string;
  force?: boolean;
};

/** One region flag at most: being told to pick beats guessing which one wins. */
function parseExportRegion(options: ExportOptions): BoardExportRegion {
  const chosen = [options.frame && "--frame", options.items && "--items", options.rect && "--rect"].filter(Boolean);
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

const BOARD_EXPORT_FORMATS: BoardHeadlessExportFormat[] = ["png", "jpeg", "webp"];
const BOARD_VIDEO_FORMATS = ["mp4", "webm"] as const;

type BoardVideoExportFormat = (typeof BOARD_VIDEO_FORMATS)[number];

function videoFormatFromPath(path: string): BoardVideoExportFormat | null {
  const lower = path.toLowerCase();
  return lower.endsWith(".webm") ? "webm" : lower.endsWith(".mp4") ? "mp4" : null;
}


function formatFromPath(path: string): BoardHeadlessExportFormat {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "jpeg";
  if (lower.endsWith(".webp")) return "webp";
  return "png";
}

function parseExportFormat(options: ExportOptions, outPath: string): BoardHeadlessExportFormat {
  if (!options.format) return formatFromPath(outPath);
  const format = options.format.toLowerCase() as BoardHeadlessExportFormat;
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
    .option("--at <time>", "A moment (12.5s) or a range start:end:step (0:10s:100ms)")
    .option("--animation <id>", "Animation the --at times refer to")
    .option("--frame <item-id>", "Export one frame as a page")
    .option("--items <ids>", "Comma-separated item ids")
    .option("--rect <rect>", "World rect as x,y,width,height")
    .option("--scale <factor>", "Output pixels per board unit", "2")
    .option("--padding <units>", "Padding around the content in board units")
    .option("--theme <mode>", "dark or light", "dark")
    .option("--paper <mode>", "Output paper: paper or transparent", "paper")
    .option("--format <format>", `Override the format (${BOARD_EXPORT_FORMATS.join(", ")}, ${BOARD_VIDEO_FORMATS.join(", ")})`)
    .option("--quality <q>", "JPEG/WebP quality from 0 to 1", "0.92")
    .option("--fps <rate>", "Video frame rate; defaults to the --at step")
    .option("--no-images", "Draw placeholders instead of downloading images")
    .option("--force", "Replace existing output files"))
    .addHelpText("after", `
Examples:
  cohub boards export plan.board -o plan.png
  cohub boards export plan.board --frame s2 -o slide-2.png
  cohub boards export plan.board --animation lecture --at 4.5s -o moment.png
  cohub boards export plan.board --animation lecture --at 0:6s:40ms -o frames/%04d.png`)
    .action(async (target: string, options: ExportOptions) => {
      try {
        const out = options.out as string;
        const times = options.at ? parseBoardTimes(options.at) : undefined;
        const pathVideoFormat = videoFormatFromPath(out);
        const requestedFormat = options.format?.toLowerCase();
        if (requestedFormat && ![...BOARD_EXPORT_FORMATS, ...BOARD_VIDEO_FORMATS].includes(requestedFormat as BoardHeadlessExportFormat | BoardVideoExportFormat)) throw new Error(`--format must be one of ${[...BOARD_EXPORT_FORMATS, ...BOARD_VIDEO_FORMATS].join(", ")}.`);
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
            region: parseExportRegion(options),
            times,
            ...(options.animation ? { animation: options.animation } : {}),
            scale: parseNumber(options.scale ?? "2", "--scale", { min: 0.01, max: 16 }),
            ...(options.padding === undefined ? {} : { padding: parseNumber(options.padding, "--padding", { min: 0 }) }),
            colorScheme: parseChoice(options.theme, "--theme", ["dark", "light"] as const),
            background: parseChoice(options.paper, "--paper", ["paper", "transparent"] as const),
            format: videoFormat,
            fps,
            output: out,
            quality: parseNumber(options.quality ?? "0.92", "--quality", { min: 0, max: 1 }),
            withImages: options.images !== false,
          });
          if (jsonRequested(options)) return outJson({ file: out, ...result });
          ok(`Exported ${result.width}×${result.height} ${videoFormat.toUpperCase()} to ${out}`);
          for (const warning of result.warnings) console.log(`  ! ${warning}`);
          return;
        }
        const { runBoardExport } = await import("../board-export.js");
        const result = await runBoardExport({
          spaceId: await resolveSpace(boards),
          target,
          region: parseExportRegion(options),
          ...(times ? { times } : {}),
          ...(options.animation ? { animation: options.animation } : {}),
          scale: parseNumber(options.scale ?? "2", "--scale", { min: 0.01, max: 16 }),
          ...(options.padding === undefined ? {} : { padding: parseNumber(options.padding, "--padding", { min: 0 }) }),
          colorScheme: parseChoice(options.theme, "--theme", ["dark", "light"] as const),
          background: parseChoice(options.paper, "--paper", ["paper", "transparent"] as const),
          format: parseExportFormat(options, out),
          quality: parseNumber(options.quality ?? "0.92", "--quality", { min: 0, max: 1 }),
          withImages: options.images !== false,
        });
        if (!result) return error("Nothing to export: the region contains no items.");
        const written: Array<{ path: string; time: number | null; width: number; height: number; bytes: number }> = [];
        for (const [index, frame] of result.frames.entries()) {
          const path = sequence ? framePath(out, index) : out;
          await mkdir(dirname(path), { recursive: true });
          await writeBoardOutput(path, frame.bytes, Boolean(options.force));
          written.push({ path, time: frame.time, width: frame.width, height: frame.height, bytes: frame.bytes.length });
        }
        if (jsonRequested(options)) return outJson({ files: written, warnings: result.warnings });
        const first = result.frames[0];
        if (first) {
          const what = sequence ? `${written.length} frames` : (first.format ?? "png").toUpperCase();
          ok(`Exported ${first.width}×${first.height} ${what} to ${sequence ? dirname(out) || "." : out}`);
        }
        for (const warning of result.warnings) console.log(`  ! ${warning}`);
      } catch (cause) {
        handleHttp(cause);
      }
    });
}

// ─── Commands ────────────────────────────────────────────────────────────────

export function registerBoards(program: Command): Command {
  const boards = program
    .command("boards")
    .description("Read, write, animate and export Boards (by id or .board path)")
    .addHelpText("after", `
A Board is one JSON document: { board, items, animations }.
  get      read it
  apply    write it with a JSON Merge Patch; null deletes
  schema   the schema of any part, and what tracks can animate
  preset   tracks for a preset motion, ready to apply
  history  list versions, or restore one
  export   render an image, a frame sequence or a video
  examples starter documents
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
        const document = options.input ? await readBoardJsonObject(options.input, BOARD_CREATE_INPUT_MAX_BYTES) : undefined;
        const input: BoardCreateInput = {
          path,
          mutationId: options.mutationId ?? randomUUID(),
          ...(options.title ? { title: options.title } : {}),
          ...(document ? { document: document as BoardCreateInput["document"] } : {}),
        };
        const result = await createClient().space(await resolveSpace(boards)).boards.create(input);
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
    .addHelpText("after", `
  cohub boards get plan.board
  cohub boards get plan.board --within s2
  cohub boards get plan.board --only board`)
    .action(async (target: string, options: { only?: string; items?: string; within?: string; rect?: string; animations?: string; limit?: string; cursor?: string }) => {
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
    .option("--cascade", "Also delete children and tracks of deleted items")
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
        const patch = await readPatch(inline, options.input, BOARD_TRANSACTION_INPUT_MAX_BYTES);
        const result = await (await boardClient(boards, target)).apply(patch, {
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

  boards.command("schema [target]")
    .description("Print JSON Schema for a part of a Board")
    .addHelpText("after", `
With a target: one item type, or animation, track, or camera.
Targets: ${BOARD_SCHEMA_TARGETS.join(", ")}
Without a target: units, item types, colors and every animatable property.`)
    .action((target?: string) => {
      try {
        if (!target) return outJson({ ...boardSchemaOverview(), presets: listBoardPresets() });
        const schema = boardJsonSchema(target);
        if (!schema) throw new Error(`Unknown target ${target}; expected ${BOARD_SCHEMA_TARGETS.join(", ")}.`);
        outJson(schema);
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
  registerPlaybackCommands(boards);

  withJson(boards.command("watch <board>")
    .description("Stream Board changes and playback as they happen"))
    .action(async (target: string, options: JsonOptions) => {
      try {
        const spaceId = await resolveSpace(boards);
        const boardId = await resolveBoardId(spaceId, target);
        const client = createRealtimeClient();
        const board = client.space(spaceId).board(boardId);
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
