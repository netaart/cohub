
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const execFile = promisify(execFileCallback);
import type { BoardDocument, BoardExportRegion, BoardSceneItem } from "@neta-art/cohub/board";
import type {
  BoardNodeExportFormat,
  BoardNodeFont,
  BoardNodeRenderer,
  BoardNodeTexture,
} from "@neta-art/cohub/board/export/node";
import {
  boardDocumentAt,
  boardImageKeySource,
  buildBoardScene,
  createNodeBoardRenderer,
  createNodeBoardSketchHost,
  exportBoardImageBytes,
  imageAssetKey,
  parseBoardDocument,
  planBoardExport,
  selectBoardExportAssets,
} from "./board-kernel.js";
import { resolveBoardId } from "./board-command-support.js";
import { BOARD_EXPORT_FONTS, type BoardExportFont } from "./board-fonts.js";
import { createClient } from "./client.js";
import { downloadPublicImage } from "./safe-remote-image.js";

export function resolveBundledFonts(): BoardNodeFont[] {
  const require = createRequire(import.meta.url);
  const bundled = fileURLToPath(new URL("./fonts/", import.meta.url));
  const locate = ({ pkg, file }: BoardExportFont): string | null => {
    const copied = join(bundled, file);
    if (existsSync(copied)) return copied;
    try {
      const path = join(dirname(require.resolve(`${pkg}/package.json`)), "files", file);
      return existsSync(path) ? path : null;
    } catch {
      return null;
    }
  };
  return BOARD_EXPORT_FONTS.flatMap((font) => {
    const path = locate(font);
    return path ? [{ path, family: font.family }] : [];
  });
}

export type BoardExportSource = {
  document: BoardDocument;
  boardId: string;
  title: string | null;
};

export async function loadBoardDocument(
  spaceId: string,
  target: string,
): Promise<BoardExportSource> {
  const board = createClient().space(spaceId).board(await resolveBoardId(spaceId, target));
  let result = await board.get();
  const items = { ...result.items };
  while (result.next) {
    result = await board.get({ only: ["items"], cursor: result.next });
    Object.assign(items, result.items);
  }
  const parsed = parseBoardDocument({ board: result.board, items, animations: result.animations ?? {} });
  if (!parsed.ok) throw new Error(`Board ${result.id} could not be read: ${parsed.diagnostics[0]?.path}: ${parsed.diagnostics[0]?.message}`);
  return { document: parsed.document, boardId: result.id, title: result.title };
}

export async function loadBoardTextures(
  renderer: BoardNodeRenderer,
  spaceId: string,
  items: readonly BoardSceneItem[],
  options: { concurrency?: number } = {},
): Promise<{
  textures: Map<string, BoardNodeTexture>;
  failed: string[];
  omitted: string[];
}> {
  const selection = selectBoardExportAssets([...items], imageAssetKey);
  const textures = new Map<string, BoardNodeTexture>();
  const failed: string[] = [];
  const pending = [...selection.keys];
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 16));
  const client = createClient();

  async function worker() {
    for (;;) {
      const key = pending.shift();
      if (!key) return;
      const source = boardImageKeySource(key);
      if (!source) {
        failed.push(key);
        continue;
      }
      try {
        const { bytes, mimeType } =
          source.kind === "file"
            ? await readSpaceFileBytes(client, spaceId, source.value)
            : await downloadPublicImage(source.value);
        const texture = await renderer.decodeImage(bytes, mimeType);
        textures.set(key, texture);
      } catch {
        failed.push(key);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  return { textures, failed, omitted: selection.omittedKeys };
}

async function readSpaceFileBytes(
  client: ReturnType<typeof createClient>,
  spaceId: string,
  path: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const { blob, mimeType } = await client.space(spaceId).files.download(path);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType };
}

export type BoardExportRunOptions = {
  spaceId: string;
  target: string;
  region: BoardExportRegion;
  times?: number[];
  animation?: string;
  scale: number;
  padding?: number;
  colorScheme: "dark" | "light";
  background: "paper" | "transparent";
  format: BoardNodeExportFormat;
  quality?: number;
  withImages: boolean;
};

export type BoardExportFrame = {
  time: number | null;
  bytes: Uint8Array;
  width: number;
  height: number;
  scale: number;
  itemCount: number;
  format: BoardNodeExportFormat;
};

export type BoardExportRunResult = {
  frames: BoardExportFrame[];
  warnings: string[];
};

export type BoardVideoExportFormat = "mp4" | "webm";

export type BoardVideoExportOptions = Omit<BoardExportRunOptions, "format"> & {
  format: BoardVideoExportFormat;
  fps: number;
  output: string;
};

export async function runBoardVideoExport(options: BoardVideoExportOptions): Promise<{ width: number; height: number; frames: number; warnings: string[] }> {
  if (!options.animation) throw new Error("Video export needs --animation.");
  if (!options.times || options.times.length < 2) throw new Error("Video export needs an --at range with at least two frames.");
  const times = options.times;
  const step = (times[1] as number) - (times[0] as number);
  if (!Number.isFinite(step) || step <= 0) throw new Error("Video export needs an increasing --at range.");
  const derivedFps = 1000 / step;
  if (Math.abs(options.fps - derivedFps) > 0.01) throw new Error(`--fps must match the --at step (${derivedFps.toFixed(3)} fps).`);
  const result = await runBoardExport({ ...options, format: "png" });
  if (!result) throw new Error("Nothing to export: the region contains no items.");
  const tempDir = await mkdtemp(join(tmpdir(), "cohub-board-export-"));
  try {
    for (const [index, frame] of result.frames.entries()) await writeFile(join(tempDir, `${String(index + 1).padStart(6, "0")}.png`), frame.bytes);
    const document = (await loadBoardDocument(options.spaceId, options.target)).document;
    const audioDocument = boardDocumentAt(document, options.animation, times[0] as number).document;
    const audio = Object.values(audioDocument.items).filter((item) => item.type === "audio");
    const audioInputs: Array<{ path: string; offset: number }> = [];
    for (const [index, item] of audio.entries()) {
      const { bytes } = await readSpaceFileBytes(createClient(), options.spaceId, item.props.src);
      const path = join(tempDir, `audio-${index}-${item.props.src.split("/").pop() ?? "track"}`);
      await writeFile(path, bytes);
      audioInputs.push({ path, offset: Math.max(0, item.props.time ?? 0) / 1000 });
    }
    const duration = Math.max(0.001, result.frames.length / options.fps);
    const args = ["-y", "-f", "image2", "-framerate", String(options.fps), "-i", join(tempDir, "%06d.png")];
    for (const input of audioInputs) {
      if (input.offset > 0) args.push("-ss", input.offset.toFixed(3));
      args.push("-i", input.path);
    }
    if (audioInputs.length > 1) {
      const inputs = audioInputs.map((_, index) => `[${index + 1}:a]`).join("");
      args.push("-filter_complex", `${inputs}amix=inputs=${audioInputs.length}:duration=longest:dropout_transition=0[aout]`, "-map", "0:v:0", "-map", "[aout]");
    } else {
      args.push("-map", "0:v:0");
      if (audioInputs.length === 1) args.push("-map", "1:a:0");
    }
    if (options.format === "mp4") args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-f", "mp4");
    else args.push("-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-c:a", "libopus", "-f", "webm");
    args.push("-t", duration.toFixed(3), options.output);
    try {
      await execFile("ffmpeg", args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
    } catch (error) {
      const cause = error as { code?: string; stderr?: string; message?: string };
      if (cause.code === "ENOENT") throw new Error("Video export needs ffmpeg. Install ffmpeg and try again.");
      throw new Error(`ffmpeg could not encode the video: ${(cause.stderr ?? cause.message ?? "unknown error").trim().split("\n").slice(-6).join("\n")}`);
    }
    return { width: result.frames[0]?.width ?? 0, height: result.frames[0]?.height ?? 0, frames: result.frames.length, warnings: result.warnings };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function runBoardExport(
  options: BoardExportRunOptions,
): Promise<BoardExportRunResult | null> {
  const { document } = await loadBoardDocument(options.spaceId, options.target);
  if (options.animation && !document.animations[options.animation]) {
    throw new Error(`Animation ${options.animation} does not exist.`);
  }
  const times: Array<number | null> = options.times?.length ? options.times : [null];
  const documentAt = (time: number | null) =>
    time === null ? document : boardDocumentAt(document, options.animation ?? null, time).document;

  const plan = planBoardExport({
    scene: buildBoardScene(documentAt(times[0] ?? null)),
    region: options.region,
    scale: options.scale,
    ...(options.padding === undefined ? {} : { padding: options.padding }),
  });
  if (!plan) return null;

  const renderer = await createNodeBoardRenderer({ fonts: resolveBundledFonts() });
  let sketchHost: ReturnType<typeof createNodeBoardSketchHost> | null = null;
  try {
    const warnings: string[] = [];
    let textures: Map<string, BoardNodeTexture> | undefined;
    let backgroundTexture: BoardNodeTexture | undefined;
    let omittedKeys = new Set<string>();
    if (options.withImages) {
      const loaded = await loadBoardTextures(renderer, options.spaceId, plan.items);
      textures = loaded.textures;
      omittedKeys = new Set(loaded.omitted);
      if (loaded.failed.length > 0) {
        warnings.push(
          `${loaded.failed.length} image${loaded.failed.length === 1 ? "" : "s"} could not be loaded: ${loaded.failed.slice(0, 3).join(", ")}${loaded.failed.length > 3 ? ", …" : ""}`,
        );
      }
      if (loaded.omitted.length > 0) {
        warnings.push(
          `${loaded.omitted.length} previews were drawn as placeholders to stay within the export texture limit.`,
        );
      }
    }

    const declaredBackground = document.board.background;
    if (
      options.withImages &&
      options.background === "paper" &&
      declaredBackground.kind === "image" &&
      declaredBackground.imageUrl
    ) {
      try {
        const { bytes, mimeType } = await downloadPublicImage(declaredBackground.imageUrl);
        backgroundTexture = await renderer.decodeImage(bytes, mimeType);
      } catch {
        warnings.push(
          "The board background image could not be loaded; the fallback color was exported.",
        );
      }
    }

    const videoCount = plan.items.filter((item) => item.type === "video").length;
    sketchHost = createNodeBoardSketchHost(renderer, {
      readModule: async (src) => {
        const { bytes } = await readSpaceFileBytes(createClient(), options.spaceId, src);
        return new TextDecoder().decode(bytes);
      },
    });
    const region: BoardExportRegion = times.length > 1 ? { kind: "rect", rect: plan.world } : options.region;
    const host = sketchHost;
    if (!host) throw new Error("Node sketch host could not be created.");
    const sketchVariants = new Map<string, { item: Extract<BoardSceneItem, { type: "sketch" }>; times: number[] }>();
    for (const time of times) {
      const sketchPlan = planBoardExport({
        scene: buildBoardScene(documentAt(time)),
        region,
        scale: options.scale,
        ...(times.length > 1 ? { padding: 0 } : options.padding === undefined ? {} : { padding: options.padding }),
      });
      for (const item of sketchPlan?.items.filter((entry): entry is Extract<BoardSceneItem, { type: "sketch" }> => entry.type === "sketch") ?? []) {
        const key = `${item.id}:${item.frame.width}:${item.frame.height}:${item.props.src}:${item.props.seed ?? ""}:${JSON.stringify(item.props.params)}`;
        const variant = sketchVariants.get(key) ?? { item, times: [] };
        variant.times.push(time ?? 0);
        sketchVariants.set(key, variant);
      }
    }
    await Promise.all([...sketchVariants.values()].map((variant) => host.prepare([variant.item], variant.times, plan.scale)));
    if (videoCount > 0) {
      warnings.push(
        `${videoCount} video preview${videoCount === 1 ? " was" : "s were"} drawn as placeholders; video decoding is unavailable in Node.`,
      );
    }

    const backgroundImage = backgroundTexture
      ? { texture: backgroundTexture, fit: declaredBackground.fit ?? "cover", position: "center" as const, opacity: declaredBackground.opacity ?? 1 }
      : undefined;
    const assetKey = options.withImages
      ? (item: BoardSceneItem) => {
          const key = imageAssetKey(item);
          return key && omittedKeys.has(key) ? null : key;
        }
      : undefined;
    const frames: BoardExportFrame[] = [];
    const reported = new Set<string>();
    for (const time of times) {
      const result = exportBoardImageBytes(renderer, document, {
        ...(time === null ? {} : { at: { ...(options.animation ? { animation: options.animation } : {}), time } }),
        region,
        scale: options.scale,
        padding: times.length > 1 ? 0 : options.padding,
        colorScheme: options.colorScheme,
        background: options.background,
        textures,
        sketches: sketchHost ?? undefined,
        backgroundImage,
        ...(assetKey ? { assetKey } : {}),
        format: options.format,
        quality: options.quality,
      });
      if (!result) continue;
      for (const warning of result.warnings) {
        if (warning.kind === "images-missing" && options.withImages) continue;
        const text = describeWarning(warning);
        if (!reported.has(text)) warnings.push(text);
        reported.add(text);
      }
      frames.push({
        time,
        bytes: result.bytes,
        width: result.plan.width,
        height: result.plan.height,
        scale: result.plan.scale,
        itemCount: result.plan.items.length,
        format: result.format,
      });
    }
    return frames.length ? { frames, warnings } : null;
  } finally {
    sketchHost?.destroy();
    renderer.destroy();
  }
}

function describeWarning(warning: { kind: string; [key: string]: unknown }): string {
  if (warning.kind === "scale-clamped") {
    return `Scale reduced from ${warning.requested}x to ${Number(warning.applied).toFixed(2)}x to stay within the size limit.`;
  }
  if (warning.kind === "images-missing") {
    const keys = warning.keys as string[];
    return `${keys.length} image${keys.length === 1 ? "" : "s"} drawn as placeholders (use --images to fetch them).`;
  }
  if (warning.kind === "many-items") {
    return `${warning.count} items exported.`;
  }
  return warning.kind;
}
