import { type BoardDocument, type BoardExportRegion, boardModelFormat } from "@neta-art/cohub/board";
import { gpuResources, loadBoardDocument } from "./board-export.js";
import { openBoardGpu } from "./board-gpu/daemon.js";
import { type BoardGpuProfile, findBoardGpuBrowser } from "./board-gpu/index.js";
import { BOARD_EXPORT_IMAGE_MEMORY_MIB } from "./board-export-resources.js";
import { buildBoardScene, planBoardExport } from "./board-kernel.js";
import { settleBoardDocument } from "./board-media.js";

const LARGE_OWNER = 4000;
const LARGE_STATE = 512 * 512;
const MANY_EFFECTS = 16;
const LARGE_MODEL = 8 * 1024 ** 2;

export type BoardProfile = BoardGpuProfile & { hints: string[] };

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
}): Promise<BoardProfile> {
  const browser = findBoardGpuBrowser();
  if (!browser) throw new Error("Profiling needs Chrome, Chromium or Edge. Install one, or set COHUB_CHROME to its path.");
  const document = await settleBoardDocument(options.spaceId, (await loadBoardDocument(options.spaceId, options.target)).document);
  if (options.animation && !document.animations[options.animation]) throw new Error(`Animation ${options.animation} does not exist.`);
  const plan = planBoardExport({ scene: buildBoardScene(document), region: options.region, scale: 1, padding: 0 });
  if (!plan) throw new Error("Nothing to profile: the region contains no items.");
  const scale = Math.min(options.size.width / plan.world.width, options.size.height / plan.world.height);
  const gpu = await openBoardGpu(gpuResources(options.spaceId, document), { browser });
  try {
    await gpu.init({ document, animation: options.animation ?? null, theme: "dark" });
    const profile = await gpu.profile({
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
    await gpu.close();
  }
}

export function boardProfileHints(document: BoardDocument, profile: BoardGpuProfile): string[] {
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
  if (profile.effects > MANY_EFFECTS)
    hints.push(`${profile.effects} items draw with shadows, blurs or color filters, each in its own offscreen pass; present them only while they change, and drop neutral values.`);
  return hints;
}
