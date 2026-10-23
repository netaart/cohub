
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, copyFile, link, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { debuglog, promisify } from "node:util";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const execFile = promisify(execFileCallback);
import { parseBoardMediaSource } from "@neta-art/cohub/board";
import type { BoardAssetKeySource, BoardDocument, BoardExportRegion, BoardSceneItem, BoardThemeId } from "@neta-art/cohub/board";
import { imageVariantUrl, MEDIA_VARIANT_MAX, mediaVariantSize, videoFrameUrl } from "@neta-art/cohub/media";
import type {
  BoardNodeExportFormat,
  BoardNodeFont,
  BoardNodeTexture,
} from "@neta-art/cohub/board/export/node";
import {
  hasBoardScripts,
  boardAssetKey,
  boardAssetKeySource,
  boardDocumentAt,
  boardRenderTheme,
  boardTextureEdge,
  boardTexturePixels,
  createBoardRenderSampler,
  buildBoardScene,
  createNodeBoardRenderer,
  createNodeBoardScriptHost,
  exportBoardImageBytes,
  parseBoardDocument,
  planBoardExport,
  prepareBoardExport,
  selectBoardExportAssets,
} from "./board-kernel.js";
import { settleBoardDocument } from "./board-media.js";
import { BOARD_EXPORT_FONTS, type BoardExportFont } from "./board-fonts.js";
import { createClient } from "./client.js";
import { downloadPublicAudio, downloadPublicImage } from "./safe-remote-image.js";
import {
  BOARD_EXPORT_IMAGE_MEMORY_MIB,
  type BoardExportDecodeImage,
  BoardExportResourceError,
  createBoardExportImageBudget,
} from "./board-export-resources.js";

const debugExport = debuglog("cohub:board-export");

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
  const board = await createClient().space(spaceId).boards.open(target);
  let result = await board.get();
  const snapshot = result;
  const items = { ...result.items };
  while (result.next) {
    result = await board.get({ only: ["items"], cursor: result.next });
    if (result.version !== snapshot.version) throw new Error("Board changed while reading. Retry the export.");
    Object.assign(items, result.items);
  }
  const parsed = parseBoardDocument({ board: snapshot.board, items, animations: snapshot.animations ?? {} });
  if (!parsed.ok) throw new Error(`Board ${result.id} could not be read: ${parsed.diagnostics[0]?.path}: ${parsed.diagnostics[0]?.message}`);
  return { document: parsed.document, boardId: result.id, title: result.title };
}

type TextureMiss = "error" | "unavailable" | "omitted";

export type BoardExportTextureCache = {
  textures: Map<string, BoardNodeTexture>;
  /** Long edge each texture was decoded for; Infinity once it is the whole source. */
  edges: Map<string, number>;
  /** Keys without a texture: failed to load, no picture Node can draw, or over the image budget. */
  missed: Map<string, TextureMiss>;
};

/** Texture keys Node can draw; 3D model stills need a browser. */
export function boardExportAssetKey(item: BoardSceneItem): string | null {
  const key = boardAssetKey(item);
  return key && boardAssetKeySource(key)?.media !== "model" ? key : null;
}

function textureEdge(item: BoardSceneItem, scale: number): number {
  const edge = boardTextureEdge(item, scale);
  return Number.isFinite(edge) ? edge : Math.ceil(boardTexturePixels(item, scale));
}

const textureBytes = (texture: BoardNodeTexture) => texture.width * texture.height * 4;

/**
 * Previews for `items` within what the image budget leaves after other images,
 * such as the background. A preview that still does not fit is omitted.
 */
export async function loadBoardTextures(
  images: { decodeImage: BoardExportDecodeImage; usedBytes: number },
  spaceId: string,
  items: readonly BoardSceneItem[],
  options: { scale: number; maxBytes: number; concurrency?: number; cache?: BoardExportTextureCache },
): Promise<{ textures: Map<string, BoardNodeTexture> } & Record<"failed" | "unavailable" | "omitted", string[]>> {
  const cache = options.cache ?? { textures: new Map(), edges: new Map(), missed: new Map() };
  const { textures, edges, missed } = cache;
  let previewBytes = 0;
  for (const texture of textures.values()) previewBytes += textureBytes(texture);
  const maxBytes = options.maxBytes - (images.usedBytes - previewBytes);
  const selection = selectBoardExportAssets([...items], boardExportAssetKey, { scale: options.scale, maxBytes });
  const wanted = new Set(selection.keys);
  for (const [key, texture] of textures) {
    if (wanted.has(key)) continue;
    texture.destroy(true);
    textures.delete(key);
    edges.delete(key);
  }
  for (const key of missed.keys()) if (!wanted.has(key)) missed.delete(key);
  const pending = selection.items.flatMap((item, index) => {
    const key = selection.keys[index] as string;
    const edge = textureEdge(item, options.scale);
    return missed.has(key) || (edges.get(key) ?? 0) >= edge ? [] : [{ key, item, edge }];
  });
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 16));
  const client = createClient();

  async function worker() {
    for (let task = pending.shift(); task; task = pending.shift()) {
      const { key, item, edge } = task;
      let miss: TextureMiss | null = "unavailable";
      try {
        const source = boardAssetKeySource(key);
        const picture = source && await fetchBoardPicture(client, spaceId, source, item, edge);
        if (picture) {
          const texture = await images.decodeImage(picture.bytes, picture.mimeType, edge);
          textures.get(key)?.destroy(true);
          textures.set(key, texture);
          edges.set(key, Math.max(texture.width, texture.height) < edge ? Number.POSITIVE_INFINITY : edge);
          miss = null;
        }
      } catch (error) {
        miss = error instanceof BoardExportResourceError ? "omitted" : "error";
      }
      // A preview already shown stays, at the sharpness it has.
      if (miss && textures.has(key)) edges.set(key, Number.POSITIVE_INFINITY);
      else if (miss) missed.set(key, miss);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  const keys = (reason: TextureMiss) => [...missed].flatMap(([key, value]) => (value === reason ? [key] : []));
  return { textures, failed: keys("error"), unavailable: keys("unavailable"), omitted: [...selection.omittedKeys, ...keys("omitted")] };
}

type Picture = { bytes: Uint8Array; mimeType: string };

/**
 * The picture for a texture, `edge` pixels on its long edge where the host can
 * resize: a CDN variant of an image, or the first frame of a video. Null when
 * there is none, as for videos outside Cohub's media hosts.
 */
async function fetchBoardPicture(
  client: ReturnType<typeof createClient>,
  spaceId: string,
  source: BoardAssetKeySource,
  item: BoardSceneItem,
  edge: number,
): Promise<Picture | null> {
  // Thumbnail edges below the smallest variant fetch that variant; decoding scales it down.
  const variantEdge = Number.isFinite(edge) && edge <= MEDIA_VARIANT_MAX ? mediaVariantSize(edge) : null;
  const video = source.media === "video";
  const url = source.kind === "url"
    ? source.value
    : video || variantEdge
      ? await client.space(spaceId).files.resolveUrl(source.value, { purpose: "playback" }).catch(() => null)
      : null;
  if (video) {
    const { naturalWidth: w, naturalHeight: h } = (item.type === "video" && item.props.snapshot) || {};
    const width = w && h ? Math.min(w, (edge * w) / Math.max(w, h)) : edge;
    const frame = url && videoFrameUrl(url, mediaVariantSize(width));
    return frame ? downloadPublicImage(frame) : null;
  }
  const variant = url && variantEdge && imageVariantUrl(url, variantEdge);
  if (variant) {
    try {
      return await downloadPublicImage(variant);
    } catch {
      // Fall back to the original below.
    }
  }
  return source.kind === "url" ? downloadPublicImage(source.value) : readSpaceFileBytes(client, spaceId, source.value);
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
  theme: BoardThemeId;
  background: "paper" | "transparent";
  format: BoardNodeExportFormat;
  quality?: number;
  withImages: boolean;
  camera?: { width: number; height: number };
  document?: BoardDocument;
  signal?: AbortSignal;
  imageMemoryMiB?: number;
  onPlan?: (plan: { width: number; height: number; frames: number }) => void;
  onFrame?: (frame: BoardExportFrame, index: number) => Promise<void>;
  onProgress?: (completed: number, total: number) => void;
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
  force?: boolean;
};

export async function runBoardVideoExport(options: BoardVideoExportOptions): Promise<{ width: number; height: number; frames: number; warnings: string[] }> {
  if (!options.animation) throw new Error("Video export needs --animation.");
  if (!options.times || options.times.length < 2) throw new Error("Video export needs an --at range with at least two frames.");
  const times = options.times;
  const step = (times[1] as number) - (times[0] as number);
  if (!Number.isFinite(step) || step <= 0) throw new Error("Video export needs an increasing --at range.");
  const derivedFps = 1000 / step;
  if (Math.abs(options.fps - derivedFps) > 0.01) throw new Error(`--fps must match the --at step (${derivedFps.toFixed(3)} fps).`);
  if (times.some((time, index) => index > 0 && Math.abs(time - (times[index - 1] as number) - step) > 0.001)) throw new Error("Video export needs evenly spaced times.");
  await execFile("ffmpeg", ["-version"], { signal: options.signal }).catch(() => { throw new Error("Video export needs ffmpeg. Install ffmpeg and try again."); });
  const document = options.document ?? await settleBoardDocument(options.spaceId, (await loadBoardDocument(options.spaceId, options.target)).document);
  const tempDir = await mkdtemp(join(tmpdir(), "cohub-board-export-"));
  try {
    let count = 0;
    let dimensions = { width: 0, height: 0 };
    const result = await runBoardExport({ ...options, document, format: "png", onPlan: (plan) => {
      if (options.format === "mp4" && (plan.width % 2 || plan.height % 2)) {
        throw new Error(`MP4 needs even dimensions, but the export is ${plan.width}x${plan.height}. Use --camera --size with even dimensions, or adjust the export region.`);
      }
      options.onPlan?.(plan);
    }, onFrame: async (frame, index) => {
      if (count && (frame.width !== dimensions.width || frame.height !== dimensions.height)) throw new Error("Video frame dimensions changed. Use a fixed export region or a smaller camera viewport.");
      await writeFile(join(tempDir, `${String(index + 1).padStart(6, "0")}.png`), frame.bytes, { signal: options.signal });
      dimensions = { width: frame.width, height: frame.height };
      count++;
    } });
    if (!result || !count) throw new Error("Nothing to export: the region contains no items.");
    const audioDocument = boardDocumentAt(document, options.animation, times[0] as number).document;
    const audio = Object.values(audioDocument.items).filter((item) => item.type === "audio");
    const audioInputs: Array<{ path: string; offset: number }> = [];
    for (const [index, item] of audio.entries()) {
      const source = parseBoardMediaSource(item.props.src);
      if (!source) throw new Error("Invalid board audio source");
      const { bytes } = source.kind === "url"
        ? await downloadPublicAudio(source.value)
        : await readSpaceFileBytes(createClient(), options.spaceId, source.value);
      const path = join(tempDir, `audio-${index}`);
      await writeFile(path, bytes);
      audioInputs.push({ path, offset: Math.max(0, item.props.time ?? 0) / 1000 });
    }
    const duration = Math.max(0.001, count / options.fps);
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
    const encoded = join(tempDir, `video.${options.format}`);
    args.push("-t", duration.toFixed(3), encoded);
    debugExport("%j", { stage: "encode", width: dimensions.width, height: dimensions.height, frames: count, memory: process.memoryUsage() });
    try {
      await execFile("ffmpeg", args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, signal: options.signal });
    } catch (error) {
      const cause = error as { code?: string; stderr?: string; message?: string };
      if (cause.code === "ENOENT") throw new Error("Video export needs ffmpeg. Install ffmpeg and try again.");
      throw new Error(`ffmpeg could not encode the video: ${(cause.stderr ?? cause.message ?? "unknown error").trim().split("\n").slice(-6).join("\n")}`);
    }
    options.signal?.throwIfAborted();
    const staged = `${options.output}.${randomUUID()}.tmp`;
    try {
      await copyFile(encoded, staged, constants.COPYFILE_EXCL);
      options.signal?.throwIfAborted();
      if (options.force) await rename(staged, options.output);
      else await link(staged, options.output);
    } finally { await unlink(staged).catch(() => undefined); }
    return { ...dimensions, frames: count, warnings: result.warnings };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function runBoardExport(
  options: BoardExportRunOptions,
): Promise<BoardExportRunResult | null> {
  options.signal?.throwIfAborted();
  const document = options.document ?? await settleBoardDocument(options.spaceId, (await loadBoardDocument(options.spaceId, options.target)).document);
  if (options.animation && !document.animations[options.animation]) {
    throw new Error(`Animation ${options.animation} does not exist.`);
  }
  const times: Array<number | null> = options.times?.length ? options.times : [null];
  const imageMemoryBytes = (options.imageMemoryMiB ?? BOARD_EXPORT_IMAGE_MEMORY_MIB) * 1024 ** 2;
  if (!Number.isSafeInteger(imageMemoryBytes) || imageMemoryBytes <= 0) throw new Error("Image memory budget must be a positive integer.");
  const nodeRenderer = await createNodeBoardRenderer({ fonts: resolveBundledFonts() });
  const images = createBoardExportImageBudget(nodeRenderer, imageMemoryBytes);
  const renderer = { ...nodeRenderer, decodeImage: images.decodeImage };
  const trace = (stage: string, completed: number, dimensions?: { width: number; height: number }) => {
    if (!debugExport.enabled || completed % 30 !== 0) return;
    debugExport("%j", {
      stage, completed, total: times.length,
      ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
      imageBytes: images.usedBytes, memory: process.memoryUsage(),
      availableMemory: process.availableMemory(), constrainedMemory: process.constrainedMemory(),
    });
  };
  let scriptHost: ReturnType<typeof createNodeBoardScriptHost> | null = null;
  const textureCache: BoardExportTextureCache = { textures: new Map(), edges: new Map(), missed: new Map() };
  let backgroundTexture: BoardNodeTexture | undefined;
  try {
    const theme = boardRenderTheme(options.theme);
    const sampler = createBoardRenderSampler(document, options.animation ?? null, theme);
    const documentAt = (time: number | null) => time === null ? document : sampler.at(time).document;

    const plan = planBoardExport({
      scene: buildBoardScene(documentAt(times[0] ?? null)),
      region: options.region,
      scale: options.scale,
      ...(options.padding === undefined ? {} : { padding: options.padding }),
    });
    if (!plan) return null;

    const region: BoardExportRegion = times.length > 1 && !options.camera ? { kind: "rect", rect: plan.world } : options.region;
    const firstTime = times[0] ?? null;
    const first = prepareBoardExport(document, {
      sampler, region, camera: options.camera, scale: options.scale,
      padding: times.length > 1 ? 0 : options.padding,
      ...(firstTime === null ? {} : { at: { animation: options.animation, time: firstTime } }),
    });
    if (!first) return null;
    options.onPlan?.({ width: first.plan.width, height: first.plan.height, frames: times.length });
    trace("plan", 0, first.plan);
    const warnings: string[] = [];
    const textures = textureCache.textures;
    let omittedKeys = new Set<string>();
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
      } catch (error) {
        if (error instanceof BoardExportResourceError) throw error;
        warnings.push(
          "The board background image could not be loaded; the fallback color was exported.",
        );
      }
    }

    if (hasBoardScripts(document)) scriptHost = createNodeBoardScriptHost(renderer, {
      concurrency: 2,
      readModule: async (src) => {
        const { bytes } = await readSpaceFileBytes(createClient(), options.spaceId, src);
        return new TextDecoder().decode(bytes);
      },
    });
    const host = scriptHost;

    const backgroundImage = backgroundTexture
      ? { texture: backgroundTexture, fit: declaredBackground.fit ?? "cover", position: "center" as const, opacity: declaredBackground.opacity ?? 1 }
      : undefined;
    const assetKey = (item: BoardSceneItem) => {
      const key = boardExportAssetKey(item);
      return key && omittedKeys.has(key) ? null : key;
    };
    const frames: BoardExportFrame[] = [];
    const reported = new Set<string>();
    let completed = 0;
    for (const time of times) {
      options.signal?.throwIfAborted();
      host?.clearFrames();
      const frameOptions = { sampler, camera: options.camera, ...(time === null ? {} : { at: { animation: options.animation, time } }), region, scale: options.scale, padding: times.length > 1 ? 0 : options.padding };
      const initial = prepareBoardExport(document, frameOptions);
      if (!initial) continue;
      let prepared = initial;
      trace("prepare", completed, initial.plan);
      if (host) {
        await host.prepare(initial.scene.items, [time ?? 0], initial.plan.scale);
        for (const item of initial.scene.items) {
          const error = host.error(item.id);
          if (error) throw new Error(`${item.script?.src ?? item.id}: ${error}`);
        }
        const scripted = prepareBoardExport(document, { ...frameOptions, scripts: host });
        if (!scripted) continue;
        prepared = scripted;
      }
      trace("images", completed, prepared.plan);
      if (options.withImages) {
        const visible = prepared.plan.items.filter((item) => prepared.scene.opacity(item.id) > 0);
        const loaded = await loadBoardTextures(images, options.spaceId, visible, { scale: prepared.plan.scale, maxBytes: imageMemoryBytes, cache: textureCache });
        omittedKeys = new Set(loaded.omitted);
        const sources = (keys: string[]) => keys.slice(0, 3).map((key) => boardAssetKeySource(key)?.value ?? key).join(", ");
        const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
        const assetWarnings = [
          loaded.failed.length ? `${plural(loaded.failed.length, "preview")} could not be loaded: ${sources(loaded.failed)}` : null,
          loaded.unavailable.length ? `${plural(loaded.unavailable.length, "video")} drawn without a cover; Node exports take covers from Cohub-hosted media only.` : null,
          loaded.omitted.length ? `${plural(loaded.omitted.length, "preview")} drawn as placeholders to stay within the ${imageMemoryBytes / 1024 ** 2} MiB image budget; raise --image-memory to include them.` : null,
        ];
        for (const warning of assetWarnings) if (warning && !reported.has(warning)) {
          warnings.push(warning);
          reported.add(warning);
        }
      }

      trace("render", completed, prepared.plan);
      const result = exportBoardImageBytes(renderer, document, {
        ...frameOptions,
        ...theme,
        background: options.background,
        textures,
        scripts: scriptHost ?? undefined,
        backgroundImage,
        assetKey,
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
      const frame: BoardExportFrame = {
        time,
        bytes: result.bytes,
        width: result.plan.width,
        height: result.plan.height,
        scale: result.plan.scale,
        itemCount: result.plan.items.length,
        format: result.format,
      };
      if (options.onFrame) await options.onFrame(frame, completed);
      else frames.push(frame);
      completed++;
      options.onProgress?.(completed, times.length);
      trace("rendered", completed, result.plan);
    }
    return completed ? { frames, warnings } : null;
  } finally {
    scriptHost?.destroy();
    for (const texture of textureCache.textures.values()) texture.destroy(true);
    backgroundTexture?.destroy(true);
    renderer.destroy();
  }
}

function describeWarning(warning: { kind: string; [key: string]: unknown }): string {
  if (warning.kind === "scale-clamped") {
    return `Scale reduced from ${warning.requested}x to ${Number(warning.applied).toFixed(2)}x to stay within the size limit.`;
  }
  if (warning.kind === "images-missing") {
    const keys = warning.keys as string[];
    return `${keys.length} preview${keys.length === 1 ? "" : "s"} drawn as placeholders; omit --no-images to fetch them.`;
  }
  if (warning.kind === "many-items") {
    return `${warning.count} items exported.`;
  }
  return warning.kind;
}
