
import type { BoardDocument } from "@cohub/protocol";
import { boardDocumentAt } from "../animation.js";
import { type BoardSceneItem, buildBoardScene } from "../core/scene.js";
import { type ICanvas, Rectangle, type Renderer, type Texture } from "pixi.js";
import { parseBoardCssColor } from "../render/css-color.js";
import type { BoardShapeColors } from "../core/palette.js";
import {
  BOARD_EXPORT_ITEM_WARN_THRESHOLD,
  type BoardExportPlan,
  type BoardExportRegion,
  normalizeBoardDocument,
  planBoardExport,
} from "../core/export-plan.js";
import {
  type BoardRenderPalette,
  defaultBoardPalette,
} from "../render/index.js";
import { ensureBoardTextMeasurement } from "../render/text-measurement.js";
import type { BoardSketchHost } from "../render/renderers/board-renderer-registry.js";
import { createBoardExportScene } from "./scene.js";

export type {
  BoardExportPlan,
  BoardExportPlanInput,
  BoardExportRegion,
} from "../core/export-plan.js";
export { createBoardExportScene } from "./scene.js";
export type { BoardExportScene, BoardExportSceneInput } from "./scene.js";

export type BoardExportBackground = "paper" | "transparent" | number;

export type BoardExportOptions = {
  region?: BoardExportRegion;
  at?: { animation?: string; time: number };
  scale?: number;
  padding?: number;
  colorScheme?: "dark" | "light";
  background?: BoardExportBackground;
  palette?: Partial<BoardRenderPalette>;
  colors?: BoardShapeColors;
  textures?: Map<string, Texture>;
  sketches?: BoardSketchHost;
  assetKey?: (item: BoardSceneItem) => string | null;
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

export function renderBoardExport(
  renderer: Renderer,
  input: BoardDocument,
  options: BoardExportOptions = {},
): BoardExportResult | null {
  ensureBoardTextMeasurement();
  const base = normalizeBoardDocument(input);
  const document = options.at ? boardDocumentAt(base, options.at.animation ?? null, options.at.time).document : base;
  const scene = buildBoardScene(document);
  const plan = planBoardExport({
    scene,
    region: options.region ?? { kind: "all" },
    scale: options.scale,
    padding: options.padding,
    maxEdge: options.maxEdge,
    maxPixels: options.maxPixels,
  });
  if (!plan) return null;

  const colorScheme = options.colorScheme ?? "dark";
  const palette = { ...defaultBoardPalette(colorScheme), ...options.palette };
  const exportScene = createBoardExportScene({
    settings: document.board,
    scene,
    items: plan.items,
    time: options.at?.time ?? 0,
    world: plan.world,
    scale: plan.scale,
    colorScheme,
    palette,
    colors: options.colors,
    textures: options.textures,
    sketches: options.sketches,
    assetKey: options.assetKey,
    background: resolveBackground(options.background, palette, document, colorScheme),
    backgroundImage: options.backgroundImage,
  });

  try {
    const canvas = renderer.extract.canvas({
      target: exportScene.root,
      frame: new Rectangle(0, 0, plan.width, plan.height),
      resolution: 1,
      antialias: true,
      clearColor: options.background === "transparent" ? undefined : palette.bg,
    });

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
