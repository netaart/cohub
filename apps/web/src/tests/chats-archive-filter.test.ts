import assert from "node:assert/strict";
import { test } from "node:test";
import {
	chatsFilterScope,
	parseChatsFilter,
	sessionFit,
} from "../lib/stores/chats-filter";

const session = {
	id: "session-1",
	spaceId: "space-1",
	userUuid: "viewer",
	source: "web",
	lastMessageAt: "2026-01-01T00:00:00.000Z",
} as const;

const active = { source: "web", space: null, archived: false } as const;
const archivedView = { source: null, space: null, archived: true } as const;

test("archived chats leave active lists and appear only in the archive view", () => {
	assert.equal(sessionFit(session, active, "viewer", false), "in");
	assert.equal(sessionFit(session, active, "viewer", true), "out");
	assert.equal(sessionFit(session, archivedView, "viewer", true), "in");
	assert.equal(sessionFit(session, archivedView, "viewer", false), "out");
});

test("archive view scope never collides with active list caches", () => {
	assert.notEqual(
		chatsFilterScope({ source: null, space: null, archived: false }),
		chatsFilterScope({ source: null, space: null, archived: true }),
	);
	assert.notEqual(
		chatsFilterScope({ source: "web", space: null, archived: false }),
		chatsFilterScope({ source: null, space: null, archived: true }),
	);
});

test("stored filters without an archive flag stay in the active list", () => {
	assert.deepEqual(
		parseChatsFilter(JSON.stringify({ source: "web", space: null })),
		{ source: "web", space: null, archived: false },
	);
	assert.equal(
		parseChatsFilter(
			JSON.stringify({ source: null, space: null, archived: true }),
		).archived,
		true,
	);
});
