import { performance } from "node:perf_hooks";
import { Container, Graphics } from "pixi.js";
import { parseBoardDocument } from "@cohub/protocol";
import { createNodeBoardRenderer } from "../src/board/export/node/index.js";
import { buildBoardScene, buildFallbackShapeColors, imageAssetKey } from "../src/board/model/index.js";
import {
	type BoardCardRenderer,
	type BoardRenderContext,
	DEFAULT_BOARD_RENDER_LABELS,
	defaultBoardPalette,
	defaultBoardRenderStyle,
	getBoardCardRenderer,
} from "../src/board/render/index.js";
import { createBoardScene } from "../src/board/stage/scene.js";

const COUNT = Number(process.env.BOARD_BENCH_ITEMS ?? 400);
const ROUNDS = Number(process.env.BOARD_BENCH_ROUNDS ?? 40);

function benchDocument(count: number) {
	const items: Record<string, unknown> = {};
	const columns = Math.ceil(Math.sqrt(count));
	for (let index = 0; index < count; index += 1) {
		const position = { x: (index % columns) * 240, y: Math.floor(index / columns) * 200 };
		const size = { width: 200, height: 150 };
		const kinds: Record<string, unknown>[] = [
			{ type: "image", position, size, props: { src: `img/${index}.webp`, snapshot: { naturalWidth: 400, naturalHeight: 300 } } },
			{ type: "shape", position, size, props: { geometry: "rounded", text: `Card ${index}` } },
			{ type: "file", position, size, props: { src: `docs/${index}.md`, snapshot: { title: `Note ${index}`, excerpt: "A short excerpt to measure text layout." } } },
			{ type: "video", position, size, props: { src: `video/${index}.mp4`, snapshot: { title: `clip-${index}.mp4`, durationMs: 48_000 } } },
			{ type: "audio", position, size: { width: 240, height: 96 }, props: { src: `audio/${index}.mp3`, snapshot: { title: `track-${index}.mp3`, durationMs: 16_000 } } },
			{ type: "task", position, size, props: { taskRunId: `t${index}`, snapshot: { taskType: "generation", status: "completed", title: `Task ${index}`, artifactCount: 1, artifacts: [{ id: "a", type: "text", textExcerpt: "Generated text" }] } } },
			{ type: "text", position, props: { text: `Text ${index}`, fontSize: 20 } },
		];
		items[`n${index}`] = kinds[index % kinds.length];
	}
	const parsed = parseBoardDocument({ board: {}, items, animations: {} });
	if (!parsed.ok) throw new Error(parsed.diagnostics[0]?.message);
	return parsed.document;
}

function countUpdates() {
	let updates = 0;
	let resolutions = 0;
	const wrapped = new Map<string, BoardCardRenderer>();
	const resolve = (item: Parameters<typeof getBoardCardRenderer>[0], context: BoardRenderContext) => {
		const base = getBoardCardRenderer(item, context);
		let renderer = wrapped.get(base.id);
		if (!renderer) {
			renderer = {
				...base,
				update: (container, next, ctx) => { updates += 1; base.update(container, next, ctx); },
				...(base.resolution ? { resolution: (container: Container, next: Parameters<BoardCardRenderer["update"]>[1], ctx: BoardRenderContext) => { resolutions++; base.resolution?.(container, next, ctx); } } : {}),
			};
			wrapped.set(base.id, renderer);
		}
		return renderer;
	};
	return { resolve, take: () => { const value = { updates, resolutions }; updates = 0; resolutions = 0; return value; } };
}

const renderer = await createNodeBoardRenderer();
const document = benchDocument(COUNT);
const scene = buildBoardScene(document);
const counter = countUpdates();
const world = new Container();
const overlay = new Graphics();
world.addChild(overlay);
let live = createBoardScene({ world, overlay, getRenderer: counter.resolve });

const context: BoardRenderContext = {
	settings: document.board,
	scene,
	time: 0,
	selectedIds: new Set(),
	hoveredId: null,
	resizingIds: new Set(),
	liftedIds: new Set(),
	palette: defaultBoardPalette("light"),
	colors: buildFallbackShapeColors("light"),
	colorScheme: "light",
	style: defaultBoardRenderStyle("light"),
	themeKey: "bench",
	rendererType: "canvas",
	zoom: 1,
	textResolution: 1,
	reducedMotion: true,
	labels: DEFAULT_BOARD_RENDER_LABELS,
	taskRun: () => null,
	assetKey: imageAssetKey,
	getTexture: () => null,
	hasError: () => false,
	fileState: () => "ok",
	acquireTexture: () => {},
	releaseTexture: () => {},
};

function sync(next: Partial<BoardRenderContext> = {}, globalSig = "g", visibleIds: Set<string> | null = null) {
	Object.assign(context, next);
	live.sync({
		items: scene.items,
		strokes: [],
		scene,
		context,
		getItem: (id) => scene.get(id) ?? null,
		visibleIds,
		pinnedIds: new Set(context.selectedIds),
		globalSig,
		structureVersion: 1,
		gestureActive: false,
	});
}

function measure(label: string, rounds: number, run: (round: number) => void, setup?: () => void) {
	counter.take();
	const times: number[] = [];
	for (let round = 0; round < rounds; round += 1) {
		setup?.();
		const start = performance.now();
		run(round);
		times.push(performance.now() - start);
	}
	times.sort((a, b) => a - b);
	const ms = times[Math.floor(times.length / 2)] ?? 0;
	const counts = counter.take();
	console.log(`${label.padEnd(18)} ${ms.toFixed(3).padStart(8)} ms/op ${(counts.updates / rounds).toFixed(1).padStart(7)} card updates/op ${(counts.resolutions / rounds).toFixed(1).padStart(7)} resolution updates/op`);
}

const ids = scene.items.map((item) => item.id);
console.log(`Board bench · ${COUNT} items · ${ROUNDS} rounds`);
measure("materialize", 7, () => sync(), () => {
	live.destroy(context);
	live = createBoardScene({ world, overlay, getRenderer: counter.resolve });
});
measure("idle sync", ROUNDS, () => sync());
measure("zoom bucket", ROUNDS, (round) => sync({ zoom: round % 2 ? 1 : 1.1 }));
sync({ zoom: 1.1 });
measure("zoom within bucket", ROUNDS, (round) => sync({ zoom: 1.1 + (round % 2) * 0.1 }));
measure("hover change", ROUNDS, (round) => sync({ hoveredId: ids[round % ids.length] ?? null }));
measure("select change", ROUNDS, (round) => sync({ selectedIds: new Set([ids[(round * 7) % ids.length] as string]) }));
measure("select all", 4, (round) => sync({ selectedIds: round % 2 ? new Set() : new Set(ids) }));
measure("theme change", 4, (round) => sync({ themeKey: `t${round}` }, `g${round}`));
const visible = new Set([...ids].sort());
measure("far replan", ROUNDS, (round) => sync({ zoom: round % 2 ? 0.08 : 0.09 }, "g", new Set(visible)));
live.destroy(context);
renderer.destroy();
