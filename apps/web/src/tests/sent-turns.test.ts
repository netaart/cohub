import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionTurnRecord } from "@cohub/protocol/model";
import { buildSentTurnIndex, readSentFrom } from "../lib/sent-turns.ts";

const SPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_SPACE = "99999999-9999-4999-8999-999999999999";
const CALLER = "22222222-2222-4222-8222-222222222222";
const CHILD = "44444444-4444-4444-8444-444444444444";
const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const turn = (sessionId: string, meta: Record<string, unknown>) =>
	({ id: id(0), sessionId, meta }) as SessionTurnRecord;

test("fan-out groups children per Session and per tool call, skipping self", () => {
	const index = buildSentTurnIndex(
		[
			turn(CALLER, {
				messagesSent: [
					{
						spaceId: OTHER_SPACE,
						sessionId: CHILD,
						turnId: id(1),
						kind: "prompt",
						toolCallId: "toolu_1",
					},
					{
						spaceId: OTHER_SPACE,
						sessionId: CHILD,
						turnId: id(2),
						kind: "prompt",
						toolCallId: "toolu_1",
					},
					{ spaceId: SPACE, sessionId: CALLER, turnId: id(3), kind: "prompt" },
				],
			}),
		],
		SPACE,
	);
	const expected = [{ spaceId: OTHER_SPACE, sessionId: CHILD, count: 2 }];
	assert.deepEqual(index.byCallerTurn.get(id(0)), expected);
	assert.deepEqual(index.byToolCall.get("toolu_1"), expected);
});

test("a child names the Session that sent it, unless it sent itself", () => {
	const origin = {
		kind: "prompt",
		spaceId: OTHER_SPACE,
		sessionId: CALLER,
		turnId: id(9),
	};
	assert.deepEqual(readSentFrom(turn(CHILD, { origin })), {
		spaceId: OTHER_SPACE,
		sessionId: CALLER,
	});
	assert.equal(readSentFrom(turn(CALLER, { origin })), null);
});
