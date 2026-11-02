import {
  type BoardSceneItem,
  boardAssetKey,
  boardAssetKeySource,
  boardTextureEdge,
  normalizeBoardDocument,
  selectBoardExportAssets,
} from "@neta-art/cohub/board";
import { prepareBoardExport, renderBoardExport } from "@neta-art/cohub/board/export";
import { boardRenderTheme, createBoardRenderSampler, prepareBrowserBoardScripts } from "@neta-art/cohub/board/render";
import { autoDetectRenderer, ImageSource, type Renderer, Texture } from "pixi.js";
import type { BoardGpuFrame, BoardGpuInit, BoardGpuResult } from "./protocol.js";

let renderer: Renderer | null = null;
let session: { init: BoardGpuInit; sampler: ReturnType<typeof createBoardRenderSampler> } | null = null;
const textures = new Map<string, { texture: Texture; edge: number } | null>();
let background: Texture | null | undefined;

async function fetchTexture(query: string): Promise<Texture | null> {
  const response = await fetch(`asset?${query}`);
  if (!response.ok) return null;
  const bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: "premultiply" });
  return new Texture({ source: new ImageSource({ resource: bitmap }) });
}

async function loadTextures(items: readonly BoardSceneItem[], scale: number, maxBytes: number): Promise<Map<string, Texture>> {
  const exportKey = (item: BoardSceneItem) => {
    const key = boardAssetKey(item);
    return key && boardAssetKeySource(key)?.media !== "model" ? key : null;
  };
  const selection = selectBoardExportAssets([...items], exportKey, { scale, maxBytes });
  const wanted = new Set(selection.keys);
  for (const [key, entry] of textures) {
    if (wanted.has(key)) continue;
    entry?.texture.destroy(true);
    textures.delete(key);
  }
  await Promise.all(selection.items.map(async (item, index) => {
    const key = selection.keys[index] as string;
    const edge = Math.min(4096, Math.ceil(boardTextureEdge(item, scale)) || 4096);
    const cached = textures.get(key);
    if (cached === null || (cached && cached.edge >= edge)) return;
    const texture = await fetchTexture(`key=${encodeURIComponent(key)}&edge=${edge}`).catch(() => null);
    if (texture) cached?.texture.destroy(true);
    textures.set(key, texture ? { texture, edge } : (cached ?? null));
  }));
  const result = new Map<string, Texture>();
  for (const [key, entry] of textures) if (entry) result.set(key, entry.texture);
  return result;
}

async function toBase64(blob: Blob): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(",") + 1);
}

const api = {
  async init(init: BoardGpuInit): Promise<{ renderer: string }> {
    renderer ??= await autoDetectRenderer({ preference: "webgl", width: 1, height: 1, antialias: true, backgroundAlpha: 0 });
    await document.fonts.ready;
    const board = normalizeBoardDocument(init.document);
    session = { init: { ...init, document: board }, sampler: createBoardRenderSampler(board, init.animation, boardRenderTheme(init.theme)) };
    return { renderer: renderer.name };
  },
  async render(frame: BoardGpuFrame): Promise<BoardGpuResult> {
    if (!renderer || !session) throw new Error("The GPU exporter is not ready.");
    const { document, animation, theme: themeId } = session.init;
    const theme = boardRenderTheme(themeId);
    const at = frame.time === null ? undefined : { animation: animation ?? undefined, time: frame.time };
    const time = frame.time ?? 0;
    const sample = at ? session.sampler.at(time).document : document;
    const scripts = await prepareBrowserBoardScripts(sample, time, async (path) => {
      const response = await fetch(`module?path=${encodeURIComponent(path)}`);
      if (!response.ok) throw new Error(`${path} is not available.`);
      return response.text();
    });
    try {
      const options = {
        sampler: session.sampler,
        region: frame.region,
        camera: frame.camera,
        scale: frame.scale,
        padding: frame.padding,
        ...(at ? { at } : {}),
        scripts: scripts.host,
      };
      const prepared = prepareBoardExport(document, options);
      if (!prepared) throw new Error("Nothing to export: the region contains no items.");
      const visible = prepared.plan.items.filter((item) => prepared.scene.opacity(item.id) > 0);
      const loaded = frame.withImages ? await loadTextures(visible, prepared.plan.scale, frame.imageMemory) : new Map<string, Texture>();
      if (frame.withImages && frame.background === "paper" && document.board.background.image && background === undefined)
        background = await fetchTexture("background=1").catch(() => null);
      const result = renderBoardExport(renderer, document, {
        ...options,
        ...theme,
        background: frame.background,
        textures: loaded,
        backgroundTexture: frame.background === "paper" ? (background ?? undefined) : undefined,
      });
      if (!result) throw new Error("Nothing to export: the region contains no items.");
      const canvas = result.canvas as unknown as HTMLCanvasElement;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, `image/${frame.format}`, frame.quality));
      if (!blob) throw new Error("The browser could not encode the frame.");
      return {
        data: await toBase64(blob),
        width: canvas.width,
        height: canvas.height,
        scale: result.plan.scale,
        itemCount: result.plan.items.length,
        warnings: result.warnings,
      };
    } finally {
      scripts.dispose();
    }
  },
};

(globalThis as { cohubBoardGpu?: typeof api }).cohubBoardGpu = api;
