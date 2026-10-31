import assert from "node:assert/strict";
import { test } from "node:test";
import { Sprite } from "pixi.js";
import { BoardBitmapTexture } from "../../src/board/render/bitmap-texture.js";

function bitmap(width: number, height: number) {
  let closed = 0;
  return { image: { width, height, close() { closed++; } } as ImageBitmap, get closed() { return closed; } };
}

test("script frames reuse their texture and source, resize, and release every bitmap", () => {
  const frames = new BoardBitmapTexture();
  const first = bitmap(40, 20);
  frames.update(first.image);
  const texture = frames.current;
  assert.ok(texture);
  const source = texture.source;
  const sprite = new Sprite(texture);
  assert.equal(sprite.bounds.maxX, 40);
  assert.equal(sprite.bounds.maxY, 20);
  sprite.didViewUpdate = false;
  let updates = 0;
  source.on("update", () => { updates++; });
  const second = bitmap(40, 20);
  frames.update(second.image);
  assert.equal(frames.current, texture);
  assert.equal(texture.source, source);
  assert.equal(first.closed, 1);
  assert.equal(second.closed, 0);
  assert.equal(updates, 1);
  assert.equal(source.destroyed, false);
  assert.equal(sprite.didViewUpdate, false);
  const resized = bitmap(80, 60);
  frames.update(resized.image);
  assert.equal(texture.frame.width, 80);
  assert.equal(texture.frame.height, 60);
  assert.equal(texture.orig.width, 80);
  assert.equal(source.resource, resized.image);
  assert.equal(second.closed, 1);
  assert.equal(sprite.didViewUpdate, true);
  assert.equal(sprite.bounds.maxX, 80);
  assert.equal(sprite.bounds.maxY, 60);
  sprite.destroy();
  frames.destroy();
  frames.destroy();
  assert.equal(resized.closed, 1);
  assert.equal(source.destroyed, true);
  assert.equal(frames.current, null);
});
