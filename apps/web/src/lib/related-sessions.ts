import type { SessionRecord } from "@neta-art/cohub";
import { untrack } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import type { RelatedSessionRef } from "$lib/sent-turns";
import { getSessionListTitle } from "$lib/session-fork-tree";

export type RelatedSessionView =
	| { status: "loading" }
	| { status: "ready"; title: string | null }
	| { status: "unavailable" }
	| { status: "unknown" };

export type RelatedSessions = {
	get(ref: RelatedSessionRef): RelatedSessionView;
	request(refs: Iterable<RelatedSessionRef>): void;
};

const LOADING: RelatedSessionView = { status: "loading" };
const UNAVAILABLE: RelatedSessionView = { status: "unavailable" };
const UNKNOWN: RelatedSessionView = { status: "unknown" };

const refKey = (ref: RelatedSessionRef) => `${ref.spaceId}:${ref.sessionId}`;

const ready = (session: SessionRecord): RelatedSessionView => ({
	status: "ready",
	title: getSessionListTitle(session),
});

export function createRelatedSessions(ports: {
	live: (ref: RelatedSessionRef) => SessionRecord | null | undefined;
	load: (ref: RelatedSessionRef) => Promise<SessionRecord>;
	isUnavailable: (error: unknown) => boolean;
	concurrency?: number;
}): RelatedSessions {
	const settled = new SvelteMap<string, RelatedSessionView>();
	const queue: RelatedSessionRef[] = [];
	const concurrency = ports.concurrency ?? 4;
	let active = 0;

	function pump() {
		while (active < concurrency) {
			const ref = queue.shift();
			if (!ref) return;
			const key = refKey(ref);
			active += 1;
			ports
				.load(ref)
				.then(
					(session) => settled.set(key, ready(session)),
					(error: unknown) => {
						if (ports.isUnavailable(error)) settled.set(key, UNAVAILABLE);
						else settled.delete(key);
					},
				)
				.finally(() => {
					active -= 1;
					pump();
				});
		}
	}

	return {
		get(ref) {
			const live = ports.live(ref);
			return live ? ready(live) : (settled.get(refKey(ref)) ?? UNKNOWN);
		},
		request(refs) {
			untrack(() => {
				for (const ref of refs) {
					const key = refKey(ref);
					if (settled.has(key) || ports.live(ref)) continue;
					settled.set(key, LOADING);
					queue.push(ref);
				}
				pump();
			});
		},
	};
}
