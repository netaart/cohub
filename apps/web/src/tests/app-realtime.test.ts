import assert from "node:assert/strict";
import test from "node:test";
import type { ChannelEnvelope } from "@cohub/protocol/realtime";
import type { AppRecord, AppVersionRecord } from "@neta-art/cohub";
import {
	createAppMutationBuffer,
	isNewerAppSnapshot,
	parseAppVersionPublished,
	upsertAppSnapshot,
	upsertAppVersion,
} from "$lib/features/app/app-realtime";

const app = (latestVersion: number, updatedAt: string): AppRecord => ({
	id: "work-1",
	spaceId: "space-1",
	userUuid: "user-1",
	slug: "demo",
	status: "published",
	visibility: "public",
	targetType: "file",
	targetRef: "index.html",
	assetKey: "asset",
	currentVersionId: `version-${latestVersion}`,
	latestVersion,
	publishedAt: updatedAt,
	appScopes: [],
	allowedViewerScopes: [],
	meta: null,
	createdAt: updatedAt,
	updatedAt,
});

const version = (value: number): AppVersionRecord => ({
	id: `version-${value}`,
	appId: "work-1",
	version: value,
	targetType: "file",
	targetRef: "index.html",
	assetKey: "asset",
	contentKind: "web",
	artifact: null,
	meta: null,
	createdAt: "2026-07-20T00:00:00.000Z",
});

test("parseAppVersionPublished validates the app relationship", () => {
	const event = {
		id: "event-1",
		timestamp: Date.now(),
		domain: "space",
		type: "app.version.published",
		spaceId: "space-1",
		payload: {
			app: app(2, "2026-07-20T00:00:00.000Z"),
			version: version(2),
			previousVersionId: "version-1",
		},
	} as ChannelEnvelope;
	assert.deepEqual(parseAppVersionPublished(event), {
		app: event.payload.app,
		version: event.payload.version,
		previousVersionId: "version-1",
	});

	const invalid = {
		...event,
		payload: { ...event.payload, version: { ...version(2), appId: "other" } },
	};
	assert.equal(parseAppVersionPublished(invalid), null);
});

test("upsertAppSnapshot ignores older and stale same-version snapshots", () => {
	const current = app(3, "2026-07-20T03:00:00.000Z");
	assert.equal(
		upsertAppSnapshot([current], app(2, "2026-07-20T04:00:00.000Z"))[0],
		current,
	);
	assert.equal(
		upsertAppSnapshot([current], app(3, "2026-07-20T02:00:00.000Z"))[0],
		current,
	);
	assert.equal(
		upsertAppSnapshot([current], app(4, "2026-07-20T01:00:00.000Z"))[0]
			?.latestVersion,
		4,
	);
});

test("upsertAppSnapshot floats an updated app back to the top", () => {
	const older = { ...app(1, "2026-07-20T01:00:00.000Z"), id: "work-2" };
	const current = app(2, "2026-07-20T02:00:00.000Z");
	// The touched app sits at the bottom before the update arrives.
	assert.deepEqual(
		upsertAppSnapshot([older, current], app(3, "2026-07-20T03:00:00.000Z")).map(
			(item) => item.id,
		),
		["work-1", "work-2"],
	);

	// A brand-new app is the most recently updated, so it leads the list.
	const fresh = { ...app(1, "2026-07-20T09:00:00.000Z"), id: "work-3" };
	assert.deepEqual(
		upsertAppSnapshot([older, current], fresh).map((item) => item.id),
		["work-3", "work-1", "work-2"],
	);
});

test("isNewerAppSnapshot accepts a different app regardless of version", () => {
	const current = app(5, "2026-07-20T05:00:00.000Z");
	const other: AppRecord = {
		...app(1, "2026-07-20T01:00:00.000Z"),
		id: "work-2",
	};
	// Switching to a lower-version app must not be treated as a stale snapshot.
	assert.equal(isNewerAppSnapshot(current, other), true);
});

test("upsertAppVersion deduplicates and keeps newest versions first", () => {
	assert.deepEqual(
		upsertAppVersion([version(1), version(2)], version(2)).map(
			(item) => item.version,
		),
		[2, 1],
	);
});

test("app mutation buffer replays realtime changes onto a stale list", () => {
	const buffer = createAppMutationBuffer();
	const other: AppRecord = {
		...app(1, "2026-07-20T00:00:00.000Z"),
		id: "work-2",
	};
	const published = app(5, "2026-07-20T05:00:00.000Z");

	// A publish lands while the full list request is still in flight.
	buffer.upsert(published);
	const merged = buffer.apply([app(4, "2026-07-20T04:00:00.000Z"), other]);

	// The event wins for its own Work, and the Space's other Works survive.
	assert.deepEqual(
		merged.map((item) => [item.id, item.latestVersion]),
		[
			["work-1", 5],
			["work-2", 1],
		],
	);
	// Draining leaves nothing to replay onto the next response.
	assert.deepEqual(buffer.apply([other]), [other]);
});

test("app mutation buffer keeps deletes and last write per app", () => {
	const buffer = createAppMutationBuffer();
	buffer.upsert(app(2, "2026-07-20T02:00:00.000Z"));
	buffer.remove("work-1");
	assert.deepEqual(buffer.apply([app(1, "2026-07-20T01:00:00.000Z")]), []);

	buffer.remove("work-1");
	buffer.upsert(app(3, "2026-07-20T03:00:00.000Z"));
	assert.deepEqual(
		buffer.apply([]).map((item) => item.latestVersion),
		[3],
	);
});
