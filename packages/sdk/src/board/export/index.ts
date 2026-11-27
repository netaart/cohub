
import { type BoardDocument, isBoardDepthActive, resolveBoardDepth } from "@cohub/protocol";
import { resolveBoardAnimationCamera, type BoardAnimationSampler } from "../model/sampling.js";
import { boardProjection, boardViewRect, isBoardViewLevel } from "../model/view-camera.js";
import { type BoardViewport, pointToWorld } from "../model/geometry.js";
import type { BoardCameraOverride } from "../model/animation.js";
import { createBoardRenderSampler } from "../render/sampling.js";
import { type BoardSceneItem, buildBoardScene } from "../model/scene.js";
import { type ICanvas, Rectangle, type Renderer, RendererType, type Texture } from "pixi.js";
import { type BoardShapeColors, buildFallbackShapeColors } from "../model/palette.js";
import {
  BOARD_EXPORT_ITEM_WARN_THRESHOLD,
  BOARD_EXPORT_MAX_EDGE,
  BOARD_EXPORT_MAX_PIXELS,
  type BoardExportPlan,
  type BoardExportRegion,
  boardExportView,
  exportItemBounds,
  normalizeBoardDocument,
  planBoardExport,
} from "../model/export-plan.js";
import type { BoardScene } from "../model/scene.js";
import { boardShaderPassOn } from "../model/shader.js";
import { boardDepthRoots, isBoardModelObject } from "../model/depth.js";
import type { LoadedModel } from "../render/model3d/load.js";
import type { BoardDepthStage } from "../render/depth/index.js";
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
import { isBoardScriptScreenRoot } from "../model/script-scene.js";
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
  view?: BoardCameraOverride;
  viewport?: { width: number; height: number };
  screen?: boolean;
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
  depth?: BoardDepthStage;
  models?: ReadonlyMap<string, LoadedModel>;
};

export type BoardExportWarning =
  | { kind: "scale-clamped"; requested: number; applied: number }
  | { kind: "images-missing"; keys: string[] }
  | { kind: "many-items"; count: number }
  | { kind: "shaders-unsupported"; drawn: string[]; omitted: string[] }
  | { kind: "shader-failed"; id: string; message: string }
  | { kind: "shader-hidden"; ids: string[]; reason: string }
  | { kind: "depth-flat"; ids: string[] }
  | { kind: "camera-level" }
  | { kind: "models-flat"; ids: string[] };

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
  if (options.camera && !options.at && !options.view) throw new Error("Camera export needs an animation time or a view.");
  if (options.camera && (![options.camera.width, options.camera.height].every((n) => Number.isSafeInteger(n) && n > 0))) throw new Error("Camera dimensions must be positive integers.");
  const time = options.at?.time ?? 0;
  const sampler = options.at ? options.sampler ?? createBoardRenderSampler(base, options.at.animation ?? null, options) : undefined;
  const sample = options.at ? sampler?.at(options.at.time) : undefined;
  const sampled = sample?.document ?? base;
  let document = options.scripts?.document?.(sampled, time) ?? sampled;
  let scene = document === sampled ? sample?.scene ?? buildBoardScene(document) : buildBoardScene(document);
  const directed = options.camera && !options.view ? options.scripts?.camera?.(document, time) : null;
  const override = options.view ?? { ...sample?.evaluation.camera, ...directed };
  const camera = options.camera ? resolveBoardAnimationCamera(override, (id) => scene.get(id)?.frame, options.camera, time, undefined, options.viewport ?? sample?.evaluation.cameraViewport) : undefined;
  const region: BoardExportRegion = camera && options.camera ? { kind: "rect", rect: boardViewRect(camera, options.camera) } : options.region ?? { kind: "all" };
  const output = camera && options.camera;
  const fit = output ? Math.min(1, (options.maxEdge ?? BOARD_EXPORT_MAX_EDGE) / Math.max(output.width, output.height), Math.sqrt((options.maxPixels ?? BOARD_EXPORT_MAX_PIXELS) / (output.width * output.height))) : 1;
  const plan = planBoardExport({
    scene,
    region,
    scale: camera ? camera.zoom * fit : options.scale,
    padding: camera ? 0 : options.padding,
    maxEdge: output ? Number.POSITIVE_INFINITY : options.maxEdge,
    maxPixels: output ? Number.POSITIVE_INFINITY : options.maxPixels,
  });
  if (!plan) return null;
  let view: { view: BoardViewport; width: number; height: number } | undefined;
  if (camera && output) {
    plan.requestedScale = camera.zoom;
    plan.clamped = fit < 1;
    plan.width = Math.max(1, Math.floor(output.width * fit));
    plan.height = Math.max(1, Math.floor(output.height * fit));
    view = { view: { ...camera, x: camera.x * fit, y: camera.y * fit, zoom: camera.zoom * fit }, width: plan.width, height: plan.height };
  }
  if (options.screen && options.scripts?.document) {
    const shown = view?.view ?? boardExportView(plan).camera;
    const projection = isBoardViewLevel(shown) ? null : boardProjection(shown, plan);
    document = options.scripts.document(sampled, time, { ...shown, ...(projection ? { place: (point) => pointToWorld(projection.project(point.x, point.y), shown) } : {}) });
    const composed = buildBoardScene(document);
    const onScreen = (item: BoardSceneItem) => {
      for (let at: BoardSceneItem | undefined = item, depth = 0; at && depth < 64; at = at.parent ? composed.get(at.parent) : undefined, depth++)
        if (isBoardScriptScreenRoot(at.id)) return true;
      return false;
    };
    const shownItems = planBoardExport({ scene: composed, region: { kind: "rect", rect: plan.world }, scale: plan.scale, padding: 0, maxEdge: Number.POSITIVE_INFINITY, maxPixels: Number.POSITIVE_INFINITY })?.items.filter(onScreen) ?? [];
    plan.items = [...plan.items.map((item) => composed.get(item.id) ?? item), ...shownItems];
    plan.extras = plan.extras.map((item) => composed.get(item.id) ?? item);
    scene = composed;
  }
  return { document, scene, plan, sampler, camera: view };
}

type PreparedBoardExport = NonNullable<ReturnType<typeof prepareBoardExport>>;

export function boardExportUsesDepth({ scene, plan, camera }: PreparedBoardExport): boolean {
  if (camera && !isBoardViewLevel(camera.view)) return true;
  const planned = new Set(plan.items.map((item) => item.id));
  return boardDepthRoots(scene).some((root) => planned.has(root.id) && scene.opacity(root.id) > 0);
}

export function boardExportShaders({ scene, plan }: PreparedBoardExport, owners: readonly BoardShaderOwner[]): BoardShaderOwner[] {
  const planned = new Set(plan.items.map((item) => item.id));
  return owners.filter(({ id, root, output: { shader, passes } }) => Boolean(shader?.state)
    || (Boolean(shader?.passes.some((pass) => boardShaderPassOn(pass, passes))) && (root || (planned.has(id) && scene.opacity(id) > 0))));
}

export function renderBoardExport(renderer: Renderer, input: BoardDocument, options: BoardExportOptions = {}): BoardExportResult | null {
  const prepared = prepareBoardExport(input, options);
  if (!prepared) return null;
  const { document, scene, plan, sampler, camera } = prepared;
  const colorScheme = options.colorScheme ?? "dark";
  const palette = { ...defaultBoardPalette(colorScheme), ...options.palette };
  const owners = options.scripts?.shaders?.(document, options.at?.time ?? 0) ?? [];
  const gpu = renderer.type === RendererType.WEBGL;
  const exportScene = createBoardExportScene({
    settings: document.board,
    scene,
    items: plan.items,
    extras: plan.extras,
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
    ...(gpu && options.depth ? { depth: { renderer, stage: options.depth, models: options.models } } : {}),
    ...(camera ? { camera } : {}),
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
    const drawing = gpu ? [] : boardExportShaders(prepared, owners);
    if (drawing.length) {
      const drawn = drawing.filter((owner) => !owner.root && owner.output.draws).map((owner) => owner.id);
      warnings.push({ kind: "shaders-unsupported", drawn, omitted: drawing.map((owner) => owner.id).filter((id) => !drawn.includes(id)) });
    }
    for (const failure of exportScene.shaderErrors) warnings.push({ kind: "shader-failed", ...failure });
    const planned = new Set(plan.items.map((item) => item.id));
    if ((!gpu || !options.depth) && camera && !isBoardViewLevel(camera.view)) warnings.push({ kind: "camera-level" });
    if (!gpu || !options.depth) {
      const flat = boardDepthRoots(scene).filter((item) => planned.has(item.id) && scene.opacity(item.id) > 0 && isBoardDepthActive(resolveBoardDepth(item.depth))).map((item) => item.id);
      if (flat.length) warnings.push({ kind: "depth-flat", ids: flat });
    }
    const drawn = gpu && options.depth ? options.models : undefined;
    const cards = plan.items.filter((item) => isBoardModelObject(item) && scene.opacity(item.id) > 0 && !drawn?.has(item.id)).map((item) => item.id);
    if (cards.length) warnings.push({ kind: "models-flat", ids: cards });
    for (const miss of boardShaderMisses(scene, plan, owners, exportScene.shaderErrors)) warnings.push({ kind: "shader-hidden", ...miss });
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
    if (planned.has(id) || exportItemBounds(item, scene)) return [];
    return [{ id, reason: "its item is clipped away by a parent frame" }];
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
    case "models-flat":
      return `${listIds(warning.ids)} could not be drawn in 3D; this export shows ${warning.ids.length === 1 ? "its card" : "their cards"}.`;
    case "depth-flat":
      return `${listIds(warning.ids)} ${warning.ids.length === 1 ? "is" : "are"} lifted off the Board; this export draws ${warning.ids.length === 1 ? "it" : "them"} flat because depth needs WebGL.`;
    case "camera-level":
      return "The camera tips or turns, which needs WebGL; this export shows it level.";
    case "shader-hidden":
      return `${warning.ids.length === 1 ? "Shader" : "Shaders"} of ${listIds(warning.ids)} drew nothing: ${warning.reason.replace(/^its item is/, warning.ids.length === 1 ? "its item is" : "their items are")}.`;
  }
}
