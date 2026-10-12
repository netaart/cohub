import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBoardScene, refreshBoardScene } from "../../src/board/model/scene.js";
import { boardDocument } from "./fixtures.js";

/**
 * The editor resolves a Board incrementally while its items move: an animation
 * frame, a drag, a peer's cursor. `refreshBoardScene` is only ever given the ids
 * whose *values* changed, so these pin the two things a caller relies on — a
 * partial refresh lands where a full rebuild would, and the ids handed to it are
 * the only ones that still need resolving.
 */

const document = boardDocument({
  items: {
    f: {
      type: "frame",
      position: { x: 0, y: 0 },
      size: { width: 400, height: 300 },
    },
    s: {
      type: "shape",
      parent: "f",
      position: { x: 10, y: 20 },
      size: { width: 50, height: 40 },
    },
    a: {
      type: "shape",
      position: { x: 800, y: 0 },
      size: { width: 50, height: 40 },
    },
    l: { type: "arrow", props: { start: { item: "s" }, end: { item: "a" } } },
  },
});

function compare(
  movedId: string,
  next: Record<string, unknown>,
  label = movedId,
) {
  const { items } = boardDocument({ items: { ...document.items, [movedId]: next } });
  const framesOf = (scene: ReturnType<typeof buildBoardScene>) =>
    Object.fromEntries(
      Object.keys(document.items).map((id) => [id, scene.get(id)?.frame]),
    );
  const refreshed = refreshBoardScene(
    buildBoardScene(document),
    (id) => items[id],
    [movedId],
  );
  assert.deepEqual(
    framesOf(refreshed),
    framesOf(buildBoardScene({ ...document, items })),
    `${label} left the incremental scene behind a full rebuild`,
  );
}

test("a moving frame carries its descendants and binders with it", () => {
  compare("f", { ...document.items.f, position: { x: 500, y: 300 } });
  compare("f", { ...document.items.f, rotation: 30 });
  compare("f", { ...document.items.f, scale: 2 });
  compare("f", { ...document.items.f, size: { width: 900, height: 200 } });
});

test("moving one end of an arrow moves the whole arrow", () => {
  compare("a", { ...document.items.a, position: { x: 900, y: 400 } });
  compare("s", { ...document.items.s, position: { x: 200, y: 0 } });
});

test("an item still holding a stale value must be named to be resolved", () => {
  const original = document.items.s;
  assert.ok(original);
  const played = { ...original, position: { x: 900, y: 700 } };
  const playedScene = refreshBoardScene(
    buildBoardScene(document),
    (id) => (id === "s" ? played : document.items[id]),
    ["s"],
  );
  assert.deepEqual(playedScene.get("s")?.frame, {
    x: 900,
    y: 700,
    width: 50,
    height: 40,
    rotation: 0,
  });

  // Playing ends: the item goes back to the document. Forgetting to name it here
  // is exactly how hit testing keeps pointing at where it *was*.
  const reset = refreshBoardScene(
    playedScene,
    (id) => document.items[id],
    ["s"],
  );
  assert.deepEqual(reset.get("s")?.frame, {
    x: 10,
    y: 20,
    width: 50,
    height: 40,
    rotation: 0,
  });
});

test("a refresh that names nothing returns the same scene", () => {
  const scene = buildBoardScene(document);
  assert.equal(refreshBoardScene(scene, (id) => document.items[id], []), scene);
});
