
import { Container, Graphics, Sprite, TilingSprite, type Texture } from "pixi.js";
import type { BoardShapeColors } from "../model/palette.js";
import { buildFallbackShapeColors } from "../model/palette.js";
import { imageAssetKey } from "../model/image-key.js";
import {
  type BoardCardRendererResolver,
  type BoardRenderContext,
  type BoardRenderPalette,
  DEFAULT_BOARD_RENDER_LABELS,
  type BoardRenderStyle,
  defaultBoardPalette,
  getBoardCardRenderer,
  resolveBoardRenderStyle,
} from "../render/index.js";
import type { BoardSettings } from "@cohub/protocol";
import type { BoardScene, BoardSceneItem } from "../model/scene.js";
import type { Rect } from "../model/geometry.js";
import { clippingAncestor, isClippingFrame, syncClipGroup } from "../render/clip.js";

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
  style?: Partial<BoardRenderStyle>;
  textures?: Map<string, Texture>;
  scripts?: BoardRenderContext["scripts"];
  assetKey?: (item: BoardSceneItem) => string | null;
  /** Renderers for item types beyond the built-ins. */
  renderers?: BoardCardRendererResolver;
  background?: number | null;
  backgroundImage?: {
    texture: Texture;
    fit: "cover" | "contain" | "repeat";
    position: "center" | "top" | "bottom" | "left" | "right";
    opacity: number;
  };
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
    assetKey: input.assetKey ?? imageAssetKey,
    getTexture: (key) => textures.get(key) ?? null,
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
  if (input.background != null) {
    root.addChild(
      new Graphics()
        .rect(0, 0, outputWidth, outputHeight)
        .fill({ color: input.background, alpha: 1 }),
    );
  }
  if (input.backgroundImage) {
    const { texture, fit, position, opacity } = input.backgroundImage;
    if (fit === "repeat") {
      root.addChild(new TilingSprite({ texture, width: outputWidth, height: outputHeight, alpha: opacity }));
    } else {
      const sprite = new Sprite({ texture, alpha: opacity });
      const scale = fit === "cover"
        ? Math.max(outputWidth / texture.width, outputHeight / texture.height)
        : Math.min(outputWidth / texture.width, outputHeight / texture.height);
      sprite.width = texture.width * scale;
      sprite.height = texture.height * scale;
      const x = position === "left" ? 0 : position === "right" ? outputWidth - sprite.width : (outputWidth - sprite.width) / 2;
      const y = position === "top" ? 0 : position === "bottom" ? outputHeight - sprite.height : (outputHeight - sprite.height) / 2;
      sprite.position.set(x, y);
      root.addChild(sprite);
    }
  }

  const world = new Container({ isRenderGroup: true, label: "board-export-world" });
  world.scale.set(input.scale);
  world.position.set(-input.world.x * input.scale, -input.world.y * input.scale);

  const resolve = input.renderers ?? getBoardCardRenderer;
  const groups = new Map<string, Container>();
  function hostFor(item: BoardSceneItem): Container {
    const clip = clippingAncestor(input.scene, item);
    const ancestor = clip ? input.scene.get(clip) : undefined;
    if (!ancestor) return world;
    let group = groups.get(ancestor.id);
    if (!group) {
      group = syncClipGroup(undefined, ancestor).group;
      hostFor(ancestor).addChild(group);
      groups.set(ancestor.id, group);
    }
    return group;
  }
  for (const item of input.items) {
    const opacity = input.scene.opacity(item.id);
    if (opacity <= 0) continue;
    const host = hostFor(item);
    const container = resolve(item, context).create(item, context);
    container.alpha = opacity;
    host.addChild(container);
    if (isClippingFrame(item) && !groups.has(item.id)) {
      const { group } = syncClipGroup(undefined, item);
      host.addChild(group);
      groups.set(item.id, group);
    }
  }
  root.addChild(world);

  return {
    root,
    missingImageKeys: [...missing],
    destroy: () => root.destroy({ children: true }),
  };
}
