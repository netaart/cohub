import type { AppRecord, AppVersionRecord } from "@neta-art/cohub";
import { sortAppsByRecentUpdate } from "#lib/app-sort.ts";
import {
	type AppDomainChange,
	isNewerAppSnapshot,
} from "#lib/resource-kit/app.ts";

export const APPS_CHANGED_EVENT = "cohub:apps-changed";
export const INSTALLED_APPS_CHANGED_EVENT = "cohub:installed-apps-changed";
export const APP_DOMAINS_CHANGED_EVENT = "cohub:app-domains-changed";

export type AppsChangedDetail = {
	spaceId: string;
	app?: AppRecord;
	version?: AppVersionRecord;
	deletedAppId?: string;
};

export function upsertAppSnapshot(apps: AppRecord[], next: AppRecord) {
	const index = apps.findIndex((app) => app.id === next.id);
	if (index >= 0 && !isNewerAppSnapshot(apps[index], next)) return apps;
	const updated = [...apps];
	if (index < 0) updated.push(next);
	else updated[index] = next;
	// The list is served newest-updated-first, so a fresh snapshot has to take
	// its sorted place: an edit floats the app to the top rather than leaving
	// it stranded where it used to sit.
	return sortAppsByRecentUpdate(updated);
}

/**
 * Buffer of realtime app mutations for replay onto an in-flight list response.
 *
 * A full list request and a realtime event can overlap, and the response is
 * built from a snapshot older than the event. Discarding the response would
 * leave only the apps the events happened to carry, so the events are instead
 * folded back on top of it.
 */
export function createAppMutationBuffer() {
	const upserts = new Map<string, AppRecord>();
	const deletes = new Set<string>();

	function reset() {
		upserts.clear();
		deletes.clear();
	}

	return {
		reset,
		upsert(app: AppRecord) {
			deletes.delete(app.id);
			upserts.set(app.id, app);
		},
		remove(appId: string) {
			upserts.delete(appId);
			deletes.add(appId);
		},
		/** Apply the buffered mutations to a fetched list and drain the buffer. */
		apply(list: AppRecord[]) {
			let next =
				deletes.size > 0 ? list.filter((app) => !deletes.has(app.id)) : list;
			for (const app of upserts.values()) next = upsertAppSnapshot(next, app);
			reset();
			return next;
		},
	};
}

export function dispatchAppsChanged(detail: AppsChangedDetail) {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent(APPS_CHANGED_EVENT, { detail }));
}

export function dispatchInstalledAppsChanged(spaceId: string) {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent(INSTALLED_APPS_CHANGED_EVENT, { detail: { spaceId } }),
	);
}

export function dispatchAppDomainsChanged(detail: AppDomainChange) {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent(APP_DOMAINS_CHANGED_EVENT, { detail }));
}
