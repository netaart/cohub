import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, Graphics } from "pixi.js";
import { createBoardScene } from "../../src/board/stage/scene.js";
import { buildBoardScene, buildFallbackShapeColors } from "../../src/board/model/index.js";
import { DEFAULT_BOARD_LOD, DEFAULT_BOARD_RENDER_LABELS, defaultBoardPalette, defaultBoardRenderStyle, type BoardLod, type BoardRenderContext, type BoardCardRenderer } from "../../src/board/render/index.js";
import { boardDocument } from "./fixtures.js";

test("scene render demand", async (t) => {
  const document = boardDocument({ items: Object.fromEntries(Array.from({ length: 3000 }, (_, id) => [String(id), {
    type: "shape", position: { x: id * 100, y: 0 }, size: { width: 80, height: 80 },
  }])) });
  const model = buildBoardScene(document);
  let updates = 0;
  let resolutions = 0;
  let frames = 0;
  let farDraws = 0;
  let ticking = true;
  const renderer: BoardCardRenderer = {
    id: "test", canRender: () => true,
    create: () => new Container(), update: () => { updates++; },
    resolution: (_container, _item, context) => { resolutions++; ticking = context.zoom > 0.5; },
    tick: () => ticking ? 16 : null,
    renderFar: () => { farDraws++; },
    destroy: (container) => container.destroy(),
  };
  const world = new Container();
  const overlay = new Graphics();
  const scene = createBoardScene({ world, overlay, getRenderer: () => renderer, requestFrame: () => { frames++; } });
  const context: BoardRenderContext = {
    settings: document.board, scene: model, time: 0, selectedIds: new Set(), hoveredId: null,
    resizingIds: new Set(), liftedIds: new Set(), palette: defaultBoardPalette("light"),
    colors: buildFallbackShapeColors("light"), colorScheme: "light", style: defaultBoardRenderStyle("light"),
    themeKey: "test", rendererType: "canvas", zoom: 1, textResolution: 1, reducedMotion: true, labels: DEFAULT_BOARD_RENDER_LABELS,
    taskRun: () => null, assetKey: () => null, getTexture: () => null, hasError: () => false,
    fileState: () => "ok", acquireTexture: () => {}, releaseTexture: () => {},
  };
  const all = new Set(model.items.map((item) => item.id));
  const few = new Set([...all].slice(-10));
  const pinned = new Set<string>();
  let lod: BoardLod = DEFAULT_BOARD_LOD;
  let focus: { x: number; y: number } | undefined;
  const sync = (visibleIds: Set<string>) => scene.sync({
    items: model.items, strokes: [], scene: model, context, getItem: (id) => model.get(id) ?? null,
    visibleIds, pinnedIds: pinned, globalSig: "same", structureVersion: 1, gestureActive: false, lod, focus,
  });
  const mounted = () => model.items.filter((item) => scene.getNode(item.id)).length;
  const settle = (visibleIds: Set<string>) => {
    for (let pass = 0; pass < 64; pass++) {
      const before = frames;
      sync(visibleIds);
      if (frames === before) return;
    }
  };
  try {
    await t.test("resolution changes resume ticks without full card updates", () => {
      sync(few);
      context.zoom = 1.1;
      sync(few);
      assert.equal(updates, 0);
      assert.equal(resolutions, 10);
      context.zoom = 1.2;
      sync(few);
      assert.equal(resolutions, 10);
      assert.equal(updates, 0);
      assert.equal(scene.tick(0), 16);
      context.zoom = 0.4;
      sync(few);
      assert.equal(scene.tick(16), null, "simplified content stops ticking");
      context.zoom = 1.2;
      sync(few);
      assert.equal(scene.tick(32), 16, "resolution-only updates restart detailed content ticks");
      assert.equal(updates, 0);
    });
    await t.test("LOD follows card size with hysteresis", () => {
      context.zoom = 1;
      lod = { ...DEFAULT_BOARD_LOD, live: 5000 };
      sync(all);
      assert.ok(mounted() < 3000, "cards become live over several frames");
      settle(all);
      assert.equal(mounted(), 3000);
      context.zoom = 0.2;
      pinned.add("0");
      settle(all);
      assert.ok(scene.getNode("0"), "pinned content remains materialized");
      assert.equal(scene.getNode("1"), null, "illegible content is no longer materialized");
      assert.equal(scene.counts().far, 2999);
      pinned.clear();
      settle(all);
      context.zoom = 0.28;
      settle(all);
      assert.equal(mounted(), 0, "cards below the threshold do not become live");
      context.zoom = 0.32;
      settle(all);
      assert.equal(mounted(), 3000);
      context.zoom = 0.27;
      settle(all);
      assert.equal(mounted(), 3000, "slightly smaller live cards stay live");
      context.zoom = 0.2;
      settle(all);
      assert.equal(mounted(), 0);
    });

    await t.test("the live budget keeps the cards nearest the focus", () => {
      context.zoom = 1;
      lod = { ...DEFAULT_BOARD_LOD, live: 100 };
      focus = { x: 299_940, y: 40 };
      settle(all);
      assert.equal(mounted(), 100);
      assert.equal(scene.counts().far, 2900);
      assert.ok(scene.getNode("2999") && !scene.getNode("0"));
      focus = undefined;
    });
    await t.test("far plates repaint within a frame budget and only where cards changed", () => {
      context.zoom = 0.1;
      lod = DEFAULT_BOARD_LOD;
      sync(few);
      farDraws = 0;
      frames = 0;
      sync(all);
      assert.ok(farDraws < 3000, "one frame paints part of the far layer");
      assert.ok(frames > 0, "the rest is painted on later frames");
      settle(all);
      assert.equal(scene.counts().far, 3000);
      farDraws = 0;
      pinned.add("1500");
      settle(all);
      assert.ok(farDraws > 0 && farDraws <= 512, "only the plate holding the change repaints");
      pinned.clear();
    });
  } finally {
    scene.destroy(context);
    world.destroy({ children: true });
    overlay.destroy();
  }
});
