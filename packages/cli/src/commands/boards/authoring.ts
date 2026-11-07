import type { Command } from "commander";
import {
  type BoardChapter,
  type BoardRegionDirection,
  type BoardVec2,
  boardFrameRegions,
  boardPathTrack,
  boardPlacePatch,
  boardRegionStep,
  boardSequencePatch,
  buildBoardScene,
  createBoardAnimationSampler,
} from "@neta-art/cohub/board";
import { readBoardJsonObject } from "../../board-command-support.js";
import { loadBoardDocument } from "../../board-document.js";
import { settleBoardDocument, settleBoardMediaDurations } from "../../board-media.js";
import { parseBoardTime, parseBoardTimes } from "../../board-time.js";
import { handleHttp, json as outJson, jsonRequested, table } from "../../output.js";
import { resolveSpace } from "../../space.js";

const DIRECTIONS: readonly BoardRegionDirection[] = ["left", "right", "up", "down"];

export function registerBoardAuthoringCommands(boards: Command) {
  boards
    .command("inspect <board>")
    .description("Measure items and report visible layout hints without changing the Board")
    .option("--animation <id>", "Animation to sample")
    .option("--at <times>", "Time, comma-separated times, or start:end:step (up to 100 samples)", "0")
    .option("--items <ids>", "Limit measurements to comma-separated item ids")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Without --animation, inspects the static document, not playback.
Bounds use world units with x/y at the top left; worldBounds includes rotation.
Checks native layout only, not camera cropping or content drawn inside scripts.
Example: cohub boards inspect lesson.board --animation lecture --at 0:20s:1s --json`)
    .action(async (target: string, options: { animation?: string; at: string; items?: string }) => {
      try {
        const spaceId = await resolveSpace(boards);
        const document = await settleBoardDocument(spaceId, (await loadBoardDocument(spaceId, target)).document);
        const times = parseBoardTimes(options.at, "--at", 100);
        const sampler = options.animation ? createBoardAnimationSampler(document, options.animation) : null;
        const [{ resolveBundledFonts }, { createNodeBoardRenderer, inspectBoardItems }] = await Promise.all([
          import("../../board-export.js"),
          import("../../board-kernel.js"),
        ]);
        const renderer = await createNodeBoardRenderer({ fonts: resolveBundledFonts() });
        try {
          const ids = options.items ? new Set(options.items.split(",")) : null;
          outJson({
            mode: sampler ? "animation" : "static",
            animation: options.animation ?? null,
            coverage: "Native layout in world coordinates; excludes camera cropping and script-drawn content.",
            samples: times.map((time) => ({
              time,
              ...inspectBoardItems(sampler?.at(time).scene ?? buildBoardScene(document), ids ?? undefined),
            })),
          });
        } finally {
          renderer.destroy();
        }
      } catch (cause) {
        handleHttp(cause);
      }
    });

  boards
    .command("frames <board>")
    .description("List the frames viewers step through, in order, and where each arrow leads")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Order follows placement: rows top to bottom, each left to right. Move a frame to
change where it falls. A plain (decoration: none) frame with a label is a page;
without one, the frames inside it count. Frames inside pages do not. Left and right continue in reading order past a row's end.
Viewers step with N, the arrow keys and swipes; #focus=<frame>&present presents.`)
    .action(async (target: string, options: { json?: boolean }) => {
      try {
        const { document } = await loadBoardDocument(await resolveSpace(boards), target);
        const regions = boardFrameRegions(buildBoardScene(document));
        const frames = regions.map((region, index) => ({
          index: index + 1,
          id: region.id,
          label: region.label ?? null,
          rect: region.rect,
          ...Object.fromEntries(DIRECTIONS.map((direction) => [direction, boardRegionStep(regions, region, direction)?.id ?? null])),
        }));
        if (jsonRequested(options)) return outJson({ frames });
        table(frames, [
          { key: "index", label: "#" },
          { key: "id", label: "ID" },
          { key: "label", label: "Label", format: (value) => (value as string | null) ?? "" },
          ...DIRECTIONS.map((direction) => ({ key: direction, label: direction[0]?.toUpperCase() + direction.slice(1), format: (value: unknown) => (value as string | null) ?? "–" })),
        ]);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  boards
    .command("sequence <board>")
    .description("Compile chapters to an apply-ready animation patch; does not write")
    .requiredOption("-i, --input <file>", "JSON with a chapters array; use - for stdin")
    .requiredOption("--animation <id>", "Parent animation id; recompiling replaces its tracks")
    .action(async (target: string, options: { input: string; animation: string }) => {
      try {
        const input = await readBoardJsonObject(options.input);
        if (
          !Array.isArray(input.chapters) ||
          input.chapters.some(
            (chapter) => !chapter || typeof chapter !== "object" || typeof chapter.animation !== "string",
          )
        )
          throw new Error("Input needs a chapters array with animation IDs.");
        const { document } = await loadBoardDocument(await resolveSpace(boards), target);
        outJson(boardSequencePatch(document, options.animation, input.chapters as BoardChapter[]));
      } catch (cause) {
        handleHttp(cause);
      }
    });

  boards
    .command("place <board>")
    .description("Put items or animations on a timeline as clips; prints a patch for apply, does not write")
    .requiredOption("--animation <id>", "Animation to place them in; created when missing")
    .requiredOption("--targets <ids>", "Comma-separated item or animation ids, laid end to end")
    .option("--at <time>", "Where the first one starts", "0")
    .option("--duration <time>", "Length of each; defaults to what is left of the media or animation, else 3s")
    .option("--from <time>", "Where media or an animation starts playing in its own time", "0")
    .option("--rate <number>", "Playback speed of media and animations", "1")
    .option("--together", "Start them all at --at instead of one after another")
    .addHelpText("after", `
Each target is shown only during its clip (a visible track); video, audio and
animations also play (a props.time or time track), and sound in exports while
their time moves forward. Placing a target that is already on the timeline moves it.
  cohub boards place cut.board --animation cut --targets intro,talk,outro | cohub boards apply cut.board -i -
  cohub boards place cut.board --animation cut --targets music --at 0 --duration 30s --from 12s`)
    .action(async (target: string, options: { animation: string; targets: string; at: string; duration?: string; from: string; rate: string; together?: boolean }) => {
      try {
        const targets = options.targets.split(",").map((id) => id.trim()).filter(Boolean);
        if (!targets.length) throw new Error("--targets needs at least one id.");
        const rate = Number(options.rate);
        if (!Number.isFinite(rate) || rate <= 0) throw new Error("--rate must be a positive number.");
        const spaceId = await resolveSpace(boards);
        const { document: loaded } = await loadBoardDocument(spaceId, target);
        const durations = options.duration ? {} : await settleBoardMediaDurations(spaceId, loaded, targets);
        const document = { ...loaded, items: { ...loaded.items, ...durations } };
        const patch = boardPlacePatch(document, options.animation, targets, {
          at: parseBoardTime(options.at, "--at"),
          from: parseBoardTime(options.from, "--from"),
          rate,
          ...(options.duration ? { duration: parseBoardTime(options.duration, "--duration") } : {}),
          together: options.together,
        });
        const items = Object.fromEntries(Object.entries(durations).map(([id, item]) => [id, { props: { snapshot: { durationMs: (item.props as { snapshot?: { durationMs?: number } }).snapshot?.durationMs } } }]));
        outJson(Object.keys(items).length ? { ...patch, items } : patch);
      } catch (cause) {
        handleHttp(cause);
      }
    });

  boards
    .command("path <target>")
    .description("Sample a polyline into a position track; does not write")
    .requiredOption("-i, --input <file>", "JSON with points, duration (ms), optional at, samples and orient")
    .action(async (target: string, options: { input: string }) => {
      try {
        const input = await readBoardJsonObject(options.input);
        if (!Array.isArray(input.points) || input.points.some((point) => !point || typeof point !== "object"))
          throw new Error("Input needs a points array.");
        if (typeof input.duration !== "number") throw new Error("Input needs duration in milliseconds.");
        if (input.orient !== undefined && typeof input.orient !== "boolean") throw new Error("orient must be boolean.");
        outJson(
          boardPathTrack(target, input.points as BoardVec2[], {
            duration: input.duration,
            ...(input.at === undefined ? {} : { at: Number(input.at) }),
            ...(input.samples === undefined ? {} : { samples: Number(input.samples) }),
            orient: input.orient as boolean | undefined,
          }),
        );
      } catch (cause) {
        handleHttp(cause);
      }
    });
}
