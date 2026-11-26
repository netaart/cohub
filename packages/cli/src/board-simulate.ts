import { hasBoardScripts } from "@neta-art/cohub/board";
import type { BoardDocument, BoardMediaState, BoardScriptCamera } from "@neta-art/cohub/board";
import { loadBoardDocument } from "./board-document.js";
import { openBoardBrowser } from "./board-browser/daemon.js";
import {
  BOARD_EXPORT_FRAME_TIMEOUT_MS,
  type BoardExportFrame,
  type BoardExportRunOptions,
  boardBrowserResources,
  describeFrameWarning,
  readSpaceFileBytes,
  runBoardExport,
} from "./board-export.js";
import { BOARD_EXPORT_IMAGE_MEMORY_MIB, BOARD_GPU_EXPORT_MAX_PIXELS } from "./board-export-resources.js";
import type { BoardMediaFiles } from "./board-media-export.js";
import { settleBoardDocument } from "./board-media.js";
import { BOARD_SIMULATION_VIEWPORT } from "./board-simulation-options.js";
import {
  BOARD_SIMULATION_TIMEOUT_MS,
  type BoardSimulation,
  type BoardSimulationRender,
  type BoardSimulationResult,
  type BoardSimulationSpec,
  boardSimulationRecordings,
  simulateBoard,
} from "./board-simulation.js";
import { createClient } from "./client.js";

export type BoardSimulationDrawing = {
  render: BoardSimulationRender;
  options: Pick<BoardExportRunOptions, "region" | "scale" | "theme" | "background" | "quality" | "withImages" | "imageMemoryMiB" | "renderer" | "screen" | "timeoutMs">;
  format: BoardExportFrame["format"];
  mediaFiles?: BoardMediaFiles;
  onFrame(frame: BoardExportFrame): Promise<void>;
};

export type BoardSimulationRun = BoardSimulationResult & {
  drawn?: { media: Array<{ at: number; media: BoardMediaState[] }>; warnings: string[] } | null;
};

export async function runBoardSimulation(options: {
  spaceId: string;
  target: string;
  simulation: BoardSimulation;
  leader: boolean;
  view?: BoardScriptCamera;
  timeoutMs?: number;
  signal?: AbortSignal;
  drawing?: BoardSimulationDrawing;
  document?: BoardDocument;
}): Promise<BoardSimulationRun> {
  const client = createClient();
  const { drawing } = options;
  const document: BoardDocument = options.document ?? await settleBoardDocument(options.spaceId, (await loadBoardDocument(options.spaceId, options.target)).document);
  const spec: BoardSimulationSpec = {
    steps: options.simulation.steps,
    viewport: options.simulation.viewport ?? BOARD_SIMULATION_VIEWPORT,
    leader: options.leader,
    ...(options.simulation.mode ? { mode: options.simulation.mode } : {}),
    ...(options.simulation.pointer ? { pointer: options.simulation.pointer } : {}),
    ...(options.view ? { view: options.view } : {}),
    ...(drawing ? { render: drawing.render } : {}),
  };
  const recordings = Object.fromEntries(await Promise.all(boardSimulationRecordings(spec.steps).map(async (path) =>
    [path, new TextDecoder().decode((await readSpaceFileBytes(client, options.spaceId, path)).bytes)] as const)));
  const timeoutMs = options.timeoutMs ?? BOARD_SIMULATION_TIMEOUT_MS;
  if (hasBoardScripts(document)) {
    if (drawing?.options.renderer === "canvas") throw new Error("Board scripts run in a browser; drop --renderer canvas.");
    const browser = await openBoardBrowser(boardBrowserResources(options.spaceId, document), { signal: options.signal });
    const media: Array<{ at: number; media: BoardMediaState[] }> = [];
    const warnings = new Set<string>();
    try {
      const result = await browser.simulate({
        ...spec,
        document,
        theme: drawing?.options.theme ?? "dark",
        timeoutMs,
        recordings,
        ...(drawing ? {
          frame: {
            region: drawing.options.region,
            scale: drawing.options.scale,
            background: drawing.options.background,
            format: drawing.format,
            ...(drawing.options.quality === undefined ? {} : { quality: drawing.options.quality }),
            withImages: drawing.options.withImages,
            imageMemory: (drawing.options.imageMemoryMiB ?? BOARD_EXPORT_IMAGE_MEMORY_MIB) * 1024 ** 2,
            maxPixels: BOARD_GPU_EXPORT_MAX_PIXELS,
            timeoutMs: drawing.options.timeoutMs ?? BOARD_EXPORT_FRAME_TIMEOUT_MS,
            ...(drawing.options.screen ? { screen: true } : {}),
          },
        } : {}),
      }, async (info, bytes) => {
        media.push({ at: info.time ?? 0, media: info.media });
        for (const warning of info.warnings) warnings.add(describeFrameWarning(warning, drawing?.options.withImages ?? false));
        await drawing?.onFrame({ time: info.time, bytes, width: info.width, height: info.height, scale: info.scale, itemCount: info.itemCount, format: drawing.format });
      });
      return { ...result, ...(drawing ? { drawn: media.length ? { media, warnings: [...warnings] } : null } : {}) };
    } finally {
      await browser.close();
    }
  }
  if (!drawing) return simulateBoard({ document, spec, recordings, timeoutMs });
  let result: BoardSimulationResult | null = null;
  const drawn = await runBoardExport({
    ...drawing.options,
    spaceId: options.spaceId,
    target: options.target,
    document,
    format: drawing.format,
    viewport: spec.viewport,
    timeoutMs: drawing.options.timeoutMs ?? BOARD_EXPORT_FRAME_TIMEOUT_MS,
    ...(drawing.render.camera ? { camera: drawing.render.size ?? spec.viewport } : {}),
    ...(options.view ? { view: options.view } : {}),
    ...(drawing.render.times ? { times: drawing.render.times } : {}),
    ...(drawing.mediaFiles ? { mediaFiles: drawing.mediaFiles } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    onFrame: (frame) => drawing.onFrame(frame),
    drive: async (draw) => {
      result = await simulateBoard({
        document, spec, recordings, timeoutMs,
        capture: (shot) => draw(shot.time, { document: shot.document, ...(shot.view ? { view: shot.view } : {}) }),
      });
    },
  });
  if (!result) throw new Error("The simulation did not run.");
  return { ...(result as BoardSimulationResult), drawn };
}
