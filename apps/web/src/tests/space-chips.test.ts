import assert from "node:assert/strict";
import test from "node:test";
import type { SpaceRecord, UserSessionSpaceSummary } from "@neta-art/cohub";
import { nextSpaceChips } from "#lib/features/sessions/space-chips.ts";

const space = (id: string, name = id, isArchived = false) =>
	({ id, name, isArchived }) as SpaceRecord;
const summarize = (record: SpaceRecord): UserSessionSpaceSummary => ({
	id: record.id,
	name: record.name ?? record.id,
	slug: null,
	publicProfile: null,
});
const ids = (chips: UserSessionSpaceSummary[]) =>
	chips.map((chip) => chip.id).join(",");

test("nextSpaceChips follows the latest order unless held", () => {
	const current = nextSpaceChips(
		[],
		[space("a"), space("b")],
		false,
		summarize,
	);
	const latest = [space("c"), space("b"), space("a", "Alpha", true)];
	assert.equal(ids(nextSpaceChips(current, latest, false, summarize)), "c,b");
	const held = nextSpaceChips(current, latest, true, summarize);
	assert.equal(ids(held), "a,b");
	assert.equal(held[0]?.name, "Alpha");
});
