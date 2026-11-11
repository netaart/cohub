
import type { BoardDocument } from "@cohub/protocol";
import { resolveBoardAnimationCamera, type BoardAnimationSampler } from "../model/sampling.js";
import { createBoardRenderSampler } from "../render/sampling.js";
import { type BoardSceneItem, buildBoardScene } from "../model/scene.js";
import { type ICanvas, Rectangle, type Renderer, RendererType, type Texture } from "pixi.js";
import { type BoardShapeColors, buildFallbackShapeColors } from "../model/palette.js";
import {
  BOARD_EXPORT_ITEM_WARN_THRESHOLD,
  type BoardExportPlan,
  type BoardExportRegion,
  exportItemBounds,
  normalizeBoardDocument,
  planBoardExport,
} from "../model/export-plan.js";
import type { BoardScene } from "../model/scene.js";
import { boardShaderPassOn } from "../model/shader.js";
import type { BoardShaderOwner } from "../render/shader/layers.js";
import {
  type BoardBackdrop,
  type BoardBackdropTheme,
  type BoardRenderPalette,
  type BoardRenderStyleInput,
  defaultBoardPalette,
  resolveBoardBackdrop,
} from "../render/index.js";
import { flattenBoardEffects } from "../render/effects.js";
import { ensureBoardTextMeasurement } from "../render/text-measurement.js";
import type { BoardCardRendererResolver, BoardScriptHost } from "../render/renderers/board-renderer-registry.js";
import type { BoardShaderLayers } from "../render/shader/layers.js";
import { createBoardExportScene } from "./scene.js";

export type {
  BoardExportPlan,
  BoardExportPlanInput,
  BoardExportRegion,
} from "../model/export-plan.js";
export { createBoardExportScene } from "./scene.js";
export type { BoardExportScene, BoardExportSceneInput } from "./scene.js";

export type BoardExportBackground = "paper" | "transparent" | number;

export type BoardExportOptions = {
  region?: BoardExportRegion;
  camera?: { width: number; height: number };
  sampler?: BoardAnimationSampler;
  at?: { animation?: string; time: number };
  scale?: number;
  padding?: number;
  colorScheme?: "dark" | "light";
  background?: BoardExportBackground;
  palette?: Partial<BoardRenderPalette>;
  colors?: BoardShapeColors;
  style?: BoardRenderStyleInput;
  textures?: Map<string, Texture>;
  viewTextures?: ReadonlyMap<string, Texture>;
  scripts?: BoardScriptHost;
  shaderLayers?: BoardShaderLayers;
  assetKey?: (item: BoardSceneItem) => string | null;
  renderers?: BoardCardRendererResolver;
  backgroundTexture?: Texture;
  maxEdge?: number;
  maxPixels?: number;
};

export type BoardExportWarning =
  | { kind: "scale-clamped"; requested: number; applied: number }
  | { kind: "images-missing"; keys: string[] }
  | { kind: "many-items"; count: number }
  | { kind: "shaders-unsupported"; drawn: string[]; omitted: string[] }
  | { kind: "shader-failed"; id: string; message: string }
  | { kind: "shader-hidden"; ids: string[]; reason: string };

export type BoardExportResult = {
  canvas: ICanvas;
  plan: BoardExportPlan;
  warnings: BoardExportWarning[];
};

function resolveBackdrop(options: BoardExportOptions, document: BoardDocument, theme: BoardBackdropTheme): BoardBackdrop | null {
  if (options.background === "transparent") return null;
  const backdrop = resolveBoardBackdrop(document.board, theme, "export");
  return typeof options.background === "number" ? { ...backdrop, color: options.background } : backdrop;
}

export function prepareBoardExport(input: BoardDocument, options: BoardExportOptions = {}) {
  ensureBoardTextMeasurement();
  const base = options.sampler ? input : normalizeBoardDocument(input);
  if (options.camera && options.region && options.region.kind !== "all") throw new Error("Camera export cannot be combined with a fixed region.");
  if (options.camera && !options.at) throw new Error("Camera export needs an animation time.");
  if (options.camera && (![options.camera.width, options.camera.height].every((n) => Number.isSafeInteger(n) && n > 0))) throw new Error("Camera dimensions must be positive integers.");
  const sampler = options.at ? options.sampler ?? createBoardRenderSampler(base, options.at.animation ?? null, options) : undefined;
  const sample = options.at ? sampler?.at(options.at.time) : undefined;
  const sampled = sample?.document ?? base;
  const document = options.scripts?.document?.(sampled, options.at?.time ?? 0) ?? sampled;
  const scene = document === sampled ? sample?.scene ?? buildBoardScene(document) : buildBoardScene(document);
  const camera = options.camera ? resolveBoardAnimationCamera(sample?.evaluation.camera ?? {}, (id) => scene.get(id)?.frame, options.camera, options.at?.time ?? 0, undefined, sample?.evaluation.cameraViewport) : undefined;
  const region: BoardExportRegion = camera && options.camera ? { kind: "rect", rect: { x: -camera.x / camera.zoom, y: -camera.y / camera.zoom, width: options.camera.width / camera.zoom, height: options.camera.height / camera.zoom } } : options.region ?? { kind: "all" };
  const plan = planBoardExport({
    scene,
    region,
    scale: camera?.zoom ?? options.scale,
    padding: camera ? 0 : options.padding,
    maxEdge: options.maxEdge,
    maxPixels: options.maxPixels,
  });
  if (plan && camera && options.camera) {
    const ratio = plan.clamped ? plan.scale / camera.zoom : 1;
    plan.width = Math.max(1, Math.floor(options.camera.width * ratio));
    plan.height = Math.max(1, Math.floor(options.camera.height * ratio));
  }
  return plan ? { document, scene, plan, sampler } : null;
}

export function renderBoardExport(renderer: Renderer, input: BoardDocument, options: BoardExportOptions = {}): BoardExportResult | null {
  const prepared = prepareBoardExport(input, options);
  if (!prepared) return null;
  const { document, scene, plan, sampler } = prepared;
  const colorScheme = options.colorScheme ?? "dark";
  const palette = { ...defaultBoardPalette(colorScheme), ...options.palette };
  const owners = options.scripts?.shaders?.(document, options.at?.time ?? 0) ?? [];
  const gpu = renderer.type === RendererType.WEBGL;
  const exportScene = createBoardExportScene({
    settings: document.board,
    scene,
    items: plan.items,
    time: options.at?.time ?? 0,
    frameAt: sampler?.frameAt,
    world: plan.world,
    scale: plan.scale,
    colorScheme,
    palette,
    colors: options.colors,
    style: options.style,
    textures: options.textures,
    viewTextures: options.viewTextures,
    scripts: options.scripts,
    assetKey: options.assetKey,
    renderers: options.renderers,
    backdrop: resolveBackdrop(options, document, { palette, colors: options.colors ?? buildFallbackShapeColors(colorScheme), colorScheme }),
    backdropTexture: options.backgroundTexture,
    ...(plan.page ? { page: plan.page } : {}),
    ...(gpu && owners.length ? { shaders: { renderer, owners, layers: options.shaderLayers } } : {}),
  });

  const flattened = renderer.type === RendererType.CANVAS ? flattenBoardEffects(renderer, exportScene.root, plan.scale, new Rectangle(0, 0, plan.width, plan.height)) : null;
  try {
    const texture = renderer.textureGenerator.generateTexture({
      target: exportScene.root,
      frame: new Rectangle(0, 0, plan.width, plan.height),
      resolution: 1,
      antialias: true,
      clearColor: options.background === "transparent" ? undefined : palette.bg,
    });
    let canvas: ICanvas;
    const surface = renderer.type === RendererType.CANVAS ? texture.source.resource as ICanvas : undefined;
    try {
      canvas = renderer.texture.generateCanvas(texture);
    } finally {
      texture.destroy(true);
      // CanvasRenderer drops the source reference but does not release its native surface.
      if (surface) {
        surface.width = 1;
        surface.height = 1;
      }
    }

    const warnings: BoardExportWarning[] = [];
    if (plan.clamped) {
      warnings.push({
        kind: "scale-clamped",
        requested: plan.requestedScale,
        applied: plan.scale,
      });
    }
    if (exportScene.missingImageKeys.length > 0) {
      warnings.push({ kind: "images-missing", keys: exportScene.missingImageKeys });
    }
    if (plan.items.length > BOARD_EXPORT_ITEM_WARN_THRESHOLD) {
      warnings.push({ kind: "many-items", count: plan.items.length });
    }
    if (owners.length && !gpu) {
      const drawn = owners.filter((owner) => !owner.root && owner.output.draws).map((owner) => owner.id);
      warnings.push({ kind: "shaders-unsupported", drawn, omitted: owners.map((owner) => owner.id).filter((id) => !drawn.includes(id)) });
    }
    for (const failure of exportScene.shaderErrors) warnings.push({ kind: "shader-failed", ...failure });
    if (gpu) for (const miss of boardShaderMisses(scene, plan, owners, exportScene.shaderErrors)) warnings.push({ kind: "shader-hidden", ...miss });
    return { canvas, plan, warnings };
  } finally {
    exportScene.destroy();
    flattened?.();
  }
}

export function boardShaderMisses(
  scene: BoardScene,
  plan: Pick<BoardExportPlan, "items" | "world">,
  owners: readonly BoardShaderOwner[],
  failed: readonly { id: string }[] = [],
): Array<{ ids: string[]; reason: string }> {
  const planned = new Set(plan.items.map((item) => item.id));
  const misses = owners.flatMap(({ id, root, output }) => {
    if (failed.some((failure) => failure.id === id)) return [];
    const shader = output.shader;
    if (shader && !shader.state && shader.passes.every((pass) => !boardShaderPassOn(pass, output.passes)))
      return [{ id, reason: "every pass is switched off (ctx.passes() or enabled: false)" }];
    if (root) return [];
    const item = scene.get(id);
    if (!item) return [{ id, reason: "its item is not in the document" }];
    if (scene.opacity(id) <= 0) return [{ id, reason: "its item is hidden (opacity 0 or invisible)" }];
    if (planned.has(id)) return [];
    const bounds = exportItemBounds(item, scene);
    return [{ id, reason: bounds ? "its item is outside the exported area" : "its item is clipped away by a parent frame" }];
  });
  const grouped = new Map<string, string[]>();
  for (const { id, reason } of misses) grouped.set(reason, [...(grouped.get(reason) ?? []), id]);
  return [...grouped].map(([reason, ids]) => ({ ids, reason }));
}

function listIds(ids: readonly string[]): string {
  return ids.length > 3 ? `${ids.slice(0, 3).join(", ")} and ${ids.length - 3} more` : ids.join(", ");
}

export function describeBoardExportWarning(warning: BoardExportWarning): string {
  switch (warning.kind) {
    case "scale-clamped":
      return `Scale reduced from ${warning.requested}x to ${warning.applied.toFixed(2)}x to stay within the size limit.`;
    case "images-missing":
      return warning.keys.length === 1
        ? "1 image could not be loaded and was drawn as a placeholder."
        : `${warning.keys.length} images could not be loaded and were drawn as placeholders.`;
    case "many-items":
      return `${warning.count} items exported; this may take a moment.`;
    case "shaders-unsupported": {
      const parts = [
        warning.omitted.length ? `left out ${listIds(warning.omitted)}` : "",
        warning.drawn.length ? `drew ${listIds(warning.drawn)} with draw()` : "",
      ].filter(Boolean);
      return `Shaders need a WebGL renderer; this export ${parts.join(" and ")}.`;
    }
    case "shader-failed":
      return `Shader ${warning.id} was left out: ${warning.message}`;
    case "shader-hidden":
      return `${warning.ids.length === 1 ? "Shader" : "Shaders"} of ${listIds(warning.ids)} drew nothing: ${warning.reason.replace(/^its item is/, warning.ids.length === 1 ? "its item is" : "their items are")}.`;
  }
}
