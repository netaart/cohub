import type { AppRecord } from "@neta-art/cohub";

function timestamp(value: string | null | undefined) {
	const parsed = Date.parse(value ?? "");
	return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Mirrors the API's `updated_at desc nulls last, created_at desc`.
 *
 * The sidebar list is served in this order, so the client only needs it to
 * place an app that realtime just touched — an edit floats it back to the top
 * without waiting for the next full refresh.
 */
export function compareAppsByRecentUpdate(a: AppRecord, b: AppRecord) {
	const updated = timestamp(b.updatedAt) - timestamp(a.updatedAt);
	if (updated !== 0) return updated;
	return timestamp(b.createdAt) - timestamp(a.createdAt);
}

export function sortAppsByRecentUpdate(apps: AppRecord[]) {
	return [...apps].sort(compareAppsByRecentUpdate);
}
