import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardStage } from "@neta-art/cohub/board/stage";
import { settleBoardStage } from "#lib/board/runtime/board-runtime.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("settleBoardStage succeeds only once a current stage starts", async () => {
	globalThis.requestAnimationFrame = (run) => {
		setTimeout(() => run(0), 0);
		return 0;
	};
	const stage = (ready: Promise<boolean>) => ({ ready }) as BoardStage;
	const results: Array<[string, boolean]> = [];
	const watch = (name: string, ready: Promise<boolean>, current = true) =>
		settleBoardStage(
			stage(ready),
			() => current,
			(ok) => results.push([name, ok]),
		);

	watch("started", Promise.resolve(true));
	watch("canvas failed", Promise.resolve(false));
	watch("threw", Promise.reject(new Error("init")));
	watch("replaced", Promise.resolve(true), false);
	for (let i = 0; i < 5; i++) await tick();

	assert.deepEqual(
		results.sort(([a], [b]) => a.localeCompare(b)),
		[
			["canvas failed", false],
			["started", true],
			["threw", false],
		],
	);
});
