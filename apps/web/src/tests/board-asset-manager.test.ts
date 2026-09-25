import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardItem } from "@neta-art/cohub/board";
import {
	boardAssetKey,
	createBoardAssetManager,
} from "../lib/board/board-asset-manager.ts";

type FakeTexture = { width: number; height: number; destroyed: boolean };

function imageItem(id: string, path: string): BoardItem {
	return {
		id,
		type: "image",
		ref: { kind: "space-file", path },
		snapshot: { mimeType: "image/png" },
		frame: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
	};
}

function videoItem(id: string, path: string, mtimeMs?: number): BoardItem {
	return {
		id,
		type: "video",
		ref: { kind: "space-file", path },
		snapshot: { mimeType: "video/mp4", mtimeMs },
		frame: { x: 0, y: 0, width: 160, height: 90, rotation: 0 },
	};
}

function taskItem(artifact: Record<string, unknown>): BoardItem {
	return {
		id: "task",
		type: "task",
		taskRunId: "run",
		snapshot: {
			taskType: "generation",
			status: "completed",
			title: "Task",
			artifactCount: 1,
			artifacts: [{ id: "a", ...artifact }],
		},
		frame: { x: 0, y: 0, width: 160, height: 160, rotation: 0 },
	} as BoardItem;
}

/** Build a manager backed by fake textures, a controllable clock, and load/unload spies. */
function harness(budget: { maxCount: number; maxBytes: number }) {
	let clock = 0;
	const loaded: string[] = [];
	const unloaded: string[] = [];
	const textures = new Map<string, FakeTexture>();
	const manager = createBoardAssetManager({
		spaceId: "space",
		now: () => clock,
		lruBudget: budget,
		resolveSpaceFileUrl: async (_spaceId, path) => path,
		loadTexture: async (url) => {
			loaded.push(url);
			const texture: FakeTexture = { width: 10, height: 10, destroyed: false };
			textures.set(url, texture);
			return texture as never;
		},
		unloadTexture: (url) => {
			unloaded.push(url);
			const texture = textures.get(url);
			if (texture) texture.destroyed = true;
			return Promise.resolve();
		},
	});
	return {
		manager,
		loaded,
		unloaded,
		textures,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("task cards render bounded CDN stills before decoding video", () => {
	const oss = "https://router-files.neta.art/files/a";
	assert.equal(
		boardAssetKey(taskItem({ type: "image", url: `${oss}/out.png` })),
		`url:${oss}/out.png?x-oss-process=image/resize,m_lfit,w_1536,h_1536/quality,q_82/format,webp`,
	);
	assert.equal(
		boardAssetKey(taskItem({ type: "video", url: `${oss}/clip.mp4` })),
		`url:${oss}/clip.mp4?x-oss-process=video/snapshot,t_0,f_jpg,w_768,m_fast`,
	);
	assert.equal(
		boardAssetKey(
			taskItem({ type: "video", url: "https://cdn.example.com/clip.mp4" }),
		),
		`video-url:${encodeURIComponent("https://cdn.example.com/clip.mp4")}`,
	);
	assert.equal(
		boardAssetKey(taskItem({ type: "audio", url: `${oss}/song.m4a` })),
		null,
	);
});

test("video preview keys are shared by path and invalidated by file version", () => {
	const first = boardAssetKey(videoItem("a", "media/demo: 1.mp4", 100));
	const same = boardAssetKey(videoItem("b", "media/demo: 1.mp4", 100));
	const changed = boardAssetKey(videoItem("c", "media/demo: 1.mp4", 101));

	assert.equal(first, same);
	assert.notEqual(first, changed);
});

test("path invalidation forces a fresh preview without relying on mtime", async () => {
	const { manager, loaded } = harness({
		maxCount: 8,
		maxBytes: Number.POSITIVE_INFINITY,
	});
	const path = "media/clip.mp4";
	const item = videoItem("video", path);
	const firstKey = manager.assetKey(item);
	assert.ok(firstKey);
	manager.requestItem(item);
	await flush();
	assert.deepEqual(manager.getNaturalSize(firstKey), { width: 10, height: 10 });

	manager.invalidatePath(path);
	const nextKey = manager.assetKey(item);
	assert.ok(nextKey);
	assert.notEqual(nextKey, firstKey);
	manager.requestItem(item);
	await flush();
	assert.deepEqual(loaded, [path, path]);
	manager.destroy();
});

test("video previews use the video loader and preserve the original file path", async () => {
	const loaded: Array<{ url: string; media: string }> = [];
	const unloaded: Array<{ url: string; media: string }> = [];
	const item = videoItem("video", "media/demo: 1.mp4", 100);
	const key = boardAssetKey(item);
	assert.ok(key);
	const manager = createBoardAssetManager({
		spaceId: "space",
		lruBudget: { maxCount: 0, maxBytes: 0 },
		resolveSpaceFileUrl: async (_spaceId, path) => `resolved:${path}`,
		loadTexture: async (url, media) => {
			loaded.push({ url, media });
			return { width: 160, height: 90 } as never;
		},
		unloadTexture: async (url, _texture, media) => {
			unloaded.push({ url, media });
		},
	});

	manager.acquire(key);
	manager.requestItem(item);
	await flush();
	assert.deepEqual(loaded, [
		{ url: "resolved:media/demo: 1.mp4", media: "video" },
	]);
	assert.ok(manager.getTexture(key));

	manager.release(key);
	await flush();
	assert.deepEqual(unloaded, [
		{ url: "resolved:media/demo: 1.mp4", media: "video" },
	]);
	manager.destroy();
});

test("video decoding leaves queue capacity for image previews", async () => {
	const started: Array<{ url: string; media: string }> = [];
	const pending: Array<() => void> = [];
	const manager = createBoardAssetManager({
		spaceId: "space",
		concurrency: 4,
		videoConcurrency: 2,
		resolveSpaceFileUrl: async (_spaceId, path) => path,
		loadTexture: (url, media) => {
			started.push({ url, media });
			return new Promise((resolve) => {
				pending.push(() => resolve({ width: 10, height: 10 } as never));
			});
		},
		unloadTexture: async () => {},
	});
	const videos = [1, 2, 3, 4].map((index) =>
		videoItem(`v${index}`, `v${index}.mp4`),
	);
	for (const item of videos) manager.requestItem(item);
	manager.requestItem(imageItem("image", "cover.png"));
	await flush();

	assert.deepEqual(started, [
		{ url: "v1.mp4", media: "video" },
		{ url: "v2.mp4", media: "video" },
		{ url: "cover.png", media: "image" },
	]);

	for (const resolve of pending.splice(0)) resolve();
	await flush();
	assert.equal(started.length, 5);
	for (const resolve of pending.splice(0)) resolve();
	await flush();
	manager.destroy();
});

test("released texture stays in the cooling pool until the budget is exceeded", async () => {
	const { manager, loaded, unloaded, advance } = harness({
		maxCount: 2,
		maxBytes: Number.POSITIVE_INFINITY,
	});

	manager.acquire("file:a");
	manager.requestItem(imageItem("a", "a"));
	advance(1);
	manager.acquire("file:b");
	manager.requestItem(imageItem("b", "b"));
	await flush();

	assert.equal(loaded.length, 2);
	assert.ok(manager.getTexture("file:a"));
	assert.ok(manager.getTexture("file:b"));

	// Release both: they cool (refs 0) but the pool (2) fits the budget (2).
	manager.release("file:a");
	manager.release("file:b");
	assert.equal(unloaded.length, 0, "nothing evicted while within budget");
	assert.ok(manager.getTexture("file:a"), "cooled texture still on the GPU");

	// A third image pushes the pool over budget → the oldest (a) is evicted.
	advance(1);
	manager.acquire("file:c");
	manager.requestItem(imageItem("c", "c"));
	await flush();
	manager.release("file:c");
	assert.deepEqual(unloaded, ["a"], "LRU entry evicted first");
	assert.equal(manager.getTexture("file:a"), null);
	assert.ok(manager.getTexture("file:b"));
});

test("re-acquiring a cooled texture avoids a reload", async () => {
	const { manager, loaded } = harness({
		maxCount: 8,
		maxBytes: Number.POSITIVE_INFINITY,
	});
	manager.acquire("file:a");
	manager.requestItem(imageItem("a", "a"));
	await flush();
	assert.equal(loaded.length, 1);

	manager.release("file:a");
	manager.acquire("file:a");
	manager.requestItem(imageItem("a", "a"));
	await flush();
	assert.equal(loaded.length, 1, "no second load for a cooled texture");
	assert.ok(manager.getTexture("file:a"));
});

test("an evicted texture reloads on next request", async () => {
	const { manager, loaded, advance } = harness({
		maxCount: 1,
		maxBytes: Number.POSITIVE_INFINITY,
	});
	manager.acquire("file:a");
	manager.requestItem(imageItem("a", "a"));
	advance(1);
	manager.acquire("file:b");
	manager.requestItem(imageItem("b", "b"));
	await flush();
	manager.release("file:a");
	manager.release("file:b");
	// Pool over budget (maxCount 1): oldest (a) evicted.
	assert.equal(manager.getTexture("file:a"), null);

	manager.acquire("file:a");
	manager.requestItem(imageItem("a", "a"));
	await flush();
	assert.equal(loaded.filter((url) => url === "a").length, 2, "a reloaded");
	assert.ok(manager.getTexture("file:a"));
});

test("a load that settles after its card is culled cools instead of leaking", async () => {
	const { manager, unloaded } = harness({
		maxCount: 8,
		maxBytes: Number.POSITIVE_INFINITY,
	});
	// Request without acquiring (card culled mid-load), then let it settle.
	manager.requestItem(imageItem("a", "a"));
	await flush();
	// refs 0 but loaded: should be kept cooling, not unloaded.
	assert.equal(unloaded.length, 0);
	assert.ok(manager.getTexture("file:a"));
});

test("re-requesting an evicted URL waits for the in-flight unload (no blank texture)", async () => {
	let clock = 0;
	const loaded: string[] = [];
	const unloaded: string[] = [];
	const textures = new Map<string, FakeTexture>();
	const pending: Array<() => void> = [];
	const manager = createBoardAssetManager({
		spaceId: "space",
		now: () => clock,
		lruBudget: { maxCount: 1, maxBytes: Number.POSITIVE_INFINITY },
		resolveSpaceFileUrl: async (_spaceId, path) => path,
		loadTexture: async (url) => {
			loaded.push(url);
			const texture: FakeTexture = {
				width: 10,
				height: 10,
				destroyed: false,
			};
			textures.set(`${url}#${loaded.length}`, texture);
			return texture as never;
		},
		// Async unload: the texture is only destroyed when the caller resolves it,
		// modelling a real Assets.unload that completes on a later tick.
		unloadTexture: (url) => {
			unloaded.push(url);
			return new Promise<void>((resolve) => {
				pending.push(() => {
					const texture = textures.get(`${url}#1`);
					if (texture) texture.destroyed = true;
					resolve();
				});
			});
		},
	});

	manager.acquire("file:a");
	manager.requestItem(imageItem("a", "a"));
	clock += 1;
	manager.acquire("file:b");
	manager.requestItem(imageItem("b", "b"));
	await flush();
	manager.release("file:a");
	manager.release("file:b"); // pool over budget → evicts oldest (a), unload pending
	assert.equal(unloaded.length, 1);
	assert.equal(manager.getTexture("file:a"), null);

	// Pan back before the unload settles: the reload must wait for it.
	manager.acquire("file:a");
	manager.requestItem(imageItem("a", "a"));
	await flush();
	assert.equal(
		loaded.filter((u) => u === "a").length,
		1,
		"reload is held until the pending unload settles",
	);

	for (const resolve of pending.splice(0)) resolve();
	await flush();
	await flush();
	assert.equal(
		loaded.filter((u) => u === "a").length,
		2,
		"reloaded after unload",
	);
	const reloaded = manager.getTexture("file:a");
	assert.ok(reloaded);
	assert.equal(
		(reloaded as unknown as FakeTexture).destroyed,
		false,
		"the displayed texture is a fresh one, not the destroyed original",
	);
});

/**
 * `withTextures` exists because releasing a reference can evict immediately: with
 * the pool already at budget, handing the caller a map and *then* releasing would
 * destroy the first texture before it could be drawn.
 */
test("withTextures keeps every texture alive for the whole callback", async () => {
	const { manager, textures } = harness({
		maxCount: 1,
		maxBytes: Number.POSITIVE_INFINITY,
	});
	const items = [imageItem("a", "a.png"), imageItem("b", "b.png")];

	const seen = await manager.withTextures(items, async (map) => {
		// An await inside the callback stands in for encoding the canvas.
		await flush();
		return [...map.entries()].map(([key, texture]) => ({
			key,
			destroyed: (texture as unknown as FakeTexture).destroyed,
		}));
	});

	assert.equal(seen.length, 2, "expected both textures in the callback");
	for (const entry of seen) {
		assert.equal(
			entry.destroyed,
			false,
			`${entry.key} was destroyed mid-export`,
		);
	}
	// Once the callback is done the refs are dropped, so the over-budget pool evicts.
	await flush();
	const destroyed = [...textures.values()].filter(
		(texture) => texture.destroyed,
	);
	assert.equal(
		destroyed.length,
		1,
		"expected the cooling pool to trim to budget",
	);
	manager.destroy();
});

test("withTextures returns the callback result and releases on throw", async () => {
	const { manager } = harness({
		maxCount: 8,
		maxBytes: Number.POSITIVE_INFINITY,
	});
	const items = [imageItem("a", "a.png")];

	assert.equal(await manager.withTextures(items, (map) => map.size), 1);

	await assert.rejects(
		() =>
			manager.withTextures(items, () => {
				throw new Error("boom");
			}),
		/boom/,
	);
	// A throw must not leak the reference: the texture is releasable afterwards.
	assert.equal(await manager.withTextures(items, (map) => map.size), 1);
	manager.destroy();
});

test("withTextures runs the callback with an empty map when nothing has images", async () => {
	const { manager, loaded } = harness({
		maxCount: 8,
		maxBytes: Number.POSITIVE_INFINITY,
	});
	const text: BoardItem = {
		id: "t",
		type: "text",
		text: "no image",
		color: "neutral",
		fontSize: 18,
		frame: { x: 0, y: 0, width: 10, height: 10, rotation: 0 },
	};
	assert.equal(await manager.withTextures([text], (map) => map.size), 0);
	assert.deepEqual(loaded, []);
	manager.destroy();
});
