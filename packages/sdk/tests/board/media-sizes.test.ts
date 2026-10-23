import assert from "node:assert/strict";
import { test } from "node:test";
import { settleBoardMediaSizes } from "../../src/board/model/media-sizes.js";
import { boardDocument } from "./fixtures.js";

test("learned media sizes fit unsized items once, leaving recorded and unknown ones", async () => {
  const { items } = boardDocument({ items: {
    a: { type: "image", position: { x: 0, y: 0 }, size: { width: 480, height: 270 }, props: { src: "a.png" } },
    b: { type: "image", size: { width: 100, height: 100 }, props: { src: "a.png" } },
    known: { type: "image", size: { width: 480, height: 270 }, props: { src: "a.png", snapshot: { naturalWidth: 16, naturalHeight: 9 } } },
    remote: { type: "video", size: { width: 480, height: 270 }, props: { src: "https://example.com/clip.mp4" } },
  } });
  const asked: string[] = [];
  const settled = await settleBoardMediaSizes(items, {
    resolveFile: async (path) => {
      asked.push(path);
      return { width: 1000, height: 1000 };
    },
  });
  assert.deepEqual(asked, ["a.png"]);
  assert.deepEqual(Object.keys(settled).sort(), ["a", "b"]);
  assert.deepEqual(settled.a?.size, { width: 480, height: 480 });
  assert.deepEqual(settled.a?.position, { x: 0, y: -105 });
  assert.deepEqual(settled.a?.type === "image" && settled.a.props.snapshot, { naturalWidth: 1000, naturalHeight: 1000 });
});
