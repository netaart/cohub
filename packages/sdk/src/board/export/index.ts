
import type { BoardDocument } from "@cohub/protocol";
import { resolveBoardAnimationCamera, type BoardAnimationSampler } from "../model/sampling.js";
import { createBoardRenderSampler } from "../render/sampling.js";
import { type BoardSceneItem, buildBoardScene } from "../model/scene.js";
import { type ICanvas, Rectangle, type Renderer, RendererType, type Texture } from "pixi.js";
import { parseBoardCssColor } from "../render/css-color.js";
import type { BoardShapeColors } from "../model/palette.js";
import {
  BOARD_EXPORT_ITEM_WARN_THRESHOLD,
  type BoardExportPlan,
  type BoardExportRegion,
  normalizeBoardDocument,
  planBoardExport,
} from "../model/export-plan.js";
import {
  type BoardRenderPalette,
  type BoardRenderStyleInput,
  defaultBoardPalette,
} from "../render/index.js";
import { ensureBoardTextMeasurement } from "../render/text-measurement.js";
import type { BoardCardRendererResolver, BoardScriptHost } from "../render/renderers/board-renderer-registry.js";
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
  scripts?: BoardScriptHost;
  assetKey?: (item: BoardSceneItem) => string | null;
  renderers?: BoardCardRendererResolver;
  backgroundImage?: {
    texture: Texture;
    fit: "cover" | "contain" | "repeat";
    position: "center" | "top" | "bottom" | "left" | "right";
    opacity: number;
  };
  maxEdge?: number;
  maxPixels?: number;
};

export type BoardExportWarning =
  | { kind: "scale-clamped"; requested: number; applied: number }
  | { kind: "images-missing"; keys: string[] }
  | { kind: "many-items"; count: number };

export type BoardExportResult = {
  canvas: ICanvas;
  plan: BoardExportPlan;
  warnings: BoardExportWarning[];
};

function resolveBackground(
  background: BoardExportBackground | undefined,
  palette: BoardRenderPalette,
  document: BoardDocument,
  colorScheme: "dark" | "light",
): number | null {
  if (background === "transparent") return null;
  if (typeof background === "number") return background;
  const declared = document.board.background.color;
  const css = typeof declared === "object" ? declared[colorScheme] : declared;
  return css ? (parseBoardCssColor(css) ?? palette.bg) : palette.bg;
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
  const camera = options.camera ? resolveBoardAnimationCamera(sample?.evaluation.camera ?? {}, (id) => scene.get(id)?.frame, options.camera, options.at?.time ?? 0) : undefined;
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
    scripts: options.scripts,
    assetKey: options.assetKey,
    renderers: options.renderers,
    background: resolveBackground(options.background, palette, document, colorScheme),
    backgroundImage: options.backgroundImage,
  });

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
    return { canvas, plan, warnings };
  } finally {
    exportScene.destroy();
  }
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
  }
}
