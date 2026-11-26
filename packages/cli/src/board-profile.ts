import { type BoardDocument, type BoardExportRegion, boardModelFormat } from "@neta-art/cohub/board";
import { loadBoardDocument } from "./board-document.js";
import { boardBrowserResources } from "./board-export.js";
import { openBoardBrowser } from "./board-browser/daemon.js";
import type { BoardBrowserProfile } from "./board-browser/index.js";
import { BOARD_EXPORT_IMAGE_MEMORY_MIB } from "./board-export-resources.js";
import { buildBoardScene, planBoardExport } from "./board-kernel.js";
import { settleBoardDocument } from "./board-media.js";

const LARGE_OWNER = 4000;
const LARGE_STATE = 512 * 512;
const MANY_EFFECTS = 16;
const LARGE_MODEL = 8 * 1024 ** 2;

const FRAME_60_MS = 1000 / 60;
const FRAME_30_MS = 1000 / 30;
const HEAVY_STEP_MS = 4;

export type BoardProfile = BoardBrowserProfile & { hints: string[] };

export async function profileBoard(options: {
  spaceId: string;
  target: string;
  time: number;
  animation?: string;
  region: BoardExportRegion;
  size: { width: number; height: number };
  frames: number;
  rounds: number;
  budgetMs: number;
  withImages: boolean;
  document?: BoardDocument;
}): Promise<BoardProfile> {
  const document = options.document ?? await settleBoardDocument(options.spaceId, (await loadBoardDocument(options.spaceId, options.target)).document);
  if (options.animation && !document.animations[options.animation]) throw new Error(`Animation ${options.animation} does not exist.`);
  const plan = planBoardExport({ scene: buildBoardScene(document), region: options.region, scale: 1, padding: 0 });
  if (!plan) throw new Error("Nothing to profile: the region contains no items.");
  const scale = Math.min(options.size.width / plan.world.width, options.size.height / plan.world.height);
  const browser = await openBoardBrowser(boardBrowserResources(options.spaceId, document));
  try {
    await browser.init({ document, animation: options.animation ?? null, theme: "dark" });
    const profile = await browser.profile({
      time: options.time,
      region: options.region,
      scale,
      frames: options.frames,
      rounds: options.rounds,
      budgetMs: options.budgetMs,
      withImages: options.withImages,
      imageMemory: BOARD_EXPORT_IMAGE_MEMORY_MIB * 1024 ** 2,
    });
    return { ...profile, hints: boardProfileHints(document, profile) };
  } finally {
    await browser.close();
  }
}

export function boardProfileHints(document: BoardDocument, profile: BoardBrowserProfile): string[] {
  const hints: string[] = [];
  const share = (ms: number) => (profile.frame.p50 > 0 ? ms / profile.frame.p50 : 0);
  for (const owner of profile.owners) {
    if (owner.filter === "always" && share(owner.ms) > 0.1)
      hints.push(`${owner.id} redraws everything under it through a filter every frame; name its filter passes and turn them on with ctx.passes() only while they show.`);
    const item = document.items[owner.id];
    if (item && "size" in item && Math.max(item.size.width, item.size.height) > LARGE_OWNER)
      hints.push(`${owner.id} is larger than any view, so its shaders never leave the screen; a Board script, or shaders on the smaller items, draw only what shows.`);
    if (owner.boxes && share(owner.ms) > 0.1)
      hints.push(`${owner.id} shades every pixel of its box; if its picture changes only every few units, as pixel art or a map does, give the pass texel so it shades once per texel.`);
    if (owner.state && owner.state.width * owner.state.height > LARGE_STATE)
      hints.push(`${owner.id} steps a ${owner.state.width}×${owner.state.height} state 60 times a second and replays it from the start in exports; keep it as small as reads well.`);
  }
  const noisy = profile.owners.filter((owner) => owner.ms > 1 && owner.range[1] - owner.range[0] > owner.ms);
  if (noisy.length)
    hints.push(`${noisy.map((owner) => owner.id).join(", ")} varied more between rounds than ${noisy.length === 1 ? "its" : "their"} median; compare the frame time, or raise --rounds.`);
  for (const [id, item] of Object.entries(document.items)) {
    const size = item.type === "file" && boardModelFormat(item.props.src, item.props.snapshot?.mimeType) ? (item.props.snapshot?.size ?? 0) : 0;
    if (size > LARGE_MODEL)
      hints.push(`${id} is a ${(size / 1024 ** 2).toFixed(0)} MB model every viewer downloads for its card, and phones skip past 16 MB; compress it (meshopt or Draco geometry, KTX2 textures).`);
  }
  for (const script of profile.scripts) {
    if (script.draw.p50 > FRAME_60_MS)
      hints.push(`${script.id} takes ${script.draw.p50.toFixed(0)} ms to draw, so a screen shows it below ${script.draw.p50 > FRAME_30_MS ? 30 : 60} frames a second, and slower phones fall further; draw less each frame, keep what does not move in an OffscreenCanvas, or lower frameRate.`);
    if (script.step.p50 > HEAVY_STEP_MS)
      hints.push(`${script.id} spends ${script.step.p50.toFixed(0)} ms in an update; onFrame() runs 60 times a second and exports replay it from the start, so keep a step to a few milliseconds.`);
  }
  if (profile.effects > MANY_EFFECTS)
    hints.push(`${profile.effects} items draw with shadows, blurs or color filters, each in its own offscreen pass; present them only while they change, and drop neutral values.`);
  return hints;
}
