import type { ChannelEnvelope } from "@cohub/protocol/realtime";
import type { AppRecord, AppVersionRecord } from "@neta-art/cohub";
import { sortAppsByRecentUpdate } from "$lib/app-sort";

export const APPS_CHANGED_EVENT = "cohub:apps-changed";
export const INSTALLED_APPS_CHANGED_EVENT = "cohub:installed-apps-changed";

export type AppVersionPublishedPayload = {
	app: AppRecord;
	version: AppVersionRecord;
	previousVersionId: string | null;
};

export type AppsChangedDetail = {
	spaceId: string;
	app?: AppRecord;
	version?: AppVersionRecord;
	deletedAppId?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === "object" && !Array.isArray(value));

export function parseAppVersionPublished(
	event: ChannelEnvelope,
): AppVersionPublishedPayload | null {
	if (event.type !== "app.version.published" || !event.spaceId) return null;
	const app = isRecord(event.payload.app) ? event.payload.app : null;
	const version = isRecord(event.payload.version)
		? event.payload.version
		: null;
	if (
		!app ||
		!version ||
		typeof app.id !== "string" ||
		app.spaceId !== event.spaceId ||
		typeof app.latestVersion !== "number" ||
		typeof version.id !== "string" ||
		version.appId !== app.id ||
		typeof version.version !== "number"
	) {
		return null;
	}
	return {
		app: app as AppRecord,
		version: version as AppVersionRecord,
		previousVersionId:
			typeof event.payload.previousVersionId === "string"
				? event.payload.previousVersionId
				: null,
	};
}

function timestamp(value: string | null | undefined) {
	const parsed = Date.parse(value ?? "");
	return Number.isFinite(parsed) ? parsed : 0;
}

export function isNewerAppSnapshot(
	current: AppRecord | null | undefined,
	next: AppRecord,
) {
	if (!current) return true;
	// A snapshot of a different app is never an older version of the current
	// one, so route changes that reuse this guard must always win.
	if (next.id !== current.id) return true;
	if (next.latestVersion !== current.latestVersion) {
		return next.latestVersion > current.latestVersion;
	}
	return timestamp(next.updatedAt) >= timestamp(current.updatedAt);
}

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

export function upsertAppVersion(
	versions: AppVersionRecord[],
	next: AppVersionRecord,
) {
	const byId = new Map(versions.map((version) => [version.id, version]));
	byId.set(next.id, next);
	return [...byId.values()].sort((a, b) => b.version - a.version);
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
