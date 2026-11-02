import assert from "node:assert/strict";
import { test } from "node:test";
import { createBoardEditor } from "../../src/board/editor/index.js";
import { buildBoardScene } from "../../src/board/model/scene.js";
import { composeBoardScriptItems, scriptTemporaryPrefix, validateBoardScriptCommit } from "../../src/board/model/script-scene.js";
import type { BoardScriptOutput } from "../../src/board/model/script.js";
import { createScriptRuntime } from "../../src/board/render/script-runtime.js";
import { createBoardScriptPointerRouter } from "../../src/board/stage/script-pointer.js";
import { createNodeBoardRenderer, createNodeBoardScriptHost } from "../../src/board/export/node/index.js";
import { boardDocument } from "./fixtures.js";

test("script effects stay local, copy excludes temporary items, and commits enforce scope", () => {
  const document = boardDocument({ items: {
    owner: { type: "frame", script: { src: "main.js" } },
    outside: { type: "shape" },
  } });
  const output: BoardScriptOutput = {
    patches: { owner: { position: { x: 500, y: 100 } } },
    world: {}, screen: { hint: { type: "text", props: { text: "Local" } } },
    hits: {}, listens: [], animated: false, version: 1,
  };
  let writes = 0;
  const editor = createBoardEditor({ document, onCommit() { writes++; } });
  try {
    editor.setScriptItems(composeBoardScriptItems(document, buildBoardScene(document), new Map([["owner", output]]), new Map(), { zoom: 2 }));
    assert.deepEqual(editor.scene.get(`${scriptTemporaryPrefix("owner")}~screen`)?.position, { x: 500, y: 100 });
    assert.equal(editor.document.items.owner?.position.x, 0);
    assert.equal(writes, 0);
    editor.setSelection(["owner"]);
    const copied = editor.copySelection();
    assert.deepEqual(Object.keys(copied?.items ?? {}), ["owner"]);
    assert.deepEqual(copied?.origin, { x: 0, y: 0 });
    editor.duplicateSelection();
    const duplicate = editor.document.items[editor.selection[0] ?? ""];
    assert.deepEqual(duplicate?.position, { x: 24, y: 24 });
    assert.equal(duplicate?.z, 3);
    assert.throws(() => validateBoardScriptCommit(document, "owner", { items: { outside: { opacity: 0 } } }), /outside/);
    editor.setScriptItems(new Map());
    assert.equal(editor.scene.items.length, 3);
  } finally { editor.destroy(); }
});

test("DOM modules are rejected before setup executes", () => {
  const document = boardDocument({ items: { owner: { type: "custom", script: { src: "main.js" } } } });
  const item = document.items.owner;
  assert.ok(item);
  const module = { default() { assert.fail("Unexpected execution"); }, mount() {}, draw() {} };
  assert.ok(item.script);
  assert.throws(() => createScriptRuntime(module, { id: "owner", script: item.script, item, items: document.items, width: 100, height: 100 }, { call: async () => undefined, invalidate() {} }), /do not support DOM mount/);
});

test("removing scripts still finishes editor gestures before the fast path resumes", () => {
  const router = createBoardScriptPointerRouter();
  const point = { x: 0, y: 0 };
  const target = { owner: "script", target: "button" };
  router.route("down", 1, null, point);
  assert.equal(router.needsRouting(1, false), true);
  assert.equal(router.route("up", 1, target, point).recipient, null);
  assert.equal(router.needsRouting(1, false), false);
  assert.equal(router.route("move", 1, target, point).recipient, target);
});

test("Node exports isolate instances, reuse sequential samples, and reset backwards seeks", async () => {
  const renderer = await createNodeBoardRenderer();
  const document = boardDocument({ items: Object.fromEntries(["a", "b"].map(id => [id, {
    type: "custom", size: { width: 4, height: 4 }, script: { src: "main.js" },
  }])) });
  const code = "let n=0;let context;export default function(ctx){context=ctx}export function draw(ctx){ctx.fillRect(0,0,4,4);context.self.present({opacity:++n/10})}";
  const host = createNodeBoardScriptHost(renderer, { readModule: async () => code });
  try {
    const scene = buildBoardScene(document);
    for (const [time, opacity] of [[100, 0.1], [200, 0.2], [50, 0.1]] as const) {
      host.clearFrames();
      await host.prepare(scene.items, [time], 1);
      const sampled = host.document?.(document, time);
      for (const item of scene.items) {
        assert.equal(host.error(item.id), null);
        assert.equal(sampled?.items[item.id]?.opacity, opacity);
        assert.equal(host.ready?.(item.id), true);
      }
    }
  } finally { host.destroy(); renderer.destroy(); }
});
