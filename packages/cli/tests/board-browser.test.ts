import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import type { BoardDocument } from "@neta-art/cohub/board";
import { findBoardBrowser } from "../src/board-browser/chrome.js";
import { runBoardExport } from "../src/board-export.js";
import { runBoardSimulation } from "../src/board-simulate.js";
import { parseBoardSimulation } from "../src/board-simulation.js";
import { parseBoardDocument } from "../src/board-kernel.js";
import { createClient } from "../src/client.js";

process.env.COHUB_BOARD_BROWSER_DAEMON = "0";
const browser = findBoardBrowser();
const skip = browser ? false : "no Chrome to run Board scripts in";
const font = readFileSync(join(dirname(createRequire(import.meta.url).resolve("@fontsource-variable/geist-mono/package.json")), "files", "geist-mono-latin-wght-normal.woff2"));

function files(t: TestContext, entries: Record<string, string | Uint8Array>) {
  t.mock.method(Object.getPrototypeOf(createClient().space("unused").files), "download", async (path: string) => {
    const content = entries[path];
    if (content === undefined) throw new Error(`${path} is not available.`);
    return { blob: new Blob([content as BlobPart]), filename: path, mimeType: "application/octet-stream" };
  });
}

function document(value: unknown): BoardDocument {
  const parsed = parseBoardDocument(value);
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((entry) => entry.message).join("; "));
  return parsed.document;
}

const CLOCK = `import hand from "../fonts/hand.woff2" with { type: "bytes" };
self.fonts.add(await new FontFace("Hand", hand).load());
export function draw(ctx, frame) {
  ctx.fillStyle = frame.t < 1000 ? "#0000ff" : "#ff0000";
  ctx.fillRect(0, 0, frame.width, frame.height);
  ctx.font = "24px Hand";
  ctx.fillText(String(Math.round(frame.t)), 8, 40);
}`;

const clockBoard = document({
  board: {},
  items: { clock: { type: "custom", size: { width: 200, height: 100 }, script: { src: "scripts/clock.js", time: 0 } } },
  animations: { show: { duration: 2000, tracks: { time: { target: "clock", property: "script.time", keyframes: [{ at: 0, value: 0 }, { at: 2000, value: 2000 }] } } } },
});

test("timeline exports run scripts in the browser on script.time, with bytes imports", { skip }, async (t) => {
  files(t, { "scripts/clock.js": CLOCK, "fonts/hand.woff2": font });
  const colors: number[][] = [];
  const result = await runBoardExport({
    spaceId: "unused", target: "unused", document: clockBoard, animation: "show", times: [1500, 500],
    region: { kind: "items", ids: ["clock"] }, scale: 1, padding: 0, theme: "dark", background: "paper", format: "rgba", withImages: false,
    onFrame: async ({ bytes, width, height }) => {
      const at = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
      colors.push([...bytes.subarray(at, at + 3)]);
    },
  });
  assert.deepEqual(result?.warnings, []);
  assert.deepEqual(colors, [[255, 0, 0], [0, 0, 255]]);
});

test("simulations run in the browser: input, commits, console lines and no network", { skip }, async (t) => {
  files(t, {
    "scripts/probe.js": `export default function (ctx) {
  console.log([typeof OffscreenCanvas, typeof Path2D, typeof DOMMatrix, typeof FontFace, typeof URL, typeof TextDecoder, typeof atob].join(" "));
  fetch("https://example.com").catch((error) => console.log(error.message));
  ctx.hitRegions({ pad: { target: "self", label: "Fade" } });
  ctx.on("click", () => ctx.commit({ items: { [ctx.self.id]: { opacity: 0.5 } } }));
}`,
  });
  const run = await runBoardSimulation({
    spaceId: "unused",
    target: "unused",
    leader: true,
    document: document({ board: {}, items: { probe: { type: "custom", size: { width: 100, height: 100 }, script: { src: "scripts/probe.js" } } } }),
    simulation: parseBoardSimulation({ mode: "play", steps: [{ tap: [50, 50] }, { wait: "100ms" }] }),
  });
  assert.deepEqual(run.errors, {});
  assert.equal(run.presses[0]?.taken, "script probe/pad");
  assert.deepEqual((run.changes as { items?: unknown }).items, { probe: { opacity: 0.5 } });
  assert.deepEqual(run.logs.map(({ id, text }) => `${id}: ${text}`), [
    "probe: function function function function function function function",
    "probe: Board exports and simulations have no network.",
  ]);
});
