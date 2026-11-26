import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	SessionTurnIndexItem,
	SessionTurnRecord,
} from "@cohub/protocol/model";
import { turnsBehindIndex } from "../lib/stores/turn-cache.ts";

const turn = (id: string, status: SessionTurnRecord["status"]) =>
	({ id, status }) as SessionTurnRecord;
const indexItem = (id: string, status: SessionTurnIndexItem["status"]) =>
	({ id, status }) as SessionTurnIndexItem;

test("turn index flags cached turns the server already moved past", () => {
	assert.deepEqual(
		turnsBehindIndex(
			[
				turn("ghost", "queued"),
				turn("waiting", "queued"),
				turn("finished", "running"),
				turn("live", "running"),
				turn("unindexed", "queued"),
			],
			[
				indexItem("ghost", "merged"),
				indexItem("waiting", "queued"),
				indexItem("finished", "completed"),
				indexItem("live", "queued"),
			],
		),
		["ghost", "finished"],
	);
});
