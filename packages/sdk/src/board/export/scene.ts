
import { Container, Graphics, Sprite, TilingSprite, type Texture } from "pixi.js";
import type { BoardShapeColors } from "../core/palette.js";
import { buildFallbackShapeColors } from "../core/palette.js";
import { imageAssetKey } from "../image-key.js";
import {
  type BoardRenderContext,
  type BoardRenderPalette,
  defaultBoardPalette,
  getBoardCardRenderer,
} from "../render/index.js";
import type { BoardSettings } from "@cohub/protocol";
import type { BoardScene, BoardSceneItem } from "../core/scene.js";
import type { Rect } from "../geometry.js";
import { clippingAncestor, isClippingFrame, syncClipGroup } from "../render/clip.js";

export type BoardExportSceneInput = {
  settings: BoardSettings;
  scene: BoardScene;
  items: readonly BoardSceneItem[];
  time?: number;
  world: Rect;
  scale: number;
  colorScheme: "dark" | "light";
  palette?: Partial<BoardRenderPalette>;
  colors?: BoardShapeColors;
  textures?: Map<string, Texture>;
  sketches?: BoardRenderContext["sketches"];
  assetKey?: (item: BoardSceneItem) => string | null;
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
    selectedIds: new Set(),
    hoveredId: null,
    resizingIds: new Set(),
    palette: { ...defaultBoardPalette(input.colorScheme), ...input.palette },
    colors: input.colors ?? buildFallbackShapeColors(input.colorScheme),
    colorScheme: input.colorScheme,
    rendererType: "canvas",
    zoom: input.scale,
    sketches: input.sketches,
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

  const groups = new Map<string, Container>();
  for (const item of input.items) {
    const clip = clippingAncestor(input.scene, item);
    const host = (clip && groups.get(clip)) || world;
    const container = getBoardCardRenderer(item, context).create(item, context);
    container.alpha = input.scene.opacity(item.id);
    host.addChild(container);
    if (isClippingFrame(item)) {
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
