import assert from "node:assert/strict";
import { test } from "node:test";
import { createNodeBoardRenderer, createNodeBoardScriptHost } from "../../src/board/export/node/index.js";
import { boardDocumentAt } from "../../src/board/model/animation.js";
import { buildBoardScene } from "../../src/board/model/scene.js";
import { boardDocument } from "./fixtures.js";

test("a timed export runs each span of an animated param with that span's value", async () => {
  const renderer = await createNodeBoardRenderer();
  const document = boardDocument({
    items: { card: { type: "custom", size: { width: 4, height: 4 }, script: { src: "main.js", params: { on: 0 } } } },
    animations: { flip: { duration: 2000, tracks: {
      on: { target: "card", property: "script.params.on", keyframes: [{ at: 0, value: 0 }, { at: 1010, value: 0 }, { at: 1011, value: 1 }] },
    } } },
  });
  const code = "export default function(ctx){ctx.state.lit=0;ctx.onFrame(({dt})=>{if(ctx.params.on)ctx.state.lit+=dt;ctx.self.present({opacity:Math.min(1,ctx.state.lit/2000)})})}";
  const host = createNodeBoardScriptHost(renderer, { readModule: async () => code });
  try {
    const at = (time: number) => boardDocumentAt(document, "flip", time).document;
    for (const [time, lit] of [[2000, 0.5], [1011, 0]] as const) {
      host.clearFrames();
      await host.prepare(buildBoardScene(at(time)).items, [time], 1, undefined, { history: at });
      const opacity = host.document?.(at(time), time).items.card?.opacity as number;
      assert.ok(Math.abs(opacity - lit) < 0.03, `lit for ${opacity * 2000} ms at ${time}`);
    }
  } finally { host.destroy(); renderer.destroy(); }
});
