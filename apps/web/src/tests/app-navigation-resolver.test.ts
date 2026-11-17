import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppDetailResponse } from "@neta-art/cohub";
import {
	createAppNavigationResolver,
	resolveAppNavigation,
} from "#lib/features/app/app-open.ts";

const detail = {
	app: { id: "11111111-1111-4111-8111-111111111111", status: "published" },
	content: { kind: "web", url: "https://apps.test/example" },
} as AppDetailResponse;

test("App identity shares lookups without sharing launch state or closed-tab details", async () => {
	let requests = 0;
	let opened: AppDetailResponse | null = null;
	const load = async () => {
		requests += 1;
		return detail;
	};
	const loader = { get: load, getPublicById: load, getBySlug: load };
	const refs = [
		"app://alice/studio/example#first",
		"https://cohub.test/alice/studio/w/example#second",
	];
	await Promise.all(refs.map((ref) => resolveAppNavigation(loader, ref)));
	assert.equal(requests, 2);
	requests = 0;
	const resolver = createAppNavigationResolver(loader, () => opened);
	const results = await Promise.all(refs.map((ref) => resolver.resolve(ref)));
	assert.equal(requests, 1);
	assert.deepEqual(
		results.map((result) => result.launch?.hash),
		["#first", "#second"],
	);
	opened = detail;
	await resolver.resolve("alice/studio/example", { hash: "#third" });
	assert.equal(requests, 1);
	opened = null;
	await resolver.resolve(refs[0]);
	assert.equal(requests, 2);
	opened = detail;
	resolver.clear();
	await resolver.resolve(refs[0]);
	assert.equal(requests, 3);
});

test("failed lookups are retryable and invalidated requests cannot repopulate aliases", async () => {
	let requests = 0;
	let finish!: (value: AppDetailResponse) => void;
	const load = async () => {
		requests += 1;
		if (requests === 1) throw new Error("Unavailable");
		if (requests === 2)
			return new Promise<AppDetailResponse>((resolve) => {
				finish = resolve;
			});
		return detail;
	};
	let opened: AppDetailResponse | null = null;
	const resolver = createAppNavigationResolver(
		{ get: load, getPublicById: load, getBySlug: load },
		() => opened,
	);
	await assert.rejects(resolver.resolve("alice/studio/example"));
	const pending = resolver.resolve("alice/studio/example");
	resolver.clear();
	finish(detail);
	await pending;
	opened = detail;
	await resolver.resolve("alice/studio/example");
	assert.equal(requests, 3);
});
