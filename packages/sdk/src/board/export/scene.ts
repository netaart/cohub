
import { Container, Graphics, Sprite, type Texture } from "pixi.js";
import type { BoardShapeColors } from "../model/palette.js";
import { buildFallbackShapeColors } from "../model/palette.js";
import { boardAssetKey } from "../model/asset-key.js";
import {
  type BoardCardRendererResolver,
  type BoardRenderContext,
  type BoardRenderPalette,
  DEFAULT_BOARD_RENDER_LABELS,
  type BoardRenderStyleInput,
  defaultBoardPalette,
  getBoardCardRenderer,
  resolveBoardRenderStyle,
  type BoardBackdrop,
  type BoardBackdropLayer,
  createBoardBackdropLayer,
} from "../render/index.js";
import type { BoardSettings } from "@cohub/protocol";
import type { BoardScene, BoardSceneItem } from "../model/scene.js";
import type { Rect } from "../model/geometry.js";
import { createBoardAtmosphereLayer } from "../render/atmosphere.js";
import { type FrameGroup, groupingAncestor, isGroupingFrame, isSelfGroupedFrame, syncBoardItemEffects, syncFrameGroup } from "../render/frame-group.js";
import { textureIsCutout } from "../render/cutout.js";

export type BoardExportSceneInput = {
  settings: BoardSettings;
  scene: BoardScene;
  items: readonly BoardSceneItem[];
  time?: number;
  frameAt?: BoardRenderContext["frameAt"];
  world: Rect;
  scale: number;
  colorScheme: "dark" | "light";
  palette?: Partial<BoardRenderPalette>;
  colors?: BoardShapeColors;
  style?: BoardRenderStyleInput;
  textures?: Map<string, Texture>;
  viewTextures?: ReadonlyMap<string, Texture>;
  scripts?: BoardRenderContext["scripts"];
  assetKey?: (item: BoardSceneItem) => string | null;
  /** Renderers for item types beyond the built-ins. */
  renderers?: BoardCardRendererResolver;
  backdrop?: BoardBackdrop | null;
  backdropTexture?: Texture;
};

export type BoardExportScene = {
  root: Container;
  missingImageKeys: string[];
  destroy: () => void;
};

function buildContext(input: BoardExportSceneInput): {
  context: BoardRenderContext;
  missing: Set<string>;
} {
  const missing = new Set<string>();
  const textures = input.textures ?? new Map<string, Texture>();
  const context: BoardRenderContext = {
    settings: input.settings,
    scene: input.scene,
    time: input.time ?? 0,
    frameAt: input.frameAt,
    selectedIds: new Set(),
    hoveredId: null,
    resizingIds: new Set(),
    liftedIds: new Set(),
    palette: { ...defaultBoardPalette(input.colorScheme), ...input.palette },
    colors: input.colors ?? buildFallbackShapeColors(input.colorScheme),
    colorScheme: input.colorScheme,
    style: resolveBoardRenderStyle(input.colorScheme, input.style),
    themeKey: "export",
    rendererType: "canvas",
    zoom: input.scale,
    textResolution: input.scale,
    reducedMotion: true,
    labels: DEFAULT_BOARD_RENDER_LABELS,
    taskRun: () => null,
    scripts: input.scripts,
    assetKey: input.assetKey ?? boardAssetKey,
    getTexture: (key) => textures.get(key) ?? null,
    assetCutout: (key) => textureIsCutout(textures.get(key)),
    hasError: (key) => {
      if (!textures.has(key)) missing.add(key);
      return false;
    },
    fileState: () => "ok",
    acquireTexture: () => {},
    releaseTexture: () => {},
  };
  return { context, missing };
}

export function createBoardExportScene(input: BoardExportSceneInput): BoardExportScene {
  const { context, missing } = buildContext(input);
  const root = new Container({ label: "board-export-root" });

  const outputWidth = input.world.width * input.scale;
  const outputHeight = input.world.height * input.scale;
  let backdrop: BoardBackdropLayer | null = null;
  if (input.backdrop) {
    root.addChild(new Graphics().rect(0, 0, outputWidth, outputHeight).fill({ color: input.backdrop.color, alpha: 1 }));
    backdrop = createBoardBackdropLayer({ patterns: false });
    const view = { x: -input.world.x * input.scale, y: -input.world.y * input.scale, zoom: input.scale, width: outputWidth, height: outputHeight, density: 1 };
    backdrop.sync(input.backdrop, view, input.backdropTexture ?? null);
    root.addChild(backdrop.container);
  }

  const world = new Container({ label: "board-export-world" });
  world.scale.set(input.scale);
  world.position.set(-input.world.x * input.scale, -input.world.y * input.scale);

  const resolve = input.renderers ?? getBoardCardRenderer;
  const groups = new Map<string, FrameGroup>();
  function groupOf(frame: BoardSceneItem): FrameGroup {
    let entry = groups.get(frame.id);
    if (!entry) {
      entry = syncFrameGroup(undefined, frame, context);
      outerHost(frame).addChild(entry.group);
      groups.set(frame.id, entry);
    }
    return entry;
  }
  function outerHost(item: BoardSceneItem): Container {
    const frame = input.scene.get(groupingAncestor(input.scene, item) ?? "");
    return frame ? groupOf(frame).content : world;
  }
  for (const item of input.items) {
    const opacity = input.scene.opacity(item.id);
    if (opacity <= 0) continue;
    const host = isSelfGroupedFrame(item) ? groupOf(item).group : outerHost(item);
    const container = resolve(item, context).create(item, context);
    container.alpha = opacity;
    syncBoardItemEffects(container, item, context);
    const view = input.viewTextures?.get(item.id);
    if (view) container.addChild(new Sprite(view)).setSize(item.frame.width, item.frame.height);
    host.addChild(container);
    if (isGroupingFrame(item)) {
      const { group, content } = groupOf(item);
      group.addChild(content);
    }
  }
  root.addChild(world);
  if (input.settings.atmosphere) {
    const atmosphere = createBoardAtmosphereLayer();
    atmosphere.sync(input.settings.atmosphere, { width: outputWidth, height: outputHeight, density: 1 });
    root.addChild(atmosphere.container);
  }

  return {
    root,
    missingImageKeys: [...missing],
    destroy: () => {
      backdrop?.destroy();
      root.destroy({ children: true });
    },
  };
}
