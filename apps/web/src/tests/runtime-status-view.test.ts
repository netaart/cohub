import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeStatus } from "@neta-art/cohub";
import {
	freshWatcher,
	harnessModelCounts,
	isStale,
	RUNTIME_WATCHER_FRESHNESS_MS,
	runtimeTone,
} from "../lib/features/space/runtime-status-view.ts";

const watcher = (
	observedAt: number,
	state: "running" | "degraded" | "unavailable" = "running",
): RuntimeStatus["fileWatcher"] => ({
	backend: "fsevents",
	state,
	observedAt: new Date(observedAt).toISOString(),
});

const status = (overrides: Partial<RuntimeStatus> = {}): RuntimeStatus => ({
	kind: "local",
	online: true,
	capabilities: null,
	fileWatcher: null,
	...overrides,
});

test("missing or expired telemetry is stale", () => {
	const now = 1_000_000;
	assert.equal(isStale(new Date(now - 1_000).toISOString(), now), false);
	assert.equal(
		isStale(new Date(now - RUNTIME_WATCHER_FRESHNESS_MS).toISOString(), now),
		true,
	);
	assert.equal(isStale("not-a-date", now), true);
});

test("stale watcher telemetry is not treated as fresh", () => {
	const now = 1_000_000;
	assert.equal(
		freshWatcher(
			status({ fileWatcher: watcher(now - RUNTIME_WATCHER_FRESHNESS_MS) }),
			now,
		),
		null,
	);
	assert.ok(freshWatcher(status({ fileWatcher: watcher(now - 1_000) }), now));
});

test("tone follows connection and fresh watcher health", () => {
	const now = 1_000_000;
	assert.equal(runtimeTone(null, now), "offline");
	assert.equal(runtimeTone(status({ online: false }), now), "offline");
	assert.equal(runtimeTone(status(), now), "online");
	assert.equal(
		runtimeTone(status({ fileWatcher: watcher(now, "running") }), now),
		"online",
	);
	assert.equal(
		runtimeTone(status({ fileWatcher: watcher(now, "unavailable") }), now),
		"attention",
	);
	// Expired telemetry degrades to unknown, not attention.
	assert.equal(
		runtimeTone(
			status({
				fileWatcher: watcher(now - RUNTIME_WATCHER_FRESHNESS_MS, "degraded"),
			}),
			now,
		),
		"online",
	);
});

test("an online Harness never hides a disconnected file bridge or an expired status", () => {
	const now = Date.now();
	const observedAt = new Date(now).toISOString();
	assert.equal(
		runtimeTone(
			status({ observedAt, workspace: { online: false, observedAt: null } }),
			now,
		),
		"attention",
	);
	assert.equal(
		runtimeTone(
			status({ observedAt, workspace: { online: true, observedAt } }),
			now,
		),
		"online",
	);
	assert.equal(
		runtimeTone(
			status({ observedAt: new Date(now - 60_000).toISOString() }),
			now,
		),
		"unknown",
	);
	assert.equal(
		runtimeTone(
			status({
				workspace: {
					online: true,
					observedAt: new Date(now - 60_000).toISOString(),
				},
			}),
			now,
		),
		"attention",
	);
});

test("model counts are grouped by harness", () => {
	assert.deepEqual(harnessModelCounts(null), { pi: 0, codex: 0 });
	assert.deepEqual(
		harnessModelCounts(
			status({
				capabilities: {
					harnesses: ["pi", "codex"],
					models: [
						{ harness: "pi", provider: "p", id: "a", name: "A" },
						{ harness: "pi", provider: "p", id: "b", name: "B" },
						{ harness: "codex", provider: "c", id: "d", name: "D" },
					],
				},
			}),
		),
		{ pi: 2, codex: 1 },
	);
});
