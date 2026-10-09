import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyExecutionStats, type SessionStats } from "@cohub/protocol/model";
import type { SessionRecord } from "@neta-art/cohub";
import { getDisplayInputTokens } from "../lib/format-usage.ts";
import { mergeSessionRecord } from "../lib/session-record-merge.ts";

const stats = (revision: number): SessionStats => ({
	version: 1,
	revision,
	updatedAt: "2026-09-30T00:00:00Z",
	own: { ...emptyExecutionStats(), turns: revision },
	inherited: emptyExecutionStats(),
	auxiliaryUsage: null,
});
const original: SessionRecord = {
	id: "s",
	spaceId: "space",
	userUuid: "u",
	title: "Title",
	source: "web",
	status: "active",
	externalSessionId: null,
	latestMessageText: "Hello",
	lastMessageAt: null,
	lastMessageId: null,
	createdAt: "2026-09-30T00:00:00Z",
	updatedAt: "2026-09-30T00:00:00Z",
	meta: { custom: "keep", stats: stats(2) },
};

test("input display includes cache writes, consistently with the cache-hit denominator", () => {
	assert.equal(
		getDisplayInputTokens({ input: 10, cacheRead: 70, cacheWrite: 20 }),
		100,
	);
	assert.equal(
		getDisplayInputTokens({ input: 0, cacheRead: 0, cacheWrite: 0 }),
		0,
	);
});

test("stats-only realtime patches preserve full session metadata and profile fields", () => {
	const { meta: _meta, ...wire } = original;
	const merged = mergeSessionRecord(original, { ...wire, stats: stats(3) });
	assert.equal(merged.meta?.custom, "keep");
	assert.deepEqual(merged.meta?.stats, stats(3));
	assert.equal(merged.lastMessageAt, original.lastMessageAt);
});

test("out-of-order snapshots cannot regress the stats revision", () => {
	const merged = mergeSessionRecord(original, {
		...original,
		meta: { stats: stats(1), custom: "new value" },
	});
	assert.deepEqual(merged.meta?.stats, stats(2));
	assert.equal(merged.meta?.custom, "new value");
});

test("a realtime stats patch can initialize an uncached session", () => {
	const { meta: _meta, ...wire } = original;
	const merged = mergeSessionRecord(null, { ...wire, stats: stats(3) });
	assert.deepEqual(merged.meta?.stats, stats(3));
	assert.equal(Object.hasOwn(merged, "stats"), false);
});

test("ordinary updates survive repeated merges after initialization by a stats event", () => {
	const { meta: _meta, ...wire } = original;
	const event = { ...wire, stats: stats(3) };
	const initialized = mergeSessionRecord(null, event);
	const update = {
		...wire,
		title: "New title",
		status: "archived",
		latestMessageText: "New message",
		lastMessageId: "message-2",
		lastMessageAt: "2026-10-01T00:00:00Z",
		updatedAt: "2026-10-01T00:00:00Z",
	};
	const host = mergeSessionRecord(initialized, update);
	const workspace = mergeSessionRecord(initialized, host);
	for (const result of [host, workspace]) {
		assert.equal(result.title, update.title);
		assert.equal(result.status, update.status);
		assert.equal(result.latestMessageText, update.latestMessageText);
		assert.equal(result.lastMessageId, update.lastMessageId);
		assert.equal(result.lastMessageAt, update.lastMessageAt);
		assert.equal(result.updatedAt, update.updatedAt);
		assert.deepEqual(result.meta?.stats, stats(3));
		assert.equal(Object.hasOwn(result, "stats"), false);
	}
	assert.deepEqual(
		event.stats,
		stats(3),
		"normalization must not mutate the incoming event",
	);
});

test("both merge paths clean legacy cached wire fields without mutating the cache input", () => {
	const cached = { ...original, stats: stats(2) };
	const snapshot = structuredClone(cached);
	for (const incoming of [
		{ ...original, title: "New title" },
		{ ...original, stats: stats(3) },
	]) {
		const normalized = mergeSessionRecord(cached, incoming);
		assert.equal(Object.hasOwn(normalized, "stats"), false);
		const updated = mergeSessionRecord(normalized, {
			...original,
			title: "Latest title",
		});
		assert.equal(updated.title, "Latest title");
		assert.deepEqual(cached, snapshot);
	}
});

test("late stats notifications do not roll back a newer session title or activity", () => {
	const merged = mergeSessionRecord(original, {
		...original,
		title: "Old title",
		updatedAt: "2000-01-01T00:00:00Z",
		stats: stats(3),
	});
	assert.equal(merged.title, original.title);
	assert.equal(merged.updatedAt, original.updatedAt);
	assert.deepEqual(merged.meta?.stats, stats(3));
});

test("corrupt optional stats never erase a valid cached projection", () => {
	const merged = mergeSessionRecord(original, {
		...original,
		stats: { version: 99 },
	});
	assert.deepEqual(merged.meta?.stats, stats(2));
});
