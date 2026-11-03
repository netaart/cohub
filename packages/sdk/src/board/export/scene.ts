
import { multiplyMatrix } from "@cohub/protocol/board-layout";
import { Container, type Filter, Graphics, Rectangle, type Renderer, Sprite, type Texture } from "pixi.js";
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
import { itemBounds, type Rect } from "../model/geometry.js";
import { createBoardAtmosphereLayer } from "../render/atmosphere.js";
import { clipFrameShaderLayer, type FrameGroup, groupingAncestor, isGroupingFrame, isSelfGroupedFrame, syncBoardItemEffects, syncFrameGroup } from "../render/frame-group.js";
import { textureIsCutout } from "../render/cutout.js";
import { setBoardShaderFilters } from "../render/effects.js";
import { positionShell } from "../render/renderers/base-card-renderer.js";
import type { BoardShaderLayer } from "../render/shader/layer.js";
import { type BoardShaderLayers, type BoardShaderOwner, type BoardShaderPlacement, boardShaderColor, createBoardShaderLayers } from "../render/shader/layers.js";
import { boardItemLocalToWorld, boardLocalView } from "../render/shader/placement.js";

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
  page?: string;
  shaders?: { renderer: Renderer; owners: readonly BoardShaderOwner[]; quality?: number; layers?: BoardShaderLayers };
};

export type BoardExportScene = {
  root: Container;
  missingImageKeys: string[];
  shaderErrors: Array<{ id: string; message: string }>;
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
    ...(input.page ? { page: input.page } : {}),
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
  const containers = new Map<string, Container>();
  for (const item of input.items) {
    const opacity = input.scene.opacity(item.id);
    if (opacity <= 0) continue;
    const host = isSelfGroupedFrame(item) ? groupOf(item).group : outerHost(item);
    const container = resolve(item, context).create(item, context);
    containers.set(item.id, container);
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
  const shaderErrors: Array<{ id: string; message: string }> = [];
  const layers = input.shaders?.owners.length ? (input.shaders.layers ?? createBoardShaderLayers({ wait: true })) : null;
  if (layers && input.shaders) {
    const toOutput = [input.scale, 0, 0, input.scale, -input.world.x * input.scale, -input.world.y * input.scale] as const;
    const layer = (label: string) => {
      const container = new Container({ label });
      container.scale.set(input.scale);
      container.position.copyFrom(world.position);
      return container;
    };
    const below = root.addChildAt(layer("board-shaders-below"), root.getChildIndex(world));
    const above = root.addChildAt(layer("board-shaders-above"), root.getChildIndex(world) + 1);
    const filters = new Map<string, readonly Filter[]>();
    const attach = (owner: BoardShaderOwner, layer: BoardShaderLayer | null): BoardShaderPlacement | null => {
      if (!layer) return null;
      if (owner.root) {
        if (layer.below) below.addChild(layer.below);
        if (layer.above) above.addChild(layer.above);
        if (layer.filters) {
          filters.set(owner.id, layer.filters);
          setBoardShaderFilters(world, [...filters.values()].flat());
          world.filterArea = new Rectangle(input.world.x, input.world.y, input.world.width, input.world.height);
        }
        return { region: input.world, view: input.world, localToWorld: [1, 0, 0, 1, 0, 0], localToGlobal: toOutput };
      }
      const item = input.scene.get(owner.id);
      const container = containers.get(owner.id);
      if (!item || !container) return null;
      const group = isSelfGroupedFrame(item) ? groups.get(item.id)?.group : undefined;
      for (const part of [layer.below, layer.above]) if (part && item.type === "frame") clipFrameShaderLayer(part, item);
      if (layer.below) container.addChildAt(layer.below, 0);
      if (layer.above) {
        if (group) {
          positionShell(layer.above, item);
          layer.above.zIndex = Number.MAX_SAFE_INTEGER;
        }
        (group ?? container).addChild(layer.above);
      }
      if (layer.filters) {
        const host = group ?? container;
        setBoardShaderFilters(host, layer.filters);
        const box = group ? itemBounds(item.frame) : { x: 0, y: 0, width: item.frame.width, height: item.frame.height };
        host.filterArea = new Rectangle(box.x, box.y, box.width, box.height);
      }
      const localToWorld = boardItemLocalToWorld(item.frame);
      return {
        region: { x: 0, y: 0, width: item.frame.width, height: item.frame.height },
        view: boardLocalView(input.world, localToWorld),
        localToWorld,
        localToGlobal: multiplyMatrix(toOutput, localToWorld),
      };
    };
    layers.sync(input.shaders.renderer, input.shaders.owners, {
      zoom: input.scale,
      density: 1,
      quality: input.shaders.quality ?? 1,
      dark: input.colorScheme === "dark",
      color: (value) => boardShaderColor(context, value),
      fault: (id, message) => shaderErrors.push({ id, message }),
      attach,
    }, input.scene);
    layers.prepare(input.shaders.renderer, true);
  }
  if (input.settings.atmosphere) {
    const atmosphere = createBoardAtmosphereLayer();
    atmosphere.sync(input.settings.atmosphere, { width: outputWidth, height: outputHeight, density: 1 });
    root.addChild(atmosphere.container);
  }

  return {
    root,
    missingImageKeys: [...missing],
    shaderErrors,
    destroy: () => {
      if (layers === input.shaders?.layers) layers?.detach();
      else layers?.destroy();
      backdrop?.destroy();
      root.destroy({ children: true });
    },
  };
}
