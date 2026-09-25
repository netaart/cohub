import assert from "node:assert/strict";
import test from "node:test";
import type { AppRecord } from "@neta-art/cohub";
import {
	compareAppsByRecentUpdate,
	sortAppsByRecentUpdate,
} from "$lib/app-sort";

function app(
	id: string,
	updatedAt: string | null,
	createdAt: string | null = updatedAt,
): AppRecord {
	return {
		id,
		spaceId: "space-1",
		userUuid: "user-1",
		slug: id,
		status: "published",
		visibility: "public",
		targetType: "file",
		targetRef: "index.html",
		assetKey: "asset",
		currentVersionId: null,
		latestVersion: 1,
		publishedAt: null,
		appScopes: [],
		allowedViewerScopes: [],
		meta: null,
		createdAt,
		updatedAt,
	} as AppRecord;
}

test("sortAppsByRecentUpdate mirrors the API: updated_at desc, created_at desc", () => {
	const older = app("a", "2026-07-20T01:00:00.000Z");
	const newer = app("b", "2026-07-20T05:00:00.000Z");
	const middle = app("c", "2026-07-20T03:00:00.000Z");
	assert.deepEqual(
		sortAppsByRecentUpdate([older, newer, middle]).map((item) => item.id),
		["b", "c", "a"],
	);
});

test("compareAppsByRecentUpdate breaks ties on created_at", () => {
	const firstCreated = app(
		"a",
		"2026-07-20T02:00:00.000Z",
		"2026-07-19T00:00:00.000Z",
	);
	const laterCreated = app(
		"b",
		"2026-07-20T02:00:00.000Z",
		"2026-07-19T06:00:00.000Z",
	);
	assert.equal(compareAppsByRecentUpdate(firstCreated, laterCreated) > 0, true);
	assert.deepEqual(
		sortAppsByRecentUpdate([firstCreated, laterCreated]).map((item) => item.id),
		["b", "a"],
	);
});

test("missing timestamps sort last and inputs are not mutated", () => {
	const dated = app("a", "2026-07-20T01:00:00.000Z");
	const undated = app("b", null, null);
	const input = [undated, dated];
	const sorted = sortAppsByRecentUpdate(input);
	assert.deepEqual(
		sorted.map((item) => item.id),
		["a", "b"],
	);
	// A fresh array is returned; the caller's list keeps its old order.
	assert.deepEqual(
		input.map((item) => item.id),
		["b", "a"],
	);
});
