import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { BoardDocument } from "@cohub/protocol";
import {
  type BoardHeadlessRenderer,
  createBoardHeadlessRenderer,
  createBoardHeadlessSketchHost,
  exportBoardImageBytes,
} from "../../src/board/headless/index.js";
import { boardDocument } from "./fixtures.js";
import { buildBoardScene } from "../../src/board/core/scene.js";

/**
 * End-to-end cover for the headless path: a real Canvas2D renderer, the real
 * card renderers, real PNG bytes. This is the test that would catch a PixiJS
 * upgrade breaking the Node environment shims — which is exactly the failure
 * mode that would otherwise only surface for a user running `boards export`.
 *
 * `@napi-rs/canvas` is optional, so the suite skips rather than fails when it is
 * not installed.
 */

const items = {
  f1: { type: "frame", size: { width: 600, height: 400 }, props: { label: "Page" } },
  t1: { type: "text", parent: "f1", position: { x: 24, y: 24 }, style: { fill: "brand" }, props: { text: "Export 你好" } },
  g0: { type: "shape", parent: "f1", position: { x: 24, y: 90 }, size: { width: 160, height: 100 }, style: { stroke: "amber", fillOpacity: 0.2 }, props: { text: "box" } },
  g1: { type: "shape", parent: "f1", position: { x: 220, y: 90 }, size: { width: 150, height: 100 }, style: { stroke: "blue", fillOpacity: 0.2, dash: "dashed" }, props: { geometry: "ellipse", text: "geo" } },
  task1: {
    type: "task",
    parent: "f1",
    position: { x: 390, y: 90 },
    size: { width: 180, height: 120 },
    props: {
      taskRunId: "task_1",
      snapshot: {
        taskType: "generation",
        status: "completed",
        title: "Product sketch",
        model: "image-model",
        artifactCount: 1,
        artifacts: [{ id: "result", type: "text", textExcerpt: "A concise generated result" }],
        updatedAt: "2026-08-14T10:00:00.000Z",
      },
    },
  },
  d1: {
    type: "draw",
    parent: "f1",
    position: { x: 24, y: 230 },
    style: { stroke: "rose", strokeWidth: 5 },
    props: { points: [{ x: 0, y: 0, p: 0.5 }, { x: 40, y: 30, p: 0.6 }, { x: 90, y: 10, p: 0.4 }] },
  },
  a1: { type: "arrow", parent: "f1", style: { stroke: "violet", strokeWidth: 3 }, props: { start: { x: 150, y: 300 }, end: { x: 320, y: 350 }, route: "curve", bend: 0.2, label: "to" } },
  // A relation between two shapes, so export covers bound arrows as well as free ones.
  link: { type: "arrow", parent: "f1", props: { start: { item: "g0" }, end: { item: "g1" }, label: "relates" } },
};

const document = boardDocument({ items });

/** PNG magic number, so "did it encode" is checked rather than assumed. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let available = true;
try {
  await import("@napi-rs/canvas");
} catch {
  available = false;
}

describe("headless board export", { skip: available ? false : "@napi-rs/canvas is not installed" }, () => {
  let headless: BoardHeadlessRenderer;

  before(async () => {
    headless = await createBoardHeadlessRenderer();
  });

  after(() => {
    headless?.destroy();
  });

  test("renders a document to PNG bytes", () => {
    const result = exportBoardImageBytes(headless, document, { scale: 1 });
    assert.ok(result, "expected an export result");
    assert.equal(result.format, "png");
    assert.deepEqual([...result.bytes.slice(0, 8)], PNG_SIGNATURE);
    // Padding on both sides of a 600×400 frame.
    assert.equal(result.plan.width, 664);
    assert.equal(result.plan.height, 464);
    assert.ok(result.bytes.length > 1000, "expected a non-trivial image");
  });

  test("renders a sketch item through the headless host", async () => {
    const sketch = boardDocument({
      items: {
        wave: {
          type: "sketch",
          size: { width: 120, height: 80 },
          props: { src: "wave.js", params: { color: "#f00" } },
        },
      },
    });
    const item = buildBoardScene(sketch).items[0];
    assert.ok(item && item.type === "sketch");
    const host = createBoardHeadlessSketchHost(headless, {
      readModule: async () => `export function draw(ctx, frame) { ctx.fillStyle = frame.params.color; ctx.fillRect(0, 0, frame.width, frame.height); }`,
    });
    await host.prepare([item], [0], 1);
    const result = exportBoardImageBytes(headless, sketch, { scale: 1, background: "transparent", sketches: host });
    assert.ok(result);
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const image = await loadImage(result.bytes);
    const canvas = createCanvas(result.plan.width, result.plan.height);
    const pixels = canvas.getContext("2d");
    pixels.drawImage(image, 0, 0);
    const alpha = pixels.getImageData(0, 0, canvas.width, canvas.height).data;
    assert.ok([...alpha].some((value, index) => index % 4 === 3 && value > 0));
    host.destroy();
  });

  test("renders a draw item to visible pixels", async () => {
    const draw = boardDocument({
      items: {
        "draw-only": {
          type: "draw",
          style: { strokeWidth: 6 },
          props: { points: [{ x: 12, y: 12, p: 0.5 }, { x: 50, y: 80, p: 0.8 }, { x: 88, y: 20, p: 0.4 }] },
        },
      },
    });
    const result = exportBoardImageBytes(headless, draw, { scale: 1, background: "transparent" });
    assert.ok(result);
    const { loadImage, createCanvas } = await import("@napi-rs/canvas");
    const image = await loadImage(result.bytes);
    const canvas = createCanvas(result.plan.width, result.plan.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let visible = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if ((pixels[index] ?? 0) > 0) visible += 1;
    }
    assert.ok(visible > 100, `expected draw pixels, got ${visible}`);
  });

  test("renders a task-only document to non-transparent pixels", async () => {
    const { parent: _parent, ...task } = items.task1;
    const result = exportBoardImageBytes(headless, boardDocument({ items: { task1: task } }), { scale: 1, background: "transparent" });
    assert.ok(result);

    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const image = await loadImage(result.bytes);
    const canvas = createCanvas(result.plan.width, result.plan.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaquePixels = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if ((pixels[index] ?? 0) > 0) opaquePixels += 1;
    }
    assert.ok(opaquePixels > 1_000, "expected the task card to paint visible pixels");
  });

  test("exports a background image", async () => {
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const source = createCanvas(2, 2);
    const sourceContext = source.getContext("2d");
    sourceContext.fillStyle = "#2266aa";
    sourceContext.fillRect(0, 0, 2, 2);
    const texture = await headless.decodeImage(source.toBuffer("image/png"), "image/png");
    const result = exportBoardImageBytes(headless, document, {
      scale: 1,
      backgroundImage: { texture, fit: "cover", position: "center", opacity: 1 },
    });
    assert.ok(result);
    const output = await loadImage(result.bytes);
    const canvas = createCanvas(result.plan.width, result.plan.height);
    const context = canvas.getContext("2d");
    context.drawImage(output, 0, 0);
    assert.deepEqual([...context.getImageData(1, 1, 1, 1).data], [34, 102, 170, 255]);
    texture.destroy(true);
  });

  test("scale multiplies the output size", () => {
    const single = exportBoardImageBytes(headless, document, { scale: 1 });
    const double = exportBoardImageBytes(headless, document, { scale: 2 });
    assert.ok(single && double);
    assert.equal(double.plan.width, single.plan.width * 2);
    assert.equal(double.plan.height, single.plan.height * 2);
  });

  test("a frame region exports exactly the frame", () => {
    const result = exportBoardImageBytes(headless, document, {
      region: { kind: "frame", id: "f1" },
      scale: 1,
    });
    assert.ok(result);
    assert.equal(result.plan.width, 600);
    assert.equal(result.plan.height, 400);
  });

  test("an empty region yields null rather than a blank image", () => {
    const result = exportBoardImageBytes(headless, { ...document, items: {} }, {});
    assert.equal(result, null);
  });

  test("jpeg output is encoded as jpeg", () => {
    const result = exportBoardImageBytes(headless, document, { scale: 1, format: "jpeg" });
    assert.ok(result);
    assert.equal(result.format, "jpeg");
    // JPEG SOI marker.
    assert.deepEqual([...result.bytes.slice(0, 2)], [0xff, 0xd8]);
  });

  test("light and dark modes produce different pixels", () => {
    const dark = exportBoardImageBytes(headless, document, { scale: 1, colorScheme: "dark" });
    const light = exportBoardImageBytes(headless, document, { scale: 1, colorScheme: "light" });
    assert.ok(dark && light);
    assert.notDeepEqual([...dark.bytes], [...light.bytes]);
  });

  test("a sparse document is parsed rather than crashing a renderer", () => {
    // Hand-written documents omit defaults; the exporter fills them in.
    const raw = { board: {}, items: { g: { type: "shape" } }, animations: {} } as unknown as BoardDocument;
    const result = exportBoardImageBytes(headless, raw, { scale: 1 });
    assert.ok(result, "expected the export to survive a sparse document");
  });

  test("an export at a moment renders the animated state", () => {
    const animated = boardDocument({
      items: { dot: { type: "shape", size: { width: 100, height: 100 }, style: { fill: "#ff0000" } } },
      animations: {
        slide: { duration: 1000, tracks: { move: { target: "dot", property: "position.x", keyframes: [{ at: 0, value: 0 }, { at: 1000, value: 400 }] } } },
      },
    });
    const start = exportBoardImageBytes(headless, animated, { scale: 1, at: { animation: "slide", time: 0 } });
    const end = exportBoardImageBytes(headless, animated, { scale: 1, at: { animation: "slide", time: 1000 } });
    assert.ok(start && end);
    assert.equal(start.plan.world.x, -32);
    assert.equal(end.plan.world.x, 400 - 32);
  });

  test("missing images are reported as a warning, not a failure", () => {
    const withImage = boardDocument({
      items: { ...items, i1: { type: "image", parent: "f1", position: { x: 400, y: 230 }, size: { width: 120, height: 90 }, props: { src: "absent.png" } } },
    });
    const result = exportBoardImageBytes(headless, withImage, { scale: 1 });
    assert.ok(result);
    const missing = result.warnings.find((warning) => warning.kind === "images-missing");
    assert.ok(missing, "expected a missing-image warning");
  });
});
