
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
import { type BoardSettings, isBoardDepthActive, resolveBoardDepth } from "@cohub/protocol";
import type { BoardScene, BoardSceneItem } from "../model/scene.js";
import { type BoardViewport, itemBounds, type Rect } from "../model/geometry.js";
import { createBoardAtmosphereLayer } from "../render/atmosphere.js";
import { clipFrameShaderLayer, type FrameGroup, groupingAncestor, isGroupingFrame, isSelfGroupedFrame, syncBoardItemEffects, syncFrameGroup } from "../render/frame-group.js";
import { textureIsCutout } from "../render/cutout.js";
import { setBoardShaderFilters } from "../render/effects.js";
import { positionShell } from "../render/renderers/base-card-renderer.js";
import type { BoardShaderLayer } from "../render/shader/layer.js";
import { type BoardShaderLayers, type BoardShaderOwner, type BoardShaderPlacement, boardShaderColor, createBoardShaderLayers } from "../render/shader/layers.js";
import { boardItemLocalToWorld, boardLocalView } from "../render/shader/placement.js";
import { type BoardDepthShadow, type BoardDepthView, boardAttachedNode, boardDepthContactShadow, boardDepthOf, boardDepthPose, boardDepthRiding, boardDepthRoots, boardDepthShadow, boardDepthSurface } from "../model/depth.js";
import { boardProjection, boardViewBearing, boardViewCenter, isBoardViewLevel, isBoardViewPitched } from "../model/view-camera.js";
import { boardModelPlayback } from "../model/model-clips.js";
import { isBoardScriptScreenRoot } from "../model/script-scene.js";
import type { LoadedModel } from "../render/model3d/load.js";
import {
  type BoardDepthLayer,
  type BoardDepthObject,
  type BoardDepthPicture,
  type BoardDepthStage,
  boardDepthDensity,
  createBoardDepthPicture,
  createBoardDepthShadows,
  drawBoardDepthParts,
  resolveBoardDepthBend,
} from "../render/depth/index.js";

export type BoardExportSceneInput = {
  settings: BoardSettings;
  scene: BoardScene;
  items: readonly BoardSceneItem[];
  extras?: readonly BoardSceneItem[];
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
  depth?: { renderer: Renderer; stage: BoardDepthStage; models?: ReadonlyMap<string, LoadedModel> };
  camera?: { view: BoardViewport; width: number; height: number };
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

  const outputWidth = input.camera?.width ?? input.world.width * input.scale;
  const outputHeight = input.camera?.height ?? input.world.height * input.scale;
  const camera = input.camera?.view ?? { x: -input.world.x * input.scale, y: -input.world.y * input.scale, zoom: input.scale };
  const turned = !isBoardViewLevel(camera) && Boolean(input.depth);
  const pitched = turned && isBoardViewPitched(camera);
  const board = new Container({ label: "board-export-board" });
  const world = new Container({ label: "board-export-world" });
  board.addChild(world);
  if (turned) {
    const center = boardViewCenter(camera, { width: outputWidth, height: outputHeight });
    board.pivot.set(center.x, center.y);
    board.position.set(outputWidth / 2, outputHeight / 2);
    board.rotation = (-boardViewBearing(camera) * Math.PI) / 180;
  } else board.position.set(camera.x, camera.y);
  board.scale.set(camera.zoom);

  let backdrop: BoardBackdropLayer | null = null;
  if (input.backdrop) {
    const backdropView = { x: camera.x, y: camera.y, zoom: camera.zoom, width: outputWidth, height: outputHeight, density: 1 };
    backdrop = createBoardBackdropLayer({ patterns: false });
    if (turned) {
      const { x, y, width, height } = input.world;
      const plate = new Container({ label: "board-export-backdrop" });
      plate.addChild(new Graphics().rect(x, y, width, height).fill({ color: input.backdrop.color, alpha: 1 }));
      backdrop.sync(input.backdrop, { x: -x * camera.zoom, y: -y * camera.zoom, zoom: camera.zoom, width: width * camera.zoom, height: height * camera.zoom, density: 1 }, input.backdropTexture ?? null);
      backdrop.container.position.set(x, y);
      backdrop.container.scale.set(1 / camera.zoom);
      plate.addChild(backdrop.container);
      board.addChildAt(plate, 0);
    } else {
      root.addChild(new Graphics().rect(0, 0, outputWidth, outputHeight).fill({ color: input.backdrop.color, alpha: 1 }));
      backdrop.sync(input.backdrop, backdropView, input.backdropTexture ?? null);
      root.addChild(backdrop.container);
    }
  }

  const resolve = input.renderers ?? getBoardCardRenderer;
  const planned = new Set(input.items.map((item) => item.id));
  const models = input.depth?.models;
  const riding = (item: BoardSceneItem) => {
    const attached = boardAttachedNode(item, input.scene);
    return Boolean(attached && models?.has(attached.target.id));
  };
  const roots = input.depth ? boardDepthRoots(input.scene).filter((item) => planned.has(item.id) && (isBoardDepthActive(resolveBoardDepth(item.depth)) || models?.has(item.id) || riding(item))) : [];
  const hosts = new Map(roots.map((item) => [item.id, new Container({ label: `board-elevated-${item.id}`, isRenderGroup: true })]));
  const extras = new Set((input.depth ? (input.extras ?? []) : []).map((item) => item.id));
  const offstage = new Container({ label: "board-export-offstage" });
  const groups = new Map<string, FrameGroup>();
  function groupOf(frame: BoardSceneItem): FrameGroup {
    let entry = groups.get(frame.id);
    if (!entry) {
      entry = syncFrameGroup(undefined, frame, context);
      (hosts.get(frame.id) ?? outerHost(frame)).addChild(entry.group);
      groups.set(frame.id, entry);
    }
    return entry;
  }
  function outerHost(item: BoardSceneItem): Container {
    const frame = input.scene.get(groupingAncestor(input.scene, item) ?? "");
    if (extras.has(item.id) && (!frame || !extras.has(frame.id))) return offstage;
    return frame ? groupOf(frame).content : world;
  }
  const containers = new Map<string, Container>();
  for (const item of [...input.items, ...(input.extras ?? []).filter((extra) => extras.has(extra.id))]) {
    const opacity = input.scene.opacity(item.id);
    if (opacity <= 0) continue;
    const host = isSelfGroupedFrame(item) ? groupOf(item).group : (hosts.get(item.id) ?? outerHost(item));
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
  root.addChild(board);
  const shaderErrors: Array<{ id: string; message: string }> = [];
  const layers = input.shaders?.owners.length ? (input.shaders.layers ?? createBoardShaderLayers({ wait: true })) : null;
  if (layers && input.shaders) {
    const toOutput = [input.scale, 0, 0, input.scale, -input.world.x * input.scale, -input.world.y * input.scale] as const;
    const below = board.addChildAt(new Container({ label: "board-shaders-below" }), board.getChildIndex(world));
    const above = board.addChildAt(new Container({ label: "board-shaders-above" }), board.getChildIndex(world) + 1);
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
  const hud = new Container({ label: "board-export-hud" });
  if (turned) {
    const owners = new Map<Container, string>([...containers].map(([id, container]) => [container, id]));
    for (const [id, { group }] of groups) owners.set(group, id);
    const onScreen = (id: string) => {
      for (let item = input.scene.get(id), depth = 0; item && depth < 64; item = item.parent ? input.scene.get(item.parent) : undefined, depth++)
        if (isBoardScriptScreenRoot(item.id)) return true;
      return false;
    };
    for (const child of [...world.children]) {
      const id = owners.get(child);
      if (id && onScreen(id)) hud.addChild(child);
    }
    hud.position.set(camera.x, camera.y);
    hud.scale.set(camera.zoom);
  }
  const depth = input.depth && roots.length
    ? attachBoardDepth(input.depth, { scene: input.scene, roots, hosts, containers, groups, world, root, scripts: input.scripts, time: input.time ?? 0, fault: (id, message) => shaderErrors.push({ id, message }), view: { ...camera, width: outputWidth, height: outputHeight } })
    : null;
  if (pitched && input.depth) {
    const surface = input.depth.stage.ground();
    surface.draw(input.depth.renderer, board, boardProjection(camera, { width: outputWidth, height: outputHeight }), {
      density: 1,
      maxPixels: outputWidth * outputHeight * 2.5,
      maxEdge: 4096,
      background: null,
    });
    root.removeChild(board);
    root.addChildAt(surface.view, 0);
  }
  if (input.settings.atmosphere) {
    const atmosphere = createBoardAtmosphereLayer();
    atmosphere.sync(input.settings.atmosphere, { width: outputWidth, height: outputHeight, density: 1 });
    root.addChild(atmosphere.container);
  }
  root.addChild(hud);

  return {
    root,
    missingImageKeys: [...missing],
    shaderErrors,
    destroy: () => {
      if (pitched) input.depth?.stage.ground().view.removeFromParent();
      depth?.destroy();
      for (const host of hosts.values()) host.destroy({ children: true });
      offstage.destroy({ children: true });
      if (layers === input.shaders?.layers) layers?.detach();
      else layers?.destroy();
      backdrop?.destroy();
      if (!board.parent) board.destroy({ children: true });
      root.destroy({ children: true });
    },
  };
}

function attachBoardDepth(
  { renderer, stage, models }: NonNullable<BoardExportSceneInput["depth"]>,
  input: {
    scene: BoardScene;
    roots: readonly BoardSceneItem[];
    hosts: ReadonlyMap<string, Container>;
    containers: ReadonlyMap<string, Container>;
    groups: ReadonlyMap<string, FrameGroup>;
    world: Container;
    root: Container;
    scripts?: BoardRenderContext["scripts"];
    time: number;
    view: BoardDepthView;
    fault: (id: string, message: string) => void;
  },
) {
  const { scene, view } = input;
  const projection = boardProjection(view, view);
  const pictures: BoardDepthPicture[] = [];
  const backs = new Map<string, BoardDepthPicture>();
  const layers: BoardDepthLayer[] = [];
  const objects: BoardDepthObject[] = [];
  const shadows = createBoardDepthShadows();
  const shadowInput = new Map<string, { shadow: BoardDepthShadow; width: number; height: number; opacity: number }>();
  const parts = (id: string) => {
    const card = input.containers.get(id);
    const group = input.groups.get(id)?.group;
    if (group) return card && card.parent !== group ? [card, group] : [group];
    return card ? [card] : [];
  };
  const flats: BoardSceneItem[] = [];
  for (const item of input.roots) {
    const model = models?.get(item.id);
    const playback = model && boardModelPlayback(item, false);
    const depth = boardDepthOf(item, scene);
    if (!depth || !input.hosts.get(item.id) || input.scene.opacity(item.id) <= 0) continue;
    if (model && playback && item.type === "file")
      objects.push({ id: item.id, model, cover: null, shimmer: false, frame: item.frame, origin: item.origin, depth, view: item.props.model?.view, playback, opacity: scene.opacity(item.id) });
    else flats.push(item);
  }
  stage.aim(projection);
  const { placements } = stage.objects.sync(projection, objects, input.time);
  for (const object of objects) {
    const size = placements.get(object.id)?.size ?? { ...object.frame, thickness: 0 };
    const shadow = boardDepthContactShadow(object.frame, object.depth, size);
    if (shadow) shadowInput.set(object.id, { shadow, width: object.frame.width, height: object.frame.height, opacity: scene.opacity(object.id) });
  }
  for (const item of flats) {
    const depth = boardDepthOf(item, scene) as NonNullable<ReturnType<typeof boardDepthOf>>;
    const host = input.hosts.get(item.id) as Container;
    const surface = boardDepthSurface({ frame: item.frame, origin: item.origin, depth });
    const pose = boardDepthPose(surface, projection, boardDepthRiding(scene, item, stage.objects.node));
    const density = boardDepthDensity(projection, 1, pose);
    const picture = createBoardDepthPicture();
    pictures.push(picture);
    picture.draw(renderer, host, item.frame, density);
    const backItem = depth.back && depth.back !== item.id ? scene.get(depth.back) : undefined;
    let back: BoardDepthPicture | null = null;
    if (backItem && parts(backItem.id).length) {
      back = backs.get(backItem.id) ?? null;
      if (!back) {
        back = createBoardDepthPicture();
        backs.set(backItem.id, back);
        drawBoardDepthParts(renderer, back, parts(backItem.id), backItem.frame, density);
      }
    }
    const bend = depth.bend.kind === "custom" ? resolveBoardDepthBend(renderer, item.id, input.scripts?.bend?.(item.id, input.time), input.fault) : null;
    layers.push({
      id: item.id,
      surface,
      pose,
      front: picture.texture,
      back: back?.texture ?? null,
      opacity: scene.opacity(item.id),
      bend: bend ? { source: bend, width: item.frame.width, height: item.frame.height, amount: depth.bend.amount, phase: depth.bend.phase, shade: depth.shade } : null,
    });
    const shadow = boardDepthShadow(surface, pose, projection, depth.shadow);
    if (shadow) shadowInput.set(item.id, { shadow, width: item.frame.width, height: item.frame.height, opacity: scene.opacity(item.id) });
  }
  shadows.sync(shadowInput);
  input.world.addChild(shadows.container);
  stage.view.position.set(0, 0);
  stage.view.scale.set(1);
  stage.sync(layers);
  stage.view.visible = true;
  input.root.addChild(stage.view);
  return {
    destroy() {
      stage.view.removeFromParent();
      stage.sync([]);
      shadows.destroy();
      for (const picture of [...pictures, ...backs.values()]) picture.destroy();
    },
  };
}
