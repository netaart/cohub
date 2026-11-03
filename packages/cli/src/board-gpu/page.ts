import {
  type BoardSceneItem,
  boardAnimatesScriptParams,
  boardAssetKey,
  boardExportView,
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
import { autoDetectRenderer, ImageSource, Matrix, type Renderer, RenderTexture, Texture, type WebGLRenderer } from "pixi.js";
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
    const started = performance.now();
    const target = renderer;
    const { document, animation, theme: themeId } = session.init;
    const theme = boardRenderTheme(themeId);
    const at = input.time === null ? undefined : { animation: animation ?? undefined, time: input.time };
    const time = input.time ?? 0;
    const sampler = session.sampler;
    const options = { sampler, region: input.region, camera: input.camera, scale: input.scale, padding: 0, ...(at ? { at } : {}) };
    const planned = prepareBoardExport(document, options);
    if (!planned) throw new Error("Nothing to profile: the region contains no items.");
    const scripts = await session.scripts.at(at ? sampler.at(time).document : document, time, boardExportView(planned.plan));
    const gl = (target as WebGLRenderer).gl;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const rendererName = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const prepared = prepareBoardExport(document, { ...options, scripts });
    if (!prepared) throw new Error("Nothing to profile: the region contains no items.");
    const visible = prepared.plan.items.filter((item) => prepared.scene.opacity(item.id) > 0);
    const loaded = input.withImages ? await loadTextures(visible, prepared.plan.scale, input.imageMemory, {}) : new Map<string, Texture>();
    const inside = new Set(prepared.plan.items.map((item) => item.id));
    const owners = (scripts.shaders?.(prepared.document, time) ?? []).filter((owner) => owner.root || inside.has(owner.id));
    const layers = createBoardShaderLayers({ wait: true });
    const scene = createBoardExportScene({
      settings: prepared.document.board,
      scene: prepared.scene,
      items: prepared.plan.items,
      time,
      frameAt: sampler.frameAt,
      world: prepared.plan.world,
      scale: prepared.plan.scale,
      colorScheme: theme.colorScheme,
      palette: theme.palette,
      colors: theme.colors,
      style: theme.style,
      textures: loaded,
      scripts,
      assetKey: boardAssetKey,
      ...(prepared.plan.page ? { page: prepared.plan.page } : {}),
      ...(owners.length ? { shaders: { renderer: target, owners, layers } } : {}),
    });
    const pixel = new Uint8Array(4);
    // Lowering the resolution draws the same scene smaller: rebuilding it would compile everything again.
    let size = { width: prepared.plan.width, height: prepared.plan.height };
    let output = RenderTexture.create(size);
    let transform: Matrix | undefined;
    const resize = (factor: number) => {
      output.destroy(true);
      size = { width: Math.max(1, Math.round(prepared.plan.width * factor)), height: Math.max(1, Math.round(prepared.plan.height * factor)) };
      output = RenderTexture.create(size);
      transform = new Matrix().scale(factor, factor);
    };
    const render = () => {
      const start = performance.now();
      target.render({ container: scene.root, target: output, clear: true, ...(transform ? { transform } : {}) });
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return performance.now() - start;
    };
    try {
      render();
      const renders = (frames: number) => frames * input.rounds * (1 + owners.length);
      let frames = input.frames;
      let frameMs = Math.max(render(), 0.1);
      let reduced: BoardGpuProfile["reduced"] = null;
      let factor = 1;
      const budget = Math.max(input.budgetMs / 4, input.budgetMs - (performance.now() - started));
      for (let attempt = 0; attempt < 3 && frameMs * renders(frames) > budget; attempt++) {
        reduced ??= { ...size, frames, frameMs };
        frames = Math.max(3, Math.min(frames, Math.floor(budget / (frameMs * renders(1)))));
        const next = Math.max(factor * Math.sqrt(Math.min(1, budget / (frameMs * renders(frames)))), Math.min(1, 320 / Math.max(prepared.plan.width, prepared.plan.height)));
        if (next > factor * 0.98) break;
        factor = next;
        resize(factor);
        render();
        frameMs = Math.max(render(), 0.1);
      }
      const measure = () => {
        const samples: number[] = [];
        for (let frame = 0; frame < frames; frame++) samples.push(render());
        return samples.sort((a, b) => a - b);
      };
      const median = (samples: readonly number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)] ?? 0;
      const all: number[] = [];
      const costs = new Map<string, number[]>(owners.map((owner) => [owner.id, []]));
      const measuring = performance.now();
      let rounds = 0;
      for (; rounds < input.rounds; rounds++) {
        if (rounds && (performance.now() - measuring) * (rounds + 1) / rounds > budget * 1.25) break;
        const samples = measure();
        all.push(...samples);
        const base = median(samples);
        for (const owner of owners) {
          const layer = layers.layer(owner.id);
          const parts = [layer?.below, layer?.above].filter((part) => part !== null && part !== undefined);
          const filters = layer?.filters ?? [];
          const shown = parts.map((part) => part.visible);
          const enabled = filters.map((filter) => filter.enabled);
          for (const part of parts) part.visible = false;
          for (const filter of filters) filter.enabled = false;
          const without = median(measure());
          parts.forEach((part, index) => { part.visible = shown[index] as boolean; });
          filters.forEach((filter, index) => { filter.enabled = enabled[index] as boolean; });
          costs.get(owner.id)?.push(Math.max(0, base - without));
        }
      }
      all.sort((a, b) => a - b);
      const p50 = median(all);
      const results = owners.map((owner) => {
        const shader = owner.output.shader;
        const rounds = costs.get(owner.id) ?? [0];
        const filterPasses = shader?.passes.filter((pass) => (pass.layer ?? shader.layer) === "filter") ?? [];
        return {
          id: owner.id,
          ms: median(rounds),
          range: [Math.min(...rounds), Math.max(...rounds)] as [number, number],
          filter: !filterPasses.length ? ("none" as const) : filterPasses.every((pass) => pass.name) ? ("switchable" as const) : ("always" as const),
          sprites: shader?.passes.reduce((sum, pass) => sum + (pass.sprites ?? 0), 0) ?? 0,
          state: shader?.state ? { width: shader.state.width, height: shader.state.height } : null,
        };
      });
      return {
        renderer: rendererName,
        gpu: /swiftshader|llvmpipe|softpipe|software|basic render/i.test(rendererName) ? "software" : "hardware",
        ...size,
        frames,
        rounds,
        reduced,
        elapsedMs: performance.now() - started,
        frame: { p50, p95: all[Math.min(all.length - 1, Math.floor(all.length * 0.95))] ?? p50 },
        owners: results.sort((a, b) => b.ms - a.ms),
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
    const planned = prepareBoardExport(document, { sampler: session.sampler, region: frame.region, camera: frame.camera, scale: frame.scale, padding: frame.padding, ...(at ? { at } : {}) });
    const scripts = await session.scripts.at(sample, time, planned ? boardExportView(planned.plan) : undefined);
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
