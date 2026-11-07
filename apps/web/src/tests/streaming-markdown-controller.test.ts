import assert from "node:assert/strict";
import { test } from "node:test";
import { StreamingMarkdownController } from "../lib/streaming-markdown-controller";

type FrameFn = (now: number) => void;

function installFakeFrames() {
	const g = globalThis as Record<string, unknown>;
	const original = {
		requestAnimationFrame: g.requestAnimationFrame,
		cancelAnimationFrame: g.cancelAnimationFrame,
	};
	let now = 0;
	let nextId = 1;
	const frames = new Map<number, FrameFn>();
	g.requestAnimationFrame = ((fn: FrameFn) => {
		const id = nextId++;
		frames.set(id, fn);
		return id;
	}) as unknown;
	g.cancelAnimationFrame = ((id: number) => frames.delete(id)) as unknown;

	async function advance(ms: number) {
		const target = now + ms;
		while (now < target) {
			now = Math.min(target, now + 1000 / 60);
			for (const [id, fn] of [...frames]) {
				frames.delete(id);
				fn(now);
			}
			for (let i = 0; i < 20; i += 1) await Promise.resolve();
		}
	}

	function restore() {
		g.requestAnimationFrame = original.requestAnimationFrame;
		g.cancelAnimationFrame = original.cancelAnimationFrame;
	}

	return { advance, restore, pendingFrames: () => frames.size };
}

test("StreamingMarkdownController resets when the target diverges", async () => {
	const clock = installFakeFrames();
	try {
		const controller = new StreamingMarkdownController();
		const snapshots: string[] = [];
		controller.subscribe((snapshot) => snapshots.push(snapshot.source));

		controller.setTarget("alpha beta gamma delta");
		await clock.advance(500);
		assert.equal(snapshots.at(-1), "alpha beta gamma delta");

		controller.setTarget("completely different");
		assert.equal(snapshots.at(-1), "", "divergence publishes an empty reset");
		await clock.advance(500);
		assert.equal(snapshots.at(-1), "completely different");
		assert.equal(clock.pendingFrames(), 0, "loop must stop once caught up");
		controller.dispose();
	} finally {
		clock.restore();
	}
});
