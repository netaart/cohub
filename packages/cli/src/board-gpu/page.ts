import {
  type BoardSceneItem,
  boardAnimatesScriptParams,
  boardAssetKey,
  boardShaderParameters,
  boardAssetKeySource,
  boardTextureEdge,
  normalizeBoardDocument,
  selectBoardExportAssets,
} from "@neta-art/cohub/board";
import { createBoardExportScene, prepareBoardExport, renderBoardExport } from "@neta-art/cohub/board/export";
import {
  type BrowserBoardScriptExport,
  boardRenderTheme,
  createBoardRenderSampler,
  createBoardShaderLayer,
  createBoardShaderLayers,
  createBrowserBoardScriptExport,
  hasBoardEffects,
} from "@neta-art/cohub/board/render";
import { autoDetectRenderer, ImageSource, type Renderer, RenderTexture, Texture, type WebGLRenderer } from "pixi.js";
import type { BoardGpuFrame, BoardGpuInit, BoardGpuProfile, BoardGpuProfileInput, BoardGpuResult, BoardGpuShader } from "./protocol.js";

let renderer: Renderer | null = null;
let session: {
  init: BoardGpuInit;
  sampler: ReturnType<typeof createBoardRenderSampler>;
  scripts: BrowserBoardScriptExport;
  layers: ReturnType<typeof createBoardShaderLayers>;
} | null = null;
const textures = new Map<string, { texture: Texture; edge: number } | null>();
let background: Texture | null | undefined;

async function fetchTexture(query: string): Promise<Texture | null> {
  const response = await fetch(`asset?${query}`);
  if (!response.ok) return null;
  const bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: "premultiply" });
  return new Texture({ source: new ImageSource({ resource: bitmap }) });
}

async function loadTextures(items: readonly BoardSceneItem[], scale: number, maxBytes: number, overrides: Record<string, string>): Promise<Map<string, Texture>> {
  const exportKey = (item: BoardSceneItem) => {
    const key = overrides[item.id] ?? boardAssetKey(item);
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

async function ensureRenderer(): Promise<Renderer> {
  renderer ??= await autoDetectRenderer({ preference: "webgl", width: 1, height: 1, antialias: true, backgroundAlpha: 0 });
  return renderer;
}

const api = {
  async compile(shaders: BoardGpuShader[]): Promise<Record<string, string>> {
    const target = await ensureRenderer();
    const errors: Record<string, string> = {};
    for (const { id, shader, parameters } of shaders) {
      try {
        createBoardShaderLayer(target, shader, boardShaderParameters(parameters), id, { wait: true }).destroy();
      } catch (error) {
        errors[id] = error instanceof Error ? error.message : String(error);
      }
    }
    return errors;
  },
  async init(init: BoardGpuInit): Promise<{ renderer: string }> {
    const renderer = await ensureRenderer();
    await document.fonts.ready;
    const board = normalizeBoardDocument(init.document);
    session?.scripts.dispose();
    const layers = session?.layers ?? createBoardShaderLayers({ wait: true });
    layers.rewind();
    for (const [key, entry] of textures)
      if (!/^([a-z]+-)?url:/.test(key)) {
        entry?.texture.destroy(true);
        textures.delete(key);
      }
    background?.destroy(true);
    background = undefined;
    const sampler = createBoardRenderSampler(board, init.animation, boardRenderTheme(init.theme));
    session = {
      init: { ...init, document: board },
      sampler,
      scripts: createBrowserBoardScriptExport(async (path) => {
        const response = await fetch(`module?path=${encodeURIComponent(path)}`);
        if (!response.ok) throw new Error(`${path} is not available.`);
        return response.text();
      }, {
        ...(init.snapshots ? { snapshots: init.snapshots } : {}),
        ...(init.animation && boardAnimatesScriptParams(board) ? { documentAt: (time: number) => sampler.at(time).document } : {}),
      }),
      layers,
    };
    return { renderer: renderer.name };
  },
  async profile(input: BoardGpuProfileInput): Promise<BoardGpuProfile> {
    if (!renderer || !session) throw new Error("The GPU exporter is not ready.");
    const target = renderer;
    const { document, animation, theme: themeId } = session.init;
    const theme = boardRenderTheme(themeId);
    const at = input.time === null ? undefined : { animation: animation ?? undefined, time: input.time };
    const time = input.time ?? 0;
    const scripts = await session.scripts.at(at ? session.sampler.at(time).document : document, time);
    const prepared = prepareBoardExport(document, { sampler: session.sampler, region: input.region, camera: input.camera, scale: input.scale, ...(at ? { at } : {}), scripts });
    if (!prepared) throw new Error("Nothing to profile: the region contains no items.");
    const visible = prepared.plan.items.filter((item) => prepared.scene.opacity(item.id) > 0);
    const loaded = input.withImages ? await loadTextures(visible, prepared.plan.scale, input.imageMemory, {}) : new Map<string, Texture>();
    const owners = scripts.shaders?.(prepared.document, time) ?? [];
    const layers = createBoardShaderLayers({ wait: true });
    const scene = createBoardExportScene({
      settings: prepared.document.board,
      scene: prepared.scene,
      items: prepared.plan.items,
      time,
      frameAt: session.sampler.frameAt,
      world: prepared.plan.world,
      scale: prepared.plan.scale,
      colorScheme: theme.colorScheme,
      palette: theme.palette,
      colors: theme.colors,
      style: theme.style,
      textures: loaded,
      scripts,
      assetKey: boardAssetKey,
      ...(owners.length ? { shaders: { renderer: target, owners, layers } } : {}),
    });
    const { width, height } = prepared.plan;
    const output = RenderTexture.create({ width, height });
    const gl = (target as WebGLRenderer).gl;
    const pixel = new Uint8Array(4);
    const measure = () => {
      const samples: number[] = [];
      for (let frame = 0; frame < Math.max(3, input.frames); frame++) {
        const start = performance.now();
        target.render({ container: scene.root, target: output, clear: true });
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        samples.push(performance.now() - start);
      }
      return samples.sort((a, b) => a - b);
    };
    try {
      measure();
      const all = measure();
      const median = (samples: number[]) => samples[Math.floor(samples.length / 2)] ?? 0;
      const base = median(all);
      const costs = owners.map((owner) => {
        const layer = layers.layer(owner.id);
        const shader = owner.output.shader;
        const parts = [layer?.below, layer?.above].filter((part) => part !== null && part !== undefined);
        const filters = layer?.filters ?? [];
        const shown = parts.map((part) => part.visible);
        const enabled = filters.map((filter) => filter.enabled);
        for (const part of parts) part.visible = false;
        for (const filter of filters) filter.enabled = false;
        const without = median(measure());
        parts.forEach((part, index) => { part.visible = shown[index] as boolean; });
        filters.forEach((filter, index) => { filter.enabled = enabled[index] as boolean; });
        const filterPasses = shader?.passes.filter((pass) => (pass.layer ?? shader.layer) === "filter") ?? [];
        return {
          id: owner.id,
          ms: Math.max(0, base - without),
          filter: !filterPasses.length ? ("none" as const) : filterPasses.every((pass) => pass.name) ? ("switchable" as const) : ("always" as const),
          sprites: shader?.passes.reduce((sum, pass) => sum + (pass.sprites ?? 0), 0) ?? 0,
          state: shader?.state ? { width: shader.state.width, height: shader.state.height } : null,
        };
      });
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        renderer: String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
        width,
        height,
        frame: { p50: base, p95: all[Math.min(all.length - 1, Math.floor(all.length * 0.95))] ?? base },
        owners: costs.sort((a, b) => b.ms - a.ms),
        effects: visible.filter((item) => hasBoardEffects(item.style)).length,
        items: visible.length,
      };
    } finally {
      output.destroy(true);
      scene.destroy();
      layers.destroy();
    }
  },
  async render(frame: BoardGpuFrame): Promise<BoardGpuResult> {
    if (!renderer || !session) throw new Error("The GPU exporter is not ready.");
    const { document, animation, theme: themeId } = session.init;
    const theme = boardRenderTheme(themeId);
    const at = frame.time === null ? undefined : { animation: animation ?? undefined, time: frame.time };
    const time = frame.time ?? 0;
    const sample = at ? session.sampler.at(time).document : document;
    const scripts = await session.scripts.at(sample, time);
    const options = {
      sampler: session.sampler,
      region: frame.region,
      camera: frame.camera,
      scale: frame.scale,
      padding: frame.padding,
      ...(at ? { at } : {}),
      scripts,
    };
    const prepared = prepareBoardExport(document, options);
    if (!prepared) throw new Error("Nothing to export: the region contains no items.");
    const visible = prepared.plan.items.filter((item) => prepared.scene.opacity(item.id) > 0);
    const overrides = frame.assetKeys ?? {};
    const loaded = frame.withImages ? await loadTextures(visible, prepared.plan.scale, frame.imageMemory, overrides) : new Map<string, Texture>();
    if (frame.withImages && frame.background === "paper" && document.board.background.image && background === undefined)
      background = await fetchTexture("background=1").catch(() => null);
    const result = renderBoardExport(renderer, document, {
      ...options,
      ...theme,
      background: frame.background,
      textures: loaded,
      assetKey: (item: BoardSceneItem) => overrides[item.id] ?? boardAssetKey(item),
      backgroundTexture: frame.background === "paper" ? (background ?? undefined) : undefined,
      shaderLayers: session.layers,
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
  },
};

(globalThis as { cohubBoardGpu?: typeof api }).cohubBoardGpu = api;
