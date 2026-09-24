/**
 * Build a throwaway Pixi scene for one export.
 *
 * This uses the same canonical Board geometry and card semantics as the editor;
 * only the backend-specific drawing primitive differs. Unlike the live scene it
 * is deliberately naive — no culling, no pooling, no far LOD — because
 * an export must be complete and runs once, so every optimisation the editor
 * needs here would only cost fidelity.
 */

import type { BoardDocument, BoardItem } from "@cohub/protocol/board-document";
import type { BoardConnection } from "@cohub/protocol/board-connection";
import { Container, Graphics, Sprite, TilingSprite, type Texture } from "pixi.js";
import type { BoardShapeColors } from "../core/palette.js";
import { buildFallbackShapeColors } from "../core/palette.js";
import { imageAssetKey } from "../image-key.js";
import {
  type BoardRenderContext,
  type BoardRenderPalette,
  createConnectionLayer,
  defaultBoardPalette,
  getBoardCardRenderer,
} from "../render/index.js";
import type { Rect } from "../geometry.js";

export type BoardExportSceneInput = {
  document: BoardDocument;
  /** Items to draw, in document (z) order. */
  items: BoardItem[];
  /** Connections to draw. Rendered beneath the cards, as in the editor. */
  connections?: readonly BoardConnection[];
  /** World rect being captured; content is translated so it starts at 0,0. */
  world: Rect;
  /** Output pixels per world unit. Drives text rasterisation resolution. */
  scale: number;
  colorScheme: "dark" | "light";
  palette?: Partial<BoardRenderPalette>;
  colors?: BoardShapeColors;
  /** Resolved textures by preview key. Missing keys render as placeholders. */
  textures?: Map<string, Texture>;
  /** Preview-key strategy supplied by the host; defaults to still images only. */
  assetKey?: (item: BoardItem) => string | null;
  /** Opaque paper behind the content, or null for transparency. */
  background?: number | null;
  backgroundImage?: {
    texture: Texture;
    fit: "cover" | "contain" | "repeat";
    position: "center" | "top" | "bottom" | "left" | "right";
    opacity: number;
  };
};

export type BoardExportScene = {
  /** Root to hand to the renderer; already positioned and scaled. */
  root: Container;
  /** Image keys the scene wanted but could not resolve. */
  missingImageKeys: string[];
  destroy: () => void;
};

/**
 * Render context for an export.
 *
 * Interaction state is empty by construction: nothing is selected, hovered or
 * resizing, so no editor chrome (outlines, handles) can leak into the image.
 */
function buildContext(input: BoardExportSceneInput): {
  context: BoardRenderContext;
  missing: Set<string>;
} {
  const missing = new Set<string>();
  const byId = new Map(input.document.items.map((item) => [item.id, item]));
  const textures = input.textures ?? new Map<string, Texture>();
  const context: BoardRenderContext = {
    document: input.document,
    getItem: (id) => byId.get(id) ?? null,
    selectedIds: new Set(),
    hoveredId: null,
    resizingIds: new Set(),
    palette: { ...defaultBoardPalette(input.colorScheme), ...input.palette },
    colors: input.colors ?? buildFallbackShapeColors(input.colorScheme),
    colorScheme: input.colorScheme,
    rendererType: "canvas",
    // Text rasterises against this, so passing the export scale (not the
    // editor's camera zoom) is what keeps exported glyphs crisp at any factor.
    zoom: input.scale,
    assetKey: input.assetKey ?? imageAssetKey,
    getTexture: (key) => textures.get(key) ?? null,
    hasError: (key) => {
      // An unresolved key is reported rather than retried: the exporter has
      // already had its chance to load everything it could.
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

  // One render group: the whole export is a single transform, so the camera
  // offset and scale are applied once instead of per card.
  const world = new Container({ isRenderGroup: true, label: "board-export-world" });
  world.scale.set(input.scale);
  world.position.set(-input.world.x * input.scale, -input.world.y * input.scale);

  // Connections first, so relations sit beneath the nodes they join - the same
  // stacking the editor uses, which is what keeps an export faithful to it.
  const connections = input.connections ?? input.document.connections;
  let connectionLayer: ReturnType<typeof createConnectionLayer> | null = null;
  if (connections.length > 0) {
    const frames = new Map(input.document.items.map((item) => [item.id, item.frame]));
    connectionLayer = createConnectionLayer({ parent: world });
    connectionLayer.sync({
      connections,
      getFrame: (id) => frames.get(id),
      colors: context.colors,
      colorScheme: input.colorScheme,
      zoom: input.scale,
      cullRect: input.world,
    });
  }

  for (const item of input.items) {
    const renderer = getBoardCardRenderer(item, context);
    world.addChild(renderer.create(item, context));
  }
  root.addChild(world);

  return {
    root,
    missingImageKeys: [...missing],
    destroy: () => {
      connectionLayer?.destroy();
      root.destroy({ children: true });
    },
  };
}
