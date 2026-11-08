
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, copyFile, link, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { debuglog, promisify } from "node:util";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const execFile = promisify(execFileCallback);
import { boardExportView, boardMediaNaturalSize, parseBoardMediaSource, parseBoardScriptInputs } from "@neta-art/cohub/board";
import type { BoardAssetKeySource, BoardDocument, BoardExportRegion, BoardMediaState, BoardSceneItem, BoardScriptSnapshot, BoardThemeId } from "@neta-art/cohub/board";
import { imageVariantUrl, MEDIA_VARIANT_MAX, mediaVariantSize, videoFrameUrl } from "@neta-art/cohub/media";
import type {
  BoardNodeExportFormat,
  BoardNodeFont,
  BoardNodeTexture,
  BoardScriptLaneStatus,
} from "@neta-art/cohub/board/export/node";
import type { BoardScriptHost } from "@neta-art/cohub/board/render";
import type { BoardExportWarning } from "@neta-art/cohub/board/export";
import {
  hasBoardScripts,
  boardAnimatesScriptParams,
  boardAssetKey,
  boardAssetKeySource,
  boardAutoplayLoops,
  boardMediaRate,
  boardMediaSpans,
  boardRenderTheme,
  boardTimedMedia,
  boardTextureEdge,
  boardTexturePixels,
  createBoardRenderSampler,
  buildBoardScene,
  createNodeBoardRenderer,
  createNodeBoardScriptHost,
  describeBoardExportWarning,
  describeBoardScriptLanes,
  exportBoardImageBytes,
  planBoardExport,
  prepareBoardExport,
  selectBoardExportAssets,
} from "./board-kernel.js";
import { loadBoardDocument } from "./board-document.js";
import { settleBoardDocument } from "./board-media.js";
import { openBoardGpu } from "./board-gpu/daemon.js";
import { type BoardGpuExporter, type BoardGpuResources, findBoardGpuBrowser } from "./board-gpu/index.js";
import { BOARD_EXPORT_FONTS, type BoardExportFont } from "./board-fonts.js";
import { createClient } from "./client.js";
import { downloadPublicImage } from "./safe-remote-image.js";
import { type BoardMediaFiles, boardAudioMix, createBoardMediaFiles, createBoardVideoFrames } from "./board-media-export.js";
import {
  BOARD_EXPORT_IMAGE_MEMORY_MIB,
  type BoardExportRenderer,
  type BoardExportDecodeImage,
  BoardExportResourceError,
  createBoardExportImageBudget,
} from "./board-export-resources.js";
import { packagePath } from "./package-paths.js";

const debugExport = debuglog("cohub:board-export");

export function resolveBundledFonts(): BoardNodeFont[] {
  const require = createRequire(import.meta.url);
  const bundled = packagePath("dist", "fonts");
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
      ? (await client.space(spaceId).files.resolve(source.value, { purpose: "playback" }).catch(() => null))?.url
      : null;
  if (video) {
    const frame = url && videoFrameUrl(url, mediaVariantSize(edge), { natural: boardMediaNaturalSize(item) });
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

export async function readSpaceFileBytes(
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
  scripts?: BoardScriptHost;
  snapshots?: Record<string, BoardScriptSnapshot>;
  inputs?: string;
  renderer?: BoardExportRenderer;
  signal?: AbortSignal;
  imageMemoryMiB?: number;
  timeoutMs?: number;
  onPlan?: (plan: { width: number; height: number; frames: number }) => void;
  onFrame?: (frame: BoardExportFrame, index: number) => Promise<void>;
  onProgress?: (completed: number, total: number) => void;
  mediaFiles?: BoardMediaFiles;
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
  media: Array<{ at: number; media: BoardMediaState[] }>;
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
    const mediaFiles = createBoardMediaFiles(options.spaceId, tempDir, options.signal);
    const result = await runBoardExport({ ...options, document, format: "png", mediaFiles, onFrame: async (frame, index) => {
      if (count && (frame.width !== dimensions.width || frame.height !== dimensions.height)) throw new Error("Video frame dimensions changed. Use a fixed export region or a smaller camera viewport.");
      await writeFile(join(tempDir, `${String(index + 1).padStart(6, "0")}.png`), frame.bytes, { signal: options.signal });
      dimensions = { width: frame.width, height: frame.height };
      count++;
    } });
    if (!result || !count) throw new Error("Nothing to export: the region contains no items.");
    const start = times[0] as number;
    const sampled = boardMediaSpans(result.media.map((sample) => ({ ...sample, at: sample.at - start })));
    const spans = sampled.map((span) => sampled.some((next) => next.id === span.id && next.start === span.end) ? span : { ...span, end: span.end + step });
    const mix = await boardAudioMix(spans, mediaFiles, 1);
    const duration = Math.max(0.001, count / options.fps);
    const args = ["-y", "-f", "image2", "-framerate", String(options.fps), "-i", join(tempDir, "%06d.png"), ...(mix?.inputs ?? [])];
    if (mix) args.push("-filter_complex", mix.filter, "-map", "0:v:0", "-map", "[aout]");
    else args.push("-map", "0:v:0");
    if (options.format === "mp4" && (dimensions.width % 2 || dimensions.height % 2)) args.push("-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2");
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
  const inputs = options.inputs ? parseBoardScriptInputs(options.inputs) : undefined;
  if (options.animation && !document.animations[options.animation]) {
    throw new Error(`Animation ${options.animation} does not exist.`);
  }
  const times: Array<number | null> = options.times?.length ? options.times : [null];
  const timeoutMs = options.timeoutMs ?? BOARD_EXPORT_FRAME_TIMEOUT_MS;
  const imageMemoryBytes = (options.imageMemoryMiB ?? BOARD_EXPORT_IMAGE_MEMORY_MIB) * 1024 ** 2;
  if (!Number.isSafeInteger(imageMemoryBytes) || imageMemoryBytes <= 0) throw new Error("Image memory budget must be a positive integer.");
  const nodeRenderer = await createNodeBoardRenderer({ fonts: resolveBundledFonts() });
  const images = createBoardExportImageBudget(nodeRenderer, imageMemoryBytes);
  const renderer = { ...nodeRenderer, decodeImage: images.decodeImage };
  const STAGES: Record<string, string> = { prepare: "running the scripts", gpu: "drawing in the browser", images: "loading images", render: "drawing" };
  let doing = "preparing";
  const trace = (stage: string, completed: number, dimensions?: { width: number; height: number }) => {
    doing = STAGES[stage] ?? doing;
    if (!debugExport.enabled || completed % 30 !== 0) return;
    debugExport("%j", {
      stage, completed, total: times.length,
      ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
      imageBytes: images.usedBytes, memory: process.memoryUsage(),
      availableMemory: process.availableMemory(), constrainedMemory: process.constrainedMemory(),
    });
  };
  let scriptHost: ReturnType<typeof createNodeBoardScriptHost> | null = null;
  let gpu: BoardGpuExporter | null = null;
  const textureCache: BoardExportTextureCache = { textures: new Map(), edges: new Map(), missed: new Map() };
  const frameTextures = new Map<string, BoardNodeTexture>();
  let mediaDir: string | null = null;
  let backgroundTexture: BoardNodeTexture | undefined;
  try {
    const theme = boardRenderTheme(options.theme);
    const sampler = createBoardRenderSampler(document, options.animation ?? null, theme);
    const documentAt = (time: number | null) => time === null ? document : sampler.at(time).document;
    const history = options.animation !== undefined && boardAnimatesScriptParams(document);

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
    const backgroundSource = document.board.background.image && parseBoardMediaSource(document.board.background.image.src);
    if (options.withImages && options.background === "paper" && backgroundSource) {
      try {
        const { bytes, mimeType } = backgroundSource.kind === "url"
          ? await downloadPublicImage(backgroundSource.value)
          : await readSpaceFileBytes(createClient(), options.spaceId, backgroundSource.value);
        backgroundTexture = await renderer.decodeImage(bytes, mimeType);
      } catch (error) {
        if (error instanceof BoardExportResourceError) throw error;
        warnings.push(
          "The board background image could not be loaded; the fallback color was exported.",
        );
      }
    }

    if (!options.scripts && options.renderer !== "gpu" && hasBoardScripts(document)) scriptHost = createNodeBoardScriptHost(renderer, {
      concurrency: 2,
      readModule: async (src) => {
        const { bytes } = await readSpaceFileBytes(createClient(), options.spaceId, src);
        return new TextDecoder().decode(bytes);
      },
    });

    const assetKey = (item: BoardSceneItem) => {
      const key = boardExportAssetKey(item);
      return key && omittedKeys.has(key) ? null : key;
    };
    const frames: BoardExportFrame[] = [];
    const media: BoardExportRunResult["media"] = [];
    const fps = times.length > 1 && times[0] !== null && times[1] !== null ? 1000 / ((times[1] as number) - (times[0] as number)) : 30;
    const lastMedia = new Map<string, { at: number; time: number }>();
    const framePictures = new Map<string, Uint8Array>();
    let videoFrames: ReturnType<typeof createBoardVideoFrames> | null = null;
    const frameOf = async (state: BoardMediaState, rate: number, edge: number) => {
      if (!videoFrames) {
        mediaDir = await mkdtemp(join(tmpdir(), "cohub-board-media-"));
        videoFrames = createBoardVideoFrames(options.mediaFiles ?? createBoardMediaFiles(options.spaceId, mediaDir, options.signal), mediaDir, { fps, signal: options.signal });
      }
      return videoFrames.frame(state, rate, edge);
    };
    const reported = new Set<string>();
    const report = (text: string) => {
      if (reported.has(text)) return;
      reported.add(text);
      warnings.push(text);
    };
    let completed = 0;
    let decided = options.renderer === "canvas";
    const emit = async (frame: BoardExportFrame) => {
      if (options.onFrame) await options.onFrame(frame, completed);
      else frames.push(frame);
      completed++;
      options.onProgress?.(completed, times.length);
    };
    const launchGpu = async (browser: string) => {
      doing = "starting the browser";
      const exporter = await openBoardGpu(gpuResources(options.spaceId, document, (key) => framePictures.get(key)), { browser, signal: options.signal });
      try {
        await exporter.init({ document, animation: options.animation ?? null, theme: options.theme, ...(options.snapshots ? { snapshots: options.snapshots } : {}), ...(options.inputs ? { inputs: options.inputs } : {}) });
      } catch (error) {
        await exporter.close();
        throw error;
      }
      scriptHost?.destroy();
      scriptHost = null;
      return exporter;
    };
    if (options.renderer === "gpu") {
      const browser = findBoardGpuBrowser();
      if (!browser) throw new Error("GPU export needs Chrome, Chromium or Edge. Install one, or set COHUB_CHROME to its path.");
      gpu = await launchGpu(browser);
    }
    const renderFrame = async (time: number | null) => {
      options.signal?.throwIfAborted();
      const host = scriptHost;
      host?.clearFrames();
      const frameOptions = { sampler, camera: options.camera, ...(time === null ? {} : { at: { animation: options.animation, time } }), region, scale: options.scale, padding: times.length > 1 ? 0 : options.padding };
      const initial = prepareBoardExport(document, frameOptions);
      if (!initial) return;
      let prepared = initial;
      trace("prepare", completed, initial.plan);
      const prepareScripts = async (scripts: NonNullable<typeof host>, shaders: boolean) => {
        await scripts.prepare(initial.scene.items, [time ?? 0], initial.plan.scale, initial.document.board, {
          shaders,
          view: boardExportView(initial.plan),
          ...(inputs ? { inputs } : {}),
          ...(history ? { history: (at: number) => documentAt(at) } : {}),
        });
        for (const [id, message] of scripts.emitFailures) report(`${id}: ${message}`);
        for (const id of [...Object.keys(initial.document.board.scripts ?? {}), ...initial.scene.items.map((item) => item.id)]) {
          const error = scripts.error(id);
          if (error) throw new Error(`${initial.document.board.scripts?.[id]?.src ?? initial.scene.get(id)?.script?.src ?? id}: ${error}`);
        }
        return prepareBoardExport(document, { ...frameOptions, scripts });
      };
      if (host && !gpu) {
        const scripted = await prepareScripts(host, !decided);
        if (!scripted) return;
        prepared = scripted;
      }
      if (!decided) {
        decided = true;
        const shaded = (host?.shaders?.(prepared.document, time ?? 0) ?? []).map((owner) => owner.id);
        const browser = shaded.length ? findBoardGpuBrowser() : null;
        if (browser) gpu = await launchGpu(browser);
        else if (host && shaded.length) {
          report(`Shaders in ${shaded.join(", ")} need Chrome, Chromium or Edge; install one or set COHUB_CHROME to draw them.`);
          host.clearFrames();
          const scripted = await prepareScripts(host, false);
          if (!scripted) return;
          prepared = scripted;
        }
      }
      const timed = boardTimedMedia(prepared.scene);
      media.push({ at: time ?? 0, media: timed });
      const frameKeys: Record<string, string> = {};
      for (const texture of frameTextures.values()) texture.destroy(true);
      frameTextures.clear();
      framePictures.clear();
      if (options.withImages) {
        const planned = new Set(prepared.plan.items.map((item) => item.id));
        const loops = time === null ? [] : boardAutoplayLoops(prepared.scene, time);
        for (const state of [...timed, ...loops]) {
          const item = prepared.scene.get(state.id);
          const base = item && state.kind === "video" && state.shown && planned.has(state.id) ? boardExportAssetKey(item) : null;
          if (!item || !base) continue;
          const before = lastMedia.get(state.id);
          if (time !== null) lastMedia.set(state.id, { at: time, time: state.time });
          const rate = times.length === 1 ? 0 : before && time !== null ? boardMediaRate(before, { at: time, time: state.time }) : 1;
          const edge = Math.min(4096, textureEdge(item, prepared.plan.scale));
          const bytes = await frameOf(state, rate, edge).catch((error: unknown) => {
            report(`Frames of ${state.src} could not be decoded; its cover was drawn instead. ${error instanceof Error ? error.message : ""}`.trim());
            return null;
          });
          if (!bytes?.length) continue;
          const key = `${base}@${Math.round(state.time)}`;
          frameKeys[state.id] = key;
          framePictures.set(key, bytes);
          if (!gpu) frameTextures.set(key, await nodeRenderer.decodeImage(bytes, "image/jpeg"));
        }
      }
      if (gpu) {
        trace("gpu", completed, prepared.plan);
        const result = await gpu.render({
          time,
          region,
          ...(options.camera ? { camera: options.camera } : {}),
          scale: options.scale,
          ...(times.length > 1 || options.padding === undefined ? {} : { padding: options.padding }),
          background: options.background,
          format: options.format,
          ...(options.quality === undefined ? {} : { quality: options.quality }),
          withImages: options.withImages,
          imageMemory: imageMemoryBytes,
          assetKeys: frameKeys,
        });
        for (const warning of result.warnings) report(options.withImages && warning.kind === "images-missing" ? describeBoardExportWarning(warning) : describeWarning(warning));
        await emit({ time, bytes: result.bytes, width: result.width, height: result.height, scale: result.scale, itemCount: result.itemCount, format: options.format });
        return;
      }
      trace("images", completed, prepared.plan);
      if (options.withImages) {
        const visible = prepared.plan.items.filter((item) => prepared.scene.opacity(item.id) > 0 && !frameKeys[item.id]);
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
        textures: frameTextures.size ? new Map([...textures, ...frameTextures]) : textures,
        scripts: options.scripts ?? scriptHost ?? undefined,
        backgroundTexture,
        assetKey: (item: BoardSceneItem) => frameKeys[item.id] ?? assetKey(item),
        format: options.format,
        quality: options.quality,
      });
      if (!result) return;
      for (const warning of result.warnings) {
        if (warning.kind === "images-missing" && options.withImages) continue;
        if (warning.kind === "shaders-unsupported" && options.renderer !== "canvas") continue;
        report(describeWarning(warning));
      }
      await emit({
        time,
        bytes: result.bytes,
        width: result.plan.width,
        height: result.plan.height,
        scale: result.plan.scale,
        itemCount: result.plan.items.length,
        format: result.format,
      });
      trace("rendered", completed, result.plan);
    };
    for (const time of times) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(describeStall(time, timeoutMs, doing, scriptHost?.status() ?? null))), timeoutMs);
      });
      try {
        await Promise.race([renderFrame(time), stalled]);
      } finally {
        clearTimeout(timer);
      }
    }
    return completed ? { frames, warnings, media } : null;
  } finally {
    await gpu?.close();
    scriptHost?.destroy();
    for (const texture of textureCache.textures.values()) texture.destroy(true);
    backgroundTexture?.destroy(true);
    for (const texture of frameTextures.values()) texture.destroy(true);
    if (mediaDir) await rm(mediaDir, { recursive: true, force: true });
    renderer.destroy();
  }
}

export function gpuResources(spaceId: string, document: BoardDocument, framePicture: (key: string) => Uint8Array | undefined = () => undefined): BoardGpuResources {
  const client = createClient();
  const scene = buildBoardScene(document);
  return {
    fonts: resolveBundledFonts().flatMap(({ path, family }) => (family ? [{ path, family }] : [])),
    readModule: async (path) => new TextDecoder().decode((await readSpaceFileBytes(client, spaceId, path)).bytes),
    async readPicture(request) {
      if ("background" in request) {
        const source = document.board.background.image && parseBoardMediaSource(document.board.background.image.src);
        if (!source) return null;
        return source.kind === "url" ? downloadPublicImage(source.value) : readSpaceFileBytes(client, spaceId, source.value);
      }
      const frame = framePicture(request.key);
      if (frame) return { bytes: frame, mimeType: "image/jpeg" };
      const source = boardAssetKeySource(request.key);
      const item = scene.items.find((entry) => boardAssetKey(entry) === request.key);
      return source && item ? fetchBoardPicture(client, spaceId, source, item, request.edge) : null;
    },
  };
}

export const BOARD_EXPORT_FRAME_TIMEOUT_MS = 120_000;

function describeStall(time: number | null, timeoutMs: number, doing: string, lanes: BoardScriptLaneStatus[] | null): string {
  const at = time === null ? "The export" : `The frame at ${time} ms`;
  const busy = lanes ? describeBoardScriptLanes(lanes) : [];
  const hint = doing === "drawing in the browser" ? " The browser runs the scripts and shaders there; a shader may be too heavy." : "";
  return [`${at} did not finish in ${timeoutMs / 1000} s, while ${doing}.${hint}`, ...busy.map((line) => `  ${line}`)].join("\n");
}

function describeWarning(warning: BoardExportWarning): string {
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
  return describeBoardExportWarning(warning);
}
