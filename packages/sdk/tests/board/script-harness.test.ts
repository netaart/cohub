import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { BoardFrame } from "@cohub/protocol";
import { createNodeBoardRenderer, type BoardNodeRenderer } from "../../src/board/export/node/index.js";
import { frameHandlePosition } from "../../src/board/model/geometry.js";
import { createBoardScriptHarness } from "../../src/board/testing/index.js";
import { boardDocument } from "./fixtures.js";

const MODULES: Record<string, string> = {
  "farm.js": `
export default function (ctx) {
  ctx.on("gesture", ({ data }) => {
    if (data.tool !== "draw" || data.phase !== "end" || !data.item) return;
    const xs = data.points.map((p) => p.x), ys = data.points.map((p) => p.y);
    const size = Math.max(...xs) - Math.min(...xs);
    ctx.commit({ items: {
      [data.item]: null,
      ["lamb-" + data.id]: {
        type: "custom", parent: ctx.self.id,
        position: { x: Math.min(...xs), y: Math.min(...ys) }, size: { width: size, height: size },
        script: { src: "sheep.js" },
      },
    } });
  });
  ctx.onFrame(({ t }) => {
    if (ctx.items.wool) ctx.present("wool", { position: { x: 10 + Math.sin(t / 100) * 5, y: 10 } });
  });
}`,
  "sheep.js": `
export const frameRate = 12;
export const pixelated = true;
export default function (ctx) {
  ctx.scene({ shear: { type: "shape", size: { width: 40, height: 20 } } }, { space: "screen", anchor: { item: ctx.self.id, point: { x: 0.5, y: 1 } } });
  ctx.hitRegions({ shear: { item: "shear", label: "Shear" } });
  ctx.on("click", () => ctx.commit({ items: { [ctx.self.id]: { opacity: 0.5 } } }));
  ctx.commit({ items: { [ctx.self.id]: { metadata: { born: true } } } }).then((saved) => { ctx.state.saved = saved; });
}
export function draw(ctx, { width, height }) {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
}`,
};

let renderer: BoardNodeRenderer;
before(async () => {
  renderer = await createNodeBoardRenderer();
});
after(() => renderer.destroy());

function farm(leader = true) {
  return createBoardScriptHarness({
    renderer,
    leader,
    readModule: async (path) => {
      const code = MODULES[path];
      if (code === undefined) throw new Error(`${path} is not available.`);
      return code;
    },
    document: boardDocument({ items: {
      farm: { type: "frame", size: { width: 600, height: 400 }, props: { decoration: "none" }, script: { src: "farm.js" } },
      wool: { type: "shape", parent: "farm", position: { x: 10, y: 10 }, size: { width: 30, height: 30 } },
      sheep: { type: "custom", parent: "farm", position: { x: 400, y: 50 }, size: { width: 60, height: 60 }, script: { src: "sheep.js" } },
    } }),
  });
}

test("a pen circle drawn over a frame script becomes a living item, saved undoably as the user's edit", async () => {
  const harness = await farm();
  try {
    harness.tool = "draw";
    const circle = Array.from({ length: 24 }, (_, index) => {
      const angle = (index / 23) * Math.PI * 2;
      return { x: 200 + Math.cos(angle) * 50, y: 200 + Math.sin(angle) * 50 };
    });
    await harness.drag(circle, { pointerType: "pen" });
    await harness.advance(50);
    const lambs = Object.entries(harness.document.items).filter(([id]) => id.startsWith("lamb-"));
    assert.equal(lambs.length, 1);
    assert.equal(Object.values(harness.document.items).some((item) => item.type === "draw"), false);
    const [lambId, lamb] = lambs[0] ?? [];
    assert.equal(lamb?.parent, "farm");
    assert.equal(lamb?.script?.src, "sheep.js");
    assert.equal(harness.error("farm"), null);
    await harness.advance(100);
    assert.equal(harness.error(lambId ?? ""), null);
    assert.equal(harness.output(lambId ?? "")?.frameRate, 12);
    harness.editor.undo();
    assert.equal(harness.document.items[lambId ?? ""], undefined);
  } finally { harness.destroy(); }
});

test("screen controls take taps, setup saves only from the leader, and deleting presented items is harmless", async () => {
  const follower = await farm(false);
  try {
    assert.equal(follower.document.items.sheep?.metadata?.born, undefined);
  } finally { follower.destroy(); }
  const harness = await farm();
  try {
    await harness.advance(1100);
    assert.equal(harness.document.items.sheep?.metadata?.born, true);
    await harness.tap({ x: 430, y: 120 });
    assert.equal(harness.document.items.sheep?.opacity, 0.5);
    harness.editor.setSelection(["wool"]);
    harness.editor.deleteSelection();
    await harness.advance(50);
    assert.equal(harness.error("farm"), null);
    const png = await harness.render();
    assert.ok(png.byteLength > 100);
  } finally { harness.destroy(); }
});

test("moving and resizing a lifted card saves the authored item, never what the script presents", async () => {
  const harness = await createBoardScriptHarness({
    renderer,
    readModule: async () => `export default function (ctx) {
  ctx.on("selectionchange", ({ data }) => {
    for (const id of Object.keys(ctx.items)) if (id !== ctx.self.id) ctx.present(id, data.ids.includes(id) ? { scale: 1.06, rotation: 2 } : null);
  });
}`,
    document: boardDocument({ items: {
      table: { type: "frame", size: { width: 1000, height: 800 }, props: { decoration: "none" }, script: { src: "lift.js" } },
      card: { type: "shape", parent: "table", position: { x: 100, y: 100 }, size: { width: 170, height: 255 } },
    } }),
  });
  try {
    await harness.drag([{ x: 180, y: 220 }, { x: 230, y: 260 }, { x: 280, y: 300 }]);
    assert.deepEqual(harness.commits.at(-1), { items: { card: { position: { x: 200, y: 180 } } } });
    const corner = frameHandlePosition(harness.editor.selectionTransform?.frame as BoardFrame, "se");
    await harness.drag([corner, { x: corner.x + 10.6, y: corner.y }, { x: corner.x + 10.6, y: corner.y + 15.9 }]);
    const card = harness.document.items.card as { size: { width: number; height: number }; scale: number; rotation: number };
    assert.equal(card.scale, 1);
    assert.equal(card.rotation, 0);
    assert.ok(card.size.width > 170 && card.size.height > 255);
    harness.editor.undo();
    harness.editor.undo();
    assert.deepEqual(harness.document.items.card, boardDocument({ items: {
      table: { type: "frame", size: { width: 1000, height: 800 }, props: { decoration: "none" }, script: { src: "lift.js" } },
      card: { type: "shape", parent: "table", position: { x: 100, y: 100 }, size: { width: 170, height: 255 } },
    } }).items.card);
  } finally { harness.destroy(); }
});

test("listening turns a source on: browser input, env changes and play keys reach the script without saving", async () => {
  const harness = await createBoardScriptHarness({
    renderer,
    readModule: async () => `export default function (ctx) {
  const show = (env) => { ctx.state.env = env.mode + ":" + env.senses.motion + ":" + env.pointer; };
  show(ctx.env);
  ctx.on("envchange", ({ data }) => show(data));
  ctx.on("browser:devicemotion", () => { ctx.state.readings = (ctx.state.readings ?? 0) + 1; });
  ctx.on("keydown", ({ key }) => { ctx.state.key = key; });
}`,
    device: { pointer: "coarse" },
    document: boardDocument({ items: { wand: { type: "frame", size: { width: 400, height: 400 }, script: { src: "wand.js" } } } }),
  });
  try {
    await harness.advance(50);
    assert.deepEqual(harness.senses, ["motion"]);
    await harness.input("browser:devicemotion", motion(0, 0));
    await harness.key("keydown", "w");
    let state = (await harness.snapshot()).wand?.state;
    assert.equal(state?.env, "edit:on:coarse");
    assert.equal(state?.readings, 1);
    assert.equal(state?.key, undefined);
    harness.tool = "play";
    await harness.advance(50);
    await harness.key("keydown", "w");
    await harness.replay({ version: 1, inputs: [{ t: 0, type: "browser:devicemotion", data: motion(0, 0) }, { t: 500, type: "browser:devicemotion", data: motion(0, 0) }] });
    state = (await harness.snapshot()).wand?.state;
    assert.equal(state?.env, "play:on:coarse");
    assert.equal(state?.key, "w");
    assert.equal(state?.readings, 3);
    assert.equal(harness.commits.length, 0);
  } finally { harness.destroy(); }
});

function motion(x: number, y: number) {
  return { acceleration: { x: 0, y: 0, z: 0 }, accelerationIncludingGravity: { x, y, z: 0 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16, t: 0 };
}
