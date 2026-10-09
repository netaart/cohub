import assert from "node:assert/strict";
import { test } from "node:test";
import {
	emptyGenerationStreamResiduals,
	generationTurnChanged,
	isLiveTurnStatus,
	isTerminalGenerationStatus,
	planGenerationReconcile,
	removeGenerationStatesForSpace,
	resolveGenerationProgressResiduals,
	resolveGenerationStreamResiduals,
	shouldResumePendingGeneration,
} from "../lib/stores/session-generation-state.ts";

const residuals = {
	contentBlocks: ["old answer"],
	intermediateMessages: ["old process"],
	streamMessageId: "turn:t1:assistant:1",
	messageOrdinal: 1,
	truncatedStart: true,
	patchSeq: 3,
	finalizedPreview: true,
};

test("turn changes require two distinct concrete ids", () => {
	assert.equal(generationTurnChanged("t1", "t2"), true);
	assert.equal(generationTurnChanged("t1", "t1"), false);
	assert.equal(generationTurnChanged(null, "t2"), false);
	assert.equal(generationTurnChanged("t1", null), false);
});

test("new turns clear every live stream residual", () => {
	assert.deepEqual(
		resolveGenerationStreamResiduals(residuals, true),
		emptyGenerationStreamResiduals(),
	);
	assert.deepEqual(
		resolveGenerationStreamResiduals(residuals, false),
		residuals,
	);
});

test("progress preserves same-turn residuals and resets omitted cross-turn fields", () => {
	const current = {
		intermediateMessages: residuals.intermediateMessages,
		streamMessageId: residuals.streamMessageId,
		messageOrdinal: residuals.messageOrdinal,
		truncatedStart: residuals.truncatedStart,
		patchSeq: residuals.patchSeq,
	};

	assert.deepEqual(
		resolveGenerationProgressResiduals(current, {}, false),
		current,
	);
	assert.deepEqual(resolveGenerationProgressResiduals(current, {}, true), {
		intermediateMessages: [],
		streamMessageId: null,
		messageOrdinal: null,
		truncatedStart: false,
		patchSeq: 0,
	});
	assert.deepEqual(
		resolveGenerationProgressResiduals(
			current,
			{ intermediateMessages: ["new process"], patchSeq: 1 },
			true,
		),
		{
			intermediateMessages: ["new process"],
			streamMessageId: null,
			messageOrdinal: null,
			truncatedStart: false,
			patchSeq: 1,
		},
	);
});

test("space reset partitions matching sessions without touching other spaces", () => {
	const states = {
		"session-a": { spaceId: "space-a", turnId: "turn-a" },
		"session-b": { spaceId: "space-b", turnId: "turn-b" },
		"session-c": { spaceId: "space-a", turnId: "turn-c" },
	};

	const result = removeGenerationStatesForSpace(states, "space-a");

	assert.deepEqual(result.removedSessionIds, ["session-a", "session-c"]);
	assert.deepEqual(result.remaining, {
		"session-b": { spaceId: "space-b", turnId: "turn-b" },
	});
});

test("space reset preserves the original state for an empty space id", () => {
	const states = {
		"session-a": { spaceId: "space-a", turnId: "turn-a" },
	};
	for (const spaceId of [null, undefined, ""] as const) {
		const result = removeGenerationStatesForSpace(states, spaceId);
		assert.equal(result.remaining, states);
		assert.deepEqual(result.removedSessionIds, []);
	}
});

test("idle is not terminal, finished statuses are", () => {
	assert.equal(isTerminalGenerationStatus("idle"), false);
	assert.equal(isTerminalGenerationStatus("pending"), false);
	assert.equal(isTerminalGenerationStatus("streaming"), false);
	assert.equal(isTerminalGenerationStatus("completed"), true);
	assert.equal(isTerminalGenerationStatus("failed"), true);
	assert.equal(isTerminalGenerationStatus("interrupted"), true);
});

test("only running and abort_requested are live turn statuses", () => {
	assert.equal(isLiveTurnStatus("running"), true);
	assert.equal(isLiveTurnStatus("abort_requested"), true);
	assert.equal(isLiveTurnStatus("queued"), false);
	assert.equal(isLiveTurnStatus("completed"), false);
	assert.equal(isLiveTurnStatus(null), false);
});

test("a queued active turn never resumes or replaces live generation", () => {
	// A queued turn behind a running one must not steal the live state.
	assert.deepEqual(
		planGenerationReconcile({
			current: { status: "streaming", turnId: "turn-running" },
			activeTurn: { id: "turn-queued", status: "queued" },
			authoritative: true,
			requestStartedAt: 100,
		}),
		{ reset: false, resumeTurnId: null },
	);
});

test("a live active turn resets the previous turn and resumes itself", () => {
	assert.deepEqual(
		planGenerationReconcile({
			current: { status: "streaming", turnId: "turn-old" },
			activeTurn: { id: "turn-new", status: "running" },
			authoritative: false,
			requestStartedAt: 0,
		}),
		{ reset: true, resumeTurnId: "turn-new" },
	);
	assert.deepEqual(
		planGenerationReconcile({
			current: { status: "streaming", turnId: "turn-1" },
			activeTurn: { id: "turn-1", status: "abort_requested" },
			authoritative: false,
			requestStartedAt: 0,
		}),
		{ reset: false, resumeTurnId: "turn-1" },
	);
});

test("missing hints keep state; authoritative null clears a stale pending turn", () => {
	assert.deepEqual(
		planGenerationReconcile({
			current: { status: "pending", turnId: "turn-1" },
			activeTurn: undefined,
			authoritative: true,
			requestStartedAt: 0,
		}),
		{ reset: false, resumeTurnId: null },
	);
	assert.deepEqual(
		planGenerationReconcile({
			current: { status: "pending", turnId: "turn-1", lastEventAt: 50 },
			activeTurn: null,
			authoritative: true,
			requestStartedAt: 100,
		}),
		{ reset: true, resumeTurnId: null },
	);
	assert.deepEqual(
		planGenerationReconcile({
			current: { status: "pending", turnId: "turn-1", lastEventAt: 50 },
			activeTurn: null,
			authoritative: false,
			requestStartedAt: 100,
		}),
		{ reset: false, resumeTurnId: null },
	);
});

test("stale active-turn hint never downgrades a finished same turn", () => {
	assert.equal(
		shouldResumePendingGeneration(
			{ status: "completed", turnId: "turn-1" },
			"turn-1",
		),
		false,
	);
	assert.equal(
		shouldResumePendingGeneration(
			{ status: "failed", turnId: "turn-1" },
			"turn-1",
		),
		false,
	);
});

test("resume still applies to new turns and resumable states", () => {
	assert.equal(
		shouldResumePendingGeneration(
			{ status: "completed", turnId: "turn-1" },
			"turn-2",
		),
		true,
	);
	assert.equal(
		shouldResumePendingGeneration({ status: "idle", turnId: null }, "turn-2"),
		true,
	);
	assert.equal(shouldResumePendingGeneration(null, "turn-2"), true);
	assert.equal(
		shouldResumePendingGeneration(
			{ status: "completed", turnId: null },
			"turn-2",
		),
		true,
	);
});
