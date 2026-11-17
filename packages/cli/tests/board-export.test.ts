import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBoardDocument } from "../src/board-kernel.js";
import { runBoardExport } from "../src/board-export.js";
import { createClient } from "../src/client.js";

const parsed = parseBoardDocument({
  board: {},
  items: { shape: { type: "shape", size: { width: 80, height: 80 }, style: { fill: "blue" } } },
  animations: {
    intro: {
      duration: 1000,
      tracks: {
        turn: {
          target: "shape",
          property: "rotation",
          keyframes: [
            { at: 0, value: 0 },
            { at: 1000, value: 90 },
          ],
        },
      },
    },
  },
});
if (!parsed.ok) throw new Error("Invalid test document");
const options = {
  spaceId: "unused",
  target: "unused",
  document: parsed.document,
  animation: "intro",
  times: [0, 100, 200],
  region: { kind: "all" as const },
  scale: 1,
  theme: "dark" as const,
  background: "paper" as const,
  format: "png" as const,
  withImages: false,
};

test("native animated exports do not read disabled script modules", async (t) => {
  const document = parseBoardDocument({
    ...options.document,
    items: { shape: { ...options.document.items.shape, script: { src: "scripts/disabled.js", enabled: false } } },
  });
  assert.ok(document.ok);
  const download = t.mock.method(Object.getPrototypeOf(createClient().space("unused").files), "download", async () => {
    assert.fail("Native export must not load script modules.");
  });
  const result = await runBoardExport({ ...options, document: document.document });
  assert.equal(download.mock.callCount(), 0);
  assert.equal(result?.frames.length, 3);
  assert.deepEqual(result?.warnings, []);
  assert.ok(result?.frames.every((frame) => frame.bytes.length > 0));
});

test("camera sequences load visible images and evict textures as the camera moves", async (t) => {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const canvas = createCanvas(32, 32);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#00ff00";
  ctx.fillRect(0, 0, 32, 32);
  const png = canvas.toBuffer("image/png");
  const downloads: string[] = [];
  const files = Object.getPrototypeOf(createClient().space("unused").files);
  t.mock.method(files, "resolve", async () => null);
  t.mock.method(files, "download", async (path: string) => {
    downloads.push(path);
    return { blob: new Blob([png], { type: "image/png" }), filename: path, mimeType: "image/png" };
  });
  const document = parseBoardDocument({ board: {}, items: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`image${i}`, { type: "image", position: { x: i * 1000, y: 0 }, size: { width: 100, height: 100 }, props: { src: `images/${i}.png` } }])), animations: {
    intro: { duration: 200, tracks: { camera: { target: "camera", property: "focus", keyframes: [{ at: 0, value: "image64" }, { at: 100, value: "image63" }, { at: 200, value: "image64" }] } } },
  } });
  assert.ok(document.ok);
  let count = 0;
  const result = await runBoardExport({ ...options, document: document.document, times: [0, 50, 100, 150, 200], camera: { width: 320, height: 180 }, withImages: true, onFrame: async (frame) => {
    const image = await loadImage(frame.bytes);
    const output = createCanvas(image.width, image.height).getContext("2d");
    output.drawImage(image, 0, 0);
    const pixel = output.getImageData(image.width / 2, image.height / 2, 1, 1).data;
    assert.ok((pixel[1] ?? 0) > 240 && (pixel[0] ?? 255) < 20, "The visible image must render instead of a placeholder.");
    count++;
  } });
  assert.equal(count, 5);
  assert.deepEqual(downloads, ["images/64.png", "images/63.png", "images/64.png"]);
  assert.deepEqual(result?.warnings, []);
});
