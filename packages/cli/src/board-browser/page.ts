import {
  type BoardAssetSource,
  type BoardDocument,
  type BoardSceneItem,
  boardAnimatesScriptParams,
  boardAssetKey,
  boardExportView,
  boardShaderParameters,
  boardAssetKeySource,
  boardModelFormat,
  boardProjection,
  boardTextureEdge,
  boardTimedMedia,
  isBoardModelObject,
  normalizeBoardDocument,
  parseBoardScriptInputs,
  selectBoardExportAssets,
} from "@neta-art/cohub/board";
import { boardExportShaders, boardExportUsesDepth, createBoardExportScene, prepareBoardExport, renderBoardExport } from "@neta-art/cohub/board/export";
import {
  type BoardDepthStage,
  type BoardScriptCost,
  type BoardScriptFont,
  type BoardScriptHost,
  type BrowserBoardScriptExport,
  boardRenderTheme,
  boardScriptFiles,
  createBoardRenderSampler,
  createBoardShaderLayer,
  createBoardShaderLayers,
  createBrowserBoardScriptExport,
  hasBoardEffects,
  type LoadedModel,
  loadBoardDepthEngine,
  loadBoardItemModel,
  loadModelEngine,
  boardModelSource,
} from "@neta-art/cohub/board/render";
import { autoDetectRenderer, ImageSource, Matrix, type Renderer, RenderTexture, Texture, type WebGLRenderer } from "pixi.js";
import { type BoardSimulationShader, simulateBoard } from "../board-simulation.js";
import type {
  BoardBrowserFrame,
  BoardBrowserFrameInfo,
  BoardBrowserInit,
  BoardBrowserProfile,
  BoardBrowserProfileInput,
  BoardBrowserSimulation,
  BoardBrowserShader,
  BoardSimulationResult,
} from "./protocol.js";

let renderer: Renderer | null = null;
let depth: Promise<BoardDepthStage | undefined> | null = null;
const MODEL_BYTES = 256 * 1024 * 1024;
const assets: BoardAssetSource = { resolveFile: async (path) => ({ url: `file?path=${encodeURIComponent(path)}` }) };
const models = new Map<string, { key: string; model: Promise<LoadedModel | null> }>();
const retired: Array<Promise<LoadedModel | null>> = [];

const modelKey = (item: BoardSceneItem) => (item.type === "file" ? `${item.props.src}:${item.props.snapshot?.mtimeMs ?? ""}` : "");

async function objectModels(items: readonly BoardSceneItem[]): Promise<Map<string, LoadedModel>> {
  const loaded = new Map<string, LoadedModel>();
  await Promise.all(items.filter(isBoardModelObject).map(async (item) => {
    let entry = models.get(item.id);
    if (entry?.key !== modelKey(item)) {
      if (entry) retired.push(entry.model);
      entry = { key: modelKey(item), model: loadBoardItemModel(item, assets, { signal: AbortSignal.timeout(120_000), maxBytes: MODEL_BYTES })?.catch(() => null) ?? Promise.resolve(null) };
      models.set(item.id, entry);
    }
    const model = await entry.model;
    if (model) loaded.set(item.id, model);
  }));
  return loaded;
}

function freeRetired() {
  for (const model of retired.splice(0)) void model.then((loaded) => loaded?.destroy());
}

async function releaseModels() {
  const stage = await depth;
  stage?.objects.sync(boardProjection({ x: 0, y: 0, zoom: 1 }, { width: 1, height: 1 }), [], 0);
  freeRetired();
  const entries = [...models.values()];
  models.clear();
  for (const entry of entries) void entry.model.then((model) => model?.destroy());
}

async function releaseImages() {
  for (const entry of textures.values()) entry?.texture.destroy(true);
  textures.clear();
  background?.destroy(true);
  background = undefined;
  await releaseModels();
}

function depthStage(target: Renderer): Promise<BoardDepthStage | undefined> {
  depth ??= loadBoardDepthEngine()
    .then((engine) => engine.createBoardDepthStage(target))
    .catch(() => undefined);
  return depth;
}
let session: {
  init: BoardBrowserInit;
  sampler: ReturnType<typeof createBoardRenderSampler>;
  scripts: BrowserBoardScriptExport;
  layers: ReturnType<typeof createBoardShaderLayers>;
} | null = null;
let ahead: Promise<unknown> | null = null;
const files = boardScriptFiles((path) => fetch(`file?path=${encodeURIComponent(path)}`));
const scriptCosts = new Map<string, BoardScriptCost[]>();
const recordCost = (id: string, cost: BoardScriptCost) => {
  const list = scriptCosts.get(id);
  if (list) list.push(cost);
  else scriptCosts.set(id, [cost]);
};

const PAGE_FONTS = JSON.parse(document.querySelector("meta[name=cohub-fonts]")?.getAttribute("content") ?? "[]") as Array<{ family: string; file: string; script?: string }>;
let loadingFonts: Promise<readonly BoardScriptFont[]> | null = null;
const scriptFonts = () => (loadingFonts ??= Promise.all(PAGE_FONTS.flatMap(({ file, script }) => (script ? [{ file, family: script }] : [])).map(async ({ file, family }) => {
  const response = await fetch(`fonts/${file}`);
  if (!response.ok) throw new Error(`${family} could not be loaded.`);
  return { family, data: await response.arrayBuffer() };
})));
const textures = new Map<string, { texture: Texture; edge: number } | null>();
let background: Texture | null | undefined;

async function fetchTexture(query: string): Promise<Texture | null> {
  const response = await fetch(`asset?${query}`);
  if (!response.ok) return null;
  const bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: "premultiply" });
  return new Texture({ source: new ImageSource({ resource: bitmap }) });
}

async function loadTextures(items: readonly BoardSceneItem[], scale: number, maxBytes: number, overrides: Record<string, string>): Promise<Map<string, Texture>> {
  const exportKey = (item: BoardSceneItem) => overrides[item.id] ?? boardAssetKey(item);
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
    const still = boardAssetKeySource(key)?.media === "model";
    const texture = await (still ? modelStill(item) : fetchTexture(`key=${encodeURIComponent(key)}&edge=${edge}`)).catch(() => null);
    if (texture) cached?.texture.destroy(true);
    textures.set(key, texture ? { texture, edge: still ? Infinity : edge } : (cached ?? null));
  }));
  const result = new Map<string, Texture>();
  for (const [key, entry] of textures) if (entry) result.set(key, entry.texture);
  return result;
}

async function modelStill(item: BoardSceneItem): Promise<Texture | null> {
  if (item.type !== "file") return null;
  const { src, snapshot, model } = item.props;
  const format = boardModelFormat(src, snapshot?.mimeType);
  const source = format && boardModelSource({ key: modelKey(item), src, format, size: snapshot?.size }, assets);
  if (!source) return null;
  const engine = await loadModelEngine();
  const { image } = await engine.renderModelStill(source, { signal: AbortSignal.timeout(120_000), maxBytes: MODEL_BYTES, view: model?.view, clip: model?.animation });
  return new Texture({ source: new ImageSource({ resource: image, alphaMode: "premultiply-alpha-on-upload" }) });
}

async function upload(canvas: HTMLCanvasElement, info: BoardBrowserFrameInfo, format: BoardBrowserFrame["format"], quality?: number, ahead?: () => void): Promise<void> {
  let body: Blob | ArrayBuffer | null;
  if (format === "rgba") {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The browser could not read the frame.");
    body = context.getImageData(0, 0, canvas.width, canvas.height).data.buffer as ArrayBuffer;
  } else body = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, `image/${format}`, quality));
  if (!body) throw new Error("The browser could not encode the frame.");
  const json = new TextEncoder().encode(JSON.stringify(info));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, json.byteLength, true);
  const sent = fetch("upload", { method: "POST", body: new Blob([length, json, body]) });
  ahead?.();
  const response = await sent;
  if (!response.ok) throw new Error((await response.text()) || "The frame was not received.");
}

type Draw = BoardBrowserFrame & {
  document: BoardDocument;
  sampler?: ReturnType<typeof createBoardRenderSampler>;
  animation?: string | null;
  theme: ReturnType<typeof boardRenderTheme>;
  scripts?: BoardScriptHost;
  layers: ReturnType<typeof createBoardShaderLayers>;
  ahead?: () => void;
};

async function draw(target: Renderer, input: Draw): Promise<BoardBrowserFrameInfo> {
  const { document, time } = input;
  const at = time === null || !input.sampler ? undefined : { animation: input.animation ?? undefined, time };
  const options = {
    ...(input.sampler ? { sampler: input.sampler } : {}),
    region: input.region,
    camera: input.camera,
    view: input.view,
    viewport: input.viewport,
    scale: input.scale,
    padding: input.padding,
    maxPixels: input.maxPixels,
    screen: input.screen,
    ...(at ? { at } : {}),
    ...(input.scripts ? { scripts: input.scripts } : {}),
  };
  const prepared = prepareBoardExport(document, options);
  if (!prepared) throw new Error("Nothing to export: the region contains no items.");
  const visible = [...prepared.plan.items, ...prepared.plan.extras].filter((item) => prepared.scene.opacity(item.id) > 0);
  const overrides = input.assetKeys ?? {};
  const loaded = input.withImages ? await loadTextures(visible, prepared.plan.scale, input.imageMemory, overrides) : new Map<string, Texture>();
  if (input.withImages && input.background === "paper" && document.board.background.image && background === undefined)
    background = await fetchTexture("background=1").catch(() => null);
  const lifted = boardExportUsesDepth(prepared) ? await depthStage(target) : undefined;
  const drawn = lifted ? await objectModels(prepared.plan.items) : undefined;
  const shaded = boardExportShaders(prepared, input.scripts?.shaders?.(prepared.document, time ?? 0) ?? []).length > 0;
  const result = renderBoardExport(lifted || shaded ? target : await flatRenderer(), document, {
    ...options,
    ...input.theme,
    background: input.background,
    textures: loaded,
    assetKey: (item: BoardSceneItem) => overrides[item.id] ?? boardAssetKey(item),
    backgroundTexture: input.background === "paper" ? (background ?? undefined) : undefined,
    shaderLayers: input.layers,
    ...(lifted ? { depth: lifted, models: drawn } : {}),
  });
  freeRetired();
  if (!result) throw new Error("Nothing to export: the region contains no items.");
  const canvas = result.canvas as unknown as HTMLCanvasElement;
  const info: BoardBrowserFrameInfo = {
    time,
    width: canvas.width,
    height: canvas.height,
    scale: result.plan.scale,
    itemCount: result.plan.items.length,
    warnings: result.warnings,
    media: boardTimedMedia(prepared.scene),
  };
  await upload(canvas, info, input.format, input.quality, input.ahead);
  return info;
}

function compileShaders(target: Renderer, shaders: readonly BoardSimulationShader[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const { id, shader, parameters } of shaders) {
    try {
      createBoardShaderLayer(target, shader, boardShaderParameters(parameters), id, { wait: true }).destroy();
    } catch (error) {
      errors[id] = error instanceof Error ? error.message : String(error);
    }
  }
  return errors;
}

const percentile = (samples: readonly number[], at: number) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))] ?? 0;
};

async function ensureRenderer(): Promise<Renderer> {
  renderer ??= await autoDetectRenderer({ preference: "webgl", width: 1, height: 1, antialias: true, backgroundAlpha: 0 });
  return renderer;
}

let flat: Promise<Renderer> | null = null;
function flatRenderer(): Promise<Renderer> {
  flat ??= autoDetectRenderer({ preference: "canvas", width: 1, height: 1, antialias: true, backgroundAlpha: 0 });
  return flat;
}

const api = {
  async compile(shaders: BoardBrowserShader[]): Promise<Record<string, string>> {
    return compileShaders(await ensureRenderer(), shaders);
  },
  async release(): Promise<void> {
    session?.scripts.dispose();
    session?.layers.destroy();
    session = null;
    ahead = null;
    await releaseImages();
  },
  async init(init: BoardBrowserInit): Promise<{ renderer: string }> {
    const renderer = await ensureRenderer();
    await document.fonts.ready;
    const board = normalizeBoardDocument(init.document);
    session?.scripts.dispose();
    ahead = null;
    const layers = session?.layers ?? createBoardShaderLayers({ wait: true });
    layers.rewind();
    if (!init.keep) {
      for (const [key, entry] of textures)
        if (!/^([a-z]+-)?url:/.test(key)) {
          entry?.texture.destroy(true);
          textures.delete(key);
        }
      background?.destroy(true);
      background = undefined;
      await releaseModels();
    }
    const sampler = createBoardRenderSampler(board, init.animation, boardRenderTheme(init.theme));
    session = {
      init: { ...init, document: board },
      sampler,
      scripts: createBrowserBoardScriptExport(files, {
        fonts: scriptFonts,
        onCost: recordCost,
        ...(init.inputs ? { inputs: parseBoardScriptInputs(init.inputs) } : {}),
        ...(init.animation && boardAnimatesScriptParams(board) ? { documentAt: (time: number) => sampler.at(time).document } : {}),
      }),
      layers,
    };
    return { renderer: renderer.name };
  },
  async profile(input: BoardBrowserProfileInput): Promise<BoardBrowserProfile> {
    if (!renderer || !session) throw new Error("The browser is not ready.");
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
    const view = boardExportView(planned.plan, planned.camera?.view);
    scriptCosts.clear();
    const scripts = await session.scripts.at(at ? sampler.at(time).document : document, time, view);
    const gl = (target as WebGLRenderer).gl;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const rendererName = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const prepared = prepareBoardExport(document, { ...options, scripts });
    if (!prepared) throw new Error("Nothing to profile: the region contains no items.");
    const visible = [...prepared.plan.items, ...prepared.plan.extras].filter((item) => prepared.scene.opacity(item.id) > 0);
    const loaded = input.withImages ? await loadTextures(visible, prepared.plan.scale, input.imageMemory, {}) : new Map<string, Texture>();
    const inside = new Set(prepared.plan.items.map((item) => item.id));
    const owners = (scripts.shaders?.(prepared.document, time) ?? []).filter((owner) => owner.root || inside.has(owner.id));
    const layers = createBoardShaderLayers({ wait: true });
    const lifted = boardExportUsesDepth(prepared) ? await depthStage(target) : undefined;
    const drawn = lifted ? await objectModels(prepared.plan.items) : undefined;
    const scene = createBoardExportScene({
      settings: prepared.document.board,
      scene: prepared.scene,
      items: prepared.plan.items,
      extras: prepared.plan.extras,
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
      ...(lifted ? { depth: { renderer: target, stage: lifted, models: drawn } } : {}),
      ...(prepared.camera ? { camera: prepared.camera } : {}),
    });
    freeRetired();
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
      layers.prepare(target);
      target.render({ container: scene.root, target: output, clear: true, ...(transform ? { transform } : {}) });
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return performance.now() - start;
    };
    try {
      render();
      const renders = (frames: number) => frames * input.rounds * (1 + owners.length);
      let frames = input.frames;
      let frameMs = Math.max(render(), 0.1);
      let reduced: BoardBrowserProfile["reduced"] = null;
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
          boxes: shader?.passes.filter((pass) => !pass.sprites && !pass.texel && (pass.layer ?? shader.layer) !== "filter").length ?? 0,
          state: shader?.state ? { width: shader.state.width, height: shader.state.height } : null,
        };
      });
      for (let frame = 1; frame <= 60 && performance.now() - started < input.budgetMs; frame++) {
        const next = time + (frame * 1000) / 60;
        await session.scripts.at(at ? sampler.at(next).document : document, next, view);
      }
      const scriptResults = [...scriptCosts].map(([id, list]) => {
        const drawn = list.filter((cost) => cost.width > 0);
        const spread = (values: number[]) => ({ p50: percentile(values, 0.5), p95: percentile(values, 0.95) });
        return {
          id,
          step: spread(list.map((cost) => cost.step)),
          draw: spread(drawn.map((cost) => cost.draw)),
          width: Math.max(0, ...drawn.map((cost) => cost.width)),
          height: Math.max(0, ...drawn.map((cost) => cost.height)),
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
        scripts: scriptResults.sort((a, b) => b.draw.p50 + b.step.p50 - a.draw.p50 - a.step.p50),
        effects: visible.filter((item) => hasBoardEffects(item.style)).length,
        items: visible.length,
      };
    } finally {
      output.destroy(true);
      scene.destroy();
      layers.destroy();
    }
  },
  async render(frame: BoardBrowserFrame): Promise<BoardBrowserFrameInfo> {
    if (!renderer || !session) throw new Error("The browser is not ready.");
    const { document, animation, theme } = session.init;
    const { sampler, scripts: run } = session;
    const settle = (time: number | null) => {
      const planned = prepareBoardExport(document, { ...frame, sampler, ...(time === null ? {} : { at: { animation: animation ?? undefined, time } }) });
      return run.at(time === null ? document : sampler.at(time).document, time ?? 0, planned ? boardExportView(planned.plan, planned.camera?.view) : undefined);
    };
    const pending = ahead;
    ahead = null;
    await pending;
    const scripts = await settle(frame.time);
    const { time, next } = frame;
    const start = time !== null && next !== undefined && next > time ? () => {
      ahead = settle(next);
      ahead.catch(() => {});
    } : undefined;
    return draw(renderer, { ...frame, document, sampler, animation, theme: boardRenderTheme(theme), scripts, layers: session.layers, ...(start ? { ahead: start } : {}) });
  },
  async simulate(input: BoardBrowserSimulation): Promise<BoardSimulationResult> {
    const target = await ensureRenderer();
    await document.fonts.ready;
    const element = document.createElement("div");
    element.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none";
    document.body.appendChild(element);
    const layers = createBoardShaderLayers({ wait: true });
    const board = normalizeBoardDocument(input.document);
    const theme = boardRenderTheme(input.theme);
    const { render, frame } = input;
    try {
      return await simulateBoard({
        document: board,
        spec: input,
        recordings: input.recordings,
        timeoutMs: input.timeoutMs,
        scripts: { files, element, fonts: scriptFonts },
        compile: async (shaders) => compileShaders(target, shaders),
        ...(render && frame ? {
          capture: async (shot) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
              draw(target, {
                ...frame,
                time: shot.time,
                document: shot.document,
                theme,
                layers,
                viewport: input.viewport,
                ...(render.camera ? { camera: render.size ?? input.viewport } : {}),
                ...(shot.view ? { view: shot.view } : {}),
                ...(shot.scripts ? { scripts: shot.scripts } : {}),
              }),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`The frame at ${shot.time} ms did not finish in ${frame.timeoutMs / 1000} s.`)), frame.timeoutMs);
              }),
            ]).finally(() => clearTimeout(timer));
          },
        } : {}),
      });
    } finally {
      layers.destroy();
      element.remove();
      await releaseImages();
    }
  },
};

(globalThis as { cohubBoard?: typeof api }).cohubBoard = api;
