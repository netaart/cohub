
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BoardDocument, BoardExportRegion, BoardSceneItem } from "@neta-art/cohub/board";
import type {
  BoardHeadlessExportFormat,
  BoardHeadlessFont,
  BoardHeadlessRenderer,
  BoardHeadlessTexture,
} from "@neta-art/cohub/board/headless";
import {
  boardDocumentAt,
  boardImageKeySource,
  buildBoardScene,
  createBoardHeadlessRenderer,
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

export function resolveBundledFonts(): BoardHeadlessFont[] {
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
  headless: BoardHeadlessRenderer,
  spaceId: string,
  items: readonly BoardSceneItem[],
  options: { concurrency?: number } = {},
): Promise<{
  textures: Map<string, BoardHeadlessTexture>;
  failed: string[];
  omitted: string[];
}> {
  const selection = selectBoardExportAssets([...items], imageAssetKey);
  const textures = new Map<string, BoardHeadlessTexture>();
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
        const texture = await headless.decodeImage(bytes, mimeType);
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
  format: BoardHeadlessExportFormat;
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
  format: BoardHeadlessExportFormat;
};

export type BoardExportRunResult = {
  frames: BoardExportFrame[];
  warnings: string[];
};

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

  const headless = await createBoardHeadlessRenderer({ fonts: resolveBundledFonts() });
  try {
    const warnings: string[] = [];
    let textures: Map<string, BoardHeadlessTexture> | undefined;
    let backgroundTexture: BoardHeadlessTexture | undefined;
    let omittedKeys = new Set<string>();
    if (options.withImages) {
      const loaded = await loadBoardTextures(headless, options.spaceId, plan.items);
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
        backgroundTexture = await headless.decodeImage(bytes, mimeType);
      } catch {
        warnings.push(
          "The board background image could not be loaded; the fallback color was exported.",
        );
      }
    }

    const videoCount = plan.items.filter((item) => item.type === "video").length;
    if (videoCount > 0) {
      warnings.push(
        `${videoCount} video preview${videoCount === 1 ? " was" : "s were"} drawn as placeholders; headless video decoding is unavailable.`,
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
    const region: BoardExportRegion = times.length > 1 ? { kind: "rect", rect: plan.world } : options.region;
    const frames: BoardExportFrame[] = [];
    const reported = new Set<string>();
    for (const time of times) {
      const result = exportBoardImageBytes(headless, document, {
        ...(time === null ? {} : { at: { ...(options.animation ? { animation: options.animation } : {}), time } }),
        region,
        scale: options.scale,
        padding: times.length > 1 ? 0 : options.padding,
        colorScheme: options.colorScheme,
        background: options.background,
        textures,
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
    headless.destroy();
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
