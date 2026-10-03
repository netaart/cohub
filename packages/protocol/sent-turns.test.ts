import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSentTurnRef, readSentTurns, readSessionTurnOrigin } from "./src/index.js";

const SESSION = "22222222-2222-4222-8222-222222222222";
const CHILD_A = "44444444-4444-4444-8444-444444444444";
const CHILD_B = "66666666-6666-4666-8666-666666666666";
const CALLER = "33333333-3333-4333-8333-333333333333";

const ref = (turnId: string) => ({ sessionId: SESSION, turnId, kind: "prompt" as const });

test("rejects malformed entries and tolerates Turns without the field", () => {
	assert.deepEqual(readSentTurns(null), []);
	assert.deepEqual(readSentTurns({}), []);
	assert.deepEqual(readSentTurns({ messagesSent: "nope" }), []);
	assert.deepEqual(readSentTurns({ messagesSent: [null, 1, ref("not-a-uuid")] }), []);
	assert.deepEqual(
		readSentTurns({ messagesSent: [{ ...ref(CHILD_A), kind: "bogus" }] }),
		[],
	);
});

test("deduplicates by child Turn so a retry never renders twice", () => {
	const value = {
		messagesSent: [ref(CHILD_A), { ...ref(CHILD_A), kind: "hook" }, ref(CHILD_B)],
	};
	assert.deepEqual(readSentTurns(value), [ref(CHILD_A), ref(CHILD_B)]);
});

test("keeps every entry in send order, never truncating", () => {
	const many = Array.from({ length: 64 }, (_, index) =>
		ref(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
	);
	const read = readSentTurns({ messagesSent: many });
	assert.deepEqual(read.map((entry) => entry.turnId), many.map((entry) => entry.turnId));
});

test("normalizeSentTurnRef keeps only the durable identity", () => {
	assert.deepEqual(
		normalizeSentTurnRef({ ...ref(CHILD_A), title: "leaked", status: "done" }),
		ref(CHILD_A),
	);
});

test("a child's origin pairs with the caller's fan-out entry", () => {
	const childMeta = {
		origin: {
			kind: "prompt",
			spaceId: "11111111-1111-4111-8111-111111111111",
			sessionId: SESSION,
			turnId: CALLER,
			toolCallId: "call_review",
			depth: 1,
		},
	};
	assert.equal(readSessionTurnOrigin(childMeta)?.toolCallId, "call_review");
	assert.deepEqual(readSentTurns({ messagesSent: [ref(CHILD_A)] }), [ref(CHILD_A)]);
});
