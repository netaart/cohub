import { invalidatePaletteOverview } from "$lib/command-palette/palette-overview";
import { sdk } from "$lib/sdk";
import { authStore } from "$lib/stores/auth.svelte";
import {
	getCachedSpaceRecord,
	patchCachedSpaceRecordSoon,
} from "$lib/stores/space-record-cache";

/**
 * Space pin store — manages optimistic pin/unpin and multi-client sync.
 *
 * Pin state rides on `SpaceRecord.isPinned` in the space list cache, so the
 * space picker reads it directly with no extra fetch. Toggles are optimistic;
 * failures roll back precisely. Realtime `label.assignments.updated` events
 * (delivered to the user room) refresh the cached `isPinned` flag when another
 * tab/device mutates the user's labels.
 */

const PINNED_LABEL_REF = "Pinned";
let realtimeBound = false;

/** Subscribe to user-room realtime events for pin sync. Call once at app init. */
export function initSpacePinRealtime() {
	if (realtimeBound || typeof window === "undefined") return;
	realtimeBound = true;
	sdk.onUserEvent((event) => {
		if (event.type !== "label.assignments.updated") return;
		const payload = event.payload as {
			resourceType?: string;
			resourceRef?: string;
			resourceRefs?: string[];
			resourceAssignments?: Array<{
				resourceRef: string;
				assignments: Array<{ labelSystemKey?: string | null }>;
			}>;
		};
		if (payload.resourceType !== "space") return;
		if (payload.resourceAssignments) {
			for (const entry of payload.resourceAssignments) {
				const keys = new Set(
					entry.assignments.map((assignment) => assignment.labelSystemKey),
				);
				setViewerFlagsInCache(entry.resourceRef, {
					isPinned: keys.has("user:pinned"),
					isArchived: keys.has("user:archived"),
				});
			}
			invalidatePaletteOverview();
			return;
		}
		const resourceRefs = payload.resourceRefs?.length
			? payload.resourceRefs
			: payload.resourceRef
				? [payload.resourceRef]
				: [];
		for (const resourceRef of resourceRefs)
			void refreshPinnedState(resourceRef);
	});
}

async function refreshPinnedState(spaceId: string) {
	try {
		const result = await sdk.user.labels.getResourceLabels("space", spaceId);
		const isPinned = result.assignments.some(
			(a) => a.labelSystemKey === "user:pinned",
		);
		const isArchived = result.assignments.some(
			(a) => a.labelSystemKey === "user:archived",
		);
		setViewerFlagsInCache(spaceId, { isPinned, isArchived });
		invalidatePaletteOverview();
	} catch {
		// Non-critical: the next list refetch will reconcile.
	}
}

function setViewerFlagsInCache(
	spaceId: string,
	flags: { isPinned?: boolean; isArchived?: boolean },
) {
	patchCachedSpaceRecordSoon({ id: spaceId, ...flags });
}

export async function toggleSpaceArchive(spaceIds: string[], archive: boolean) {
	const previous = new Map<
		string,
		{ isArchived: boolean; isPinned: boolean }
	>();
	for (const id of spaceIds) {
		const cached = await getCachedSpaceRecord(id);
		previous.set(id, {
			isArchived: cached?.space.isArchived ?? false,
			isPinned: cached?.space.isPinned ?? false,
		});
		setViewerFlagsInCache(id, {
			isArchived: archive,
			...(archive ? { isPinned: false } : {}),
		});
	}
	invalidatePaletteOverview();
	try {
		await sdk.user.labels.patchResources(
			spaceIds,
			archive
				? { addLabelRefs: ["Archived"], removeLabelRefs: ["Pinned"] }
				: { removeLabelRefs: ["Archived"] },
		);
	} catch (error) {
		for (const [id, flags] of previous) setViewerFlagsInCache(id, flags);
		invalidatePaletteOverview();
		throw error;
	}
}
export async function toggleSpacePin(spaceId: string): Promise<void> {
	await authStore.ensureLoaded();
	const cached = await getCachedSpaceRecord(spaceId);
	const wasPinned = cached?.space.isPinned ?? false;

	// Optimistic update. The overview snapshot contains pin state too.
	setViewerFlagsInCache(spaceId, { isPinned: !wasPinned });
	invalidatePaletteOverview();

	try {
		await sdk.user.labels.patchResourceLabels(
			"space",
			spaceId,
			wasPinned
				? { removeLabelRefs: [PINNED_LABEL_REF] }
				: { addLabelRefs: [PINNED_LABEL_REF] },
		);
	} catch (error) {
		// Rollback on failure; keep the overview invalidated so the next read
		// reconciles against the server.
		setViewerFlagsInCache(spaceId, { isPinned: wasPinned });
		invalidatePaletteOverview();
		throw error;
	}
}
