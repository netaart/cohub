import { runBoardExport } from "../src/board-export.js";
import { parseBoardDocument } from "../src/board-kernel.js";

const frames = Number(process.env.BOARD_EXPORT_BENCH_FRAMES ?? 2301);
const width = Number(process.env.BOARD_EXPORT_BENCH_WIDTH ?? 1600);
const height = Number(process.env.BOARD_EXPORT_BENCH_HEIGHT ?? 900);
if (![frames, width, height].every((value) => Number.isSafeInteger(value) && value > 0)) throw new Error("Benchmark dimensions and frame count must be positive integers.");
const parsed = parseBoardDocument({
  board: {},
  items: {
    page: { type: "frame", size: { width, height } },
    shape: { type: "shape", parent: "page", position: { x: 100, y: 100 }, size: { width: 200, height: 100 }, props: { text: "Export memory benchmark" } },
  },
  animations: { lecture: { duration: frames * 40, tracks: {
    rotate: { target: "shape", property: "rotation", keyframes: [{ at: 0, value: 0 }, { at: frames * 40, value: 360 }] },
  } } },
});
if (!parsed.ok) throw new Error("Invalid benchmark document.");
const start = performance.now();
let peakRss = 0;
const result = await runBoardExport({
  document: parsed.document, spaceId: "unused", target: "unused", animation: "lecture",
  times: Array.from({ length: frames }, (_, index) => index * 40),
  region: { kind: "frame", id: "page" }, scale: 1,
  colorScheme: "dark", background: "paper", format: "png", withImages: false,
  async onFrame(_frame, index) {
    const memory = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss);
    if (index % 100 === 0 || index === frames - 1) console.log(JSON.stringify({ frame: index + 1, ...memory }));
    if (memory.rss > 1024 ** 3) throw new Error("Benchmark exceeded the 1 GiB RSS safety limit.");
    await new Promise<void>((resolve) => setImmediate(resolve));
  },
});
console.log(JSON.stringify({ frames, width, height, peakRss, elapsedMs: Math.round(performance.now() - start), warnings: result?.warnings }));
