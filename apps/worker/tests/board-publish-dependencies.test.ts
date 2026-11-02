import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyBoardDocument, parseBoardDocument } from "@cohub/protocol";
import { collectBoardPublishReferences } from "../src/system/jobs/app-publish-asset/board-dependencies.js";

test("publishing captures Board and item script dependencies once", async () => {
  const empty = emptyBoardDocument();
  const parsed = parseBoardDocument({ ...empty, board: { ...empty.board, scripts: { rain: { src: "rain.js" } } }, items: {
    a: { type: "custom", script: { src: "a.js" } },
    b: { type: "custom", script: { src: "b.js", enabled: false } },
  } });
  assert.ok(parsed.ok);
  const files = new Map([
    ["a.js", 'export {value} from "./shared.mjs";'],
    ["b.js", 'export const load = () => import("./shared.mjs");'],
    ["rain.js", 'import "./shared.mjs";'],
    ["shared.mjs", "export const value = 42;"],
  ]);
  const expected = [...files.keys()].sort();
  const refs = await collectBoardPublishReferences(parsed.document, {
    async module(path) {
      const code = files.get(path);
      assert.ok(code !== undefined, `Missing or repeated read: ${path}`);
      files.delete(path);
      return code;
    },
    prefix: async () => null,
  }, 1000);
  assert.deepEqual(refs.files, expected);
});

test("publishing captures the files a model loads beside itself", async () => {
  const parsed = parseBoardDocument({ ...emptyBoardDocument(), items: {
    car: { type: "file", props: { src: "models/car.gltf" } },
    chair: { type: "file", props: { src: "models/chair.obj" } },
    broken: { type: "file", props: { src: "models/broken.gltf" } },
  } });
  assert.ok(parsed.ok);
  const sources = new Map([
    ["models/car.gltf", JSON.stringify({ buffers: [{ uri: "car.bin" }], images: [{ uri: "../textures/paint.png" }, { uri: "data:image/png;base64,AA==" }, { uri: "../.env" }] })],
    ["models/broken.gltf", JSON.stringify({ buffers: {} })],
    ["models/chair.obj", "mtllib chair.mtl\nv 0 0 0\n"],
    ["models/chair.mtl", "newmtl wood\nmap_Kd -s 2 2 1 wood.jpg\n"],
  ]);
  const refs = await collectBoardPublishReferences(parsed.document, {
    module: async () => "",
    prefix: async (path, maxBytes) => {
      const source = sources.get(path);
      return source === undefined ? null : new TextEncoder().encode(source).subarray(0, maxBytes);
    },
  }, 1000);
  assert.deepEqual(refs.files, ["models/broken.gltf", "models/car.bin", "models/car.gltf", "models/chair.mtl", "models/chair.obj", "models/wood.jpg", "textures/paint.png"]);
});
