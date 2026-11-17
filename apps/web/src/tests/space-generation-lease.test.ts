import assert from "node:assert/strict";
import { test } from "node:test";
import {
	__resetSpaceGenerationLeaseForTests,
	acquireSpaceGeneration,
	getSpaceGenerationLeaseCount,
	releaseSpaceGeneration,
} from "../lib/features/session-chat/space-generation-lease.ts";

test("second host entering same space does not reset", () => {
	const resets: string[] = [];
	__resetSpaceGenerationLeaseForTests((id) => {
		resets.push(id);
	});
	acquireSpaceGeneration("space-a");
	acquireSpaceGeneration("space-a");
	assert.equal(getSpaceGenerationLeaseCount("space-a"), 2);
	assert.deepEqual(resets, []);
});

test("only last host leaving a space resets it", () => {
	const resets: string[] = [];
	__resetSpaceGenerationLeaseForTests((id) => {
		resets.push(id);
	});
	acquireSpaceGeneration("space-a");
	acquireSpaceGeneration("space-a");
	releaseSpaceGeneration("space-a");
	assert.equal(getSpaceGenerationLeaseCount("space-a"), 1);
	assert.deepEqual(resets, []);
	releaseSpaceGeneration("space-a");
	assert.equal(getSpaceGenerationLeaseCount("space-a"), 0);
	assert.deepEqual(resets, ["space-a"]);
});

test("hosts in different spaces reset independently", () => {
	const resets: string[] = [];
	__resetSpaceGenerationLeaseForTests((id) => {
		resets.push(id);
	});
	acquireSpaceGeneration("space-a");
	acquireSpaceGeneration("space-b");
	releaseSpaceGeneration("space-a");
	assert.deepEqual(resets, ["space-a"]);
	assert.equal(getSpaceGenerationLeaseCount("space-b"), 1);
	releaseSpaceGeneration("space-b");
	assert.deepEqual(resets, ["space-a", "space-b"]);
});

test("empty spaceId is a no-op", () => {
	const resets: string[] = [];
	__resetSpaceGenerationLeaseForTests((id) => {
		resets.push(id);
	});
	acquireSpaceGeneration("");
	releaseSpaceGeneration("");
	assert.deepEqual(resets, []);
});

test("under-release after last host leaves is a no-op", () => {
	const resets: string[] = [];
	__resetSpaceGenerationLeaseForTests((id) => {
		resets.push(id);
	});
	acquireSpaceGeneration("space-a");
	releaseSpaceGeneration("space-a");
	assert.deepEqual(resets, ["space-a"]);
	// Extra releases (dispose after soft-clear, double dispose) must not reset again.
	releaseSpaceGeneration("space-a");
	releaseSpaceGeneration("space-a");
	assert.equal(getSpaceGenerationLeaseCount("space-a"), 0);
	assert.deepEqual(resets, ["space-a"]);
});

test("release without acquire is a no-op", () => {
	const resets: string[] = [];
	__resetSpaceGenerationLeaseForTests((id) => {
		resets.push(id);
	});
	releaseSpaceGeneration("never-acquired");
	assert.equal(getSpaceGenerationLeaseCount("never-acquired"), 0);
	assert.deepEqual(resets, []);
});
