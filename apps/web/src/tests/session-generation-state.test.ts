import assert from "node:assert/strict";
import { test } from "node:test";
import {
	canResumeRecoveredGeneration,
	hasRunningSessionTurn,
	isTerminalGenerationStatus,
	removeGenerationStatesForSpace,
	shouldResumePendingGeneration,
} from "../lib/stores/session-generation-state.ts";

test("awaited recovery yields to a newer Turn", async () => {
	const target = { id: "turn-a", sequence: 1 };
	for (const status of ["pending", "streaming", "completed", "failed"]) {
		let current = { status: "pending", turnId: "turn-a", lastEventAt: 50 };
		const recovery = Promise.resolve().then(() => {
			if (canResumeRecoveredGeneration(current, target, 100, 2)) {
				current = { status: "pending", turnId: target.id, lastEventAt: 300 };
			}
		});
		current = { status, turnId: "turn-b", lastEventAt: 200 };
		await recovery;
		assert.equal(current.turnId, "turn-b");
	}
	assert.equal(
		canResumeRecoveredGeneration(
			{ status: "completed", turnId: "turn-a" },
			target,
			100,
			1,
		),
		false,
	);
	assert.equal(canResumeRecoveredGeneration(null, target, 100), true);
});

test("composer shows Stop only for live server-backed Turns", () => {
	assert.equal(
		hasRunningSessionTurn(null, { id: "t1", status: "running" }),
		true,
	);
	assert.equal(
		hasRunningSessionTurn(null, { id: "t1", status: "abort_requested" }),
		true,
	);
	assert.equal(
		hasRunningSessionTurn(null, { id: "t1", status: "queued" }),
		false,
	);
	assert.equal(
		hasRunningSessionTurn(
			{ status: "streaming", turnId: "t1" },
			{ id: "t2", status: "queued" },
		),
		true,
	);
	assert.equal(
		hasRunningSessionTurn(
			{ status: "completed", turnId: "t1" },
			{ id: "t1", status: "running" },
		),
		false,
	);
	assert.equal(
		hasRunningSessionTurn(
			{ status: "completed", turnId: "t1" },
			{ id: "t2", status: "running" },
		),
		true,
	);
});

test("terminal and resume classification", () => {
	assert.equal(isTerminalGenerationStatus("streaming"), false);
	assert.equal(isTerminalGenerationStatus("completed"), true);
	assert.equal(
		shouldResumePendingGeneration({ status: "completed", turnId: "t1" }, "t1"),
		false,
	);
	assert.equal(
		shouldResumePendingGeneration({ status: "completed", turnId: "t1" }, "t2"),
		true,
	);
	assert.equal(shouldResumePendingGeneration(null, "t2"), true);
});

test("space reset partitions matching sessions only", () => {
	const states = {
		"session-a": { spaceId: "space-a", turnId: "turn-a" },
		"session-b": { spaceId: "space-b", turnId: "turn-b" },
	};
	const result = removeGenerationStatesForSpace(states, "space-a");
	assert.deepEqual(result.removedSessionIds, ["session-a"]);
	assert.deepEqual(result.remaining, { "session-b": states["session-b"] });
	assert.equal(removeGenerationStatesForSpace(states, null).remaining, states);
});
