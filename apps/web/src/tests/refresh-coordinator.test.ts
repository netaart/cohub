import assert from "node:assert/strict";
import { test } from "node:test";
import { createRefreshCoordinator } from "../lib/refresh-coordinator.ts";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("ensureFresh coalesces concurrent changes into one trailing refresh", {
	timeout: 1_000,
}, async () => {
	const activeSpaceId = "space-1";
	let calls = 0;
	const gates = [deferred(), deferred()] as const;
	const secondStarted = deferred();
	const coordinator = createRefreshCoordinator<string>({
		isCurrent: (spaceId) => spaceId === activeSpaceId,
		refresh: async () => {
			const call = calls++;
			if (call === 1) secondStarted.resolve();
			const gate = gates[call];
			assert.ok(gate);
			await gate.promise;
		},
	});

	const initial = coordinator.refresh("space-1");
	const ordinaryDuplicate = coordinator.refresh("space-1");
	const changedOnce = coordinator.refresh("space-1", { ensureFresh: true });
	const changedTwice = coordinator.refresh("space-1", { ensureFresh: true });
	assert.equal(calls, 1);

	gates[0].resolve();
	await secondStarted.promise;
	assert.equal(calls, 2);
	gates[1].resolve();
	await Promise.all([initial, ordinaryDuplicate, changedOnce, changedTwice]);
	assert.equal(calls, 2);
});

test("ensureFresh does not refresh a space after navigation", async () => {
	let activeSpaceId = "space-1";
	let calls = 0;
	const gate = deferred();
	const coordinator = createRefreshCoordinator<string>({
		isCurrent: (spaceId) => spaceId === activeSpaceId,
		refresh: async () => {
			calls += 1;
			await gate.promise;
		},
	});

	const initial = coordinator.refresh("space-1");
	const changed = coordinator.refresh("space-1", { ensureFresh: true });
	activeSpaceId = "space-2";
	gate.resolve();
	await Promise.all([initial, changed]);
	assert.equal(calls, 1);
});
