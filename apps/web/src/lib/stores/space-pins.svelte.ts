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
const ARCHIVED_LABEL_REF = "Archived";

export type ViewerFlags = { isPinned?: boolean; isArchived?: boolean };
type LabelPatch = { addLabelRefs?: string[]; removeLabelRefs?: string[] };

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

function setViewerFlagsInCache(spaceId: string, flags: ViewerFlags) {
	patchCachedSpaceRecordSoon({ id: spaceId, ...flags });
}

export function pinFlags(pinned: boolean): ViewerFlags {
	return pinned ? { isPinned: true, isArchived: false } : { isPinned: false };
}

export function archiveFlags(archived: boolean): ViewerFlags {
	return archived
		? { isArchived: true, isPinned: false }
		: { isArchived: false };
}

async function patchSpaceFlags(
	spaceIds: string[],
	flags: ViewerFlags,
	patch: LabelPatch,
) {
	const cached = await Promise.all(
		spaceIds.map((id) => getCachedSpaceRecord(id)),
	);
	const previous = spaceIds.map((id, index) => {
		const space = cached[index]?.space;
		setViewerFlagsInCache(id, flags);
		return [
			id,
			{
				isPinned: space?.isPinned ?? false,
				isArchived: space?.isArchived ?? false,
			},
		] as const;
	});
	invalidatePaletteOverview();
	try {
		await sdk.user.labels.patchResources(spaceIds, patch);
	} catch (error) {
		for (const [id, before] of previous) setViewerFlagsInCache(id, before);
		invalidatePaletteOverview();
		throw error;
	}
}

export function setSpacesPinned(spaceIds: string[], pinned: boolean) {
	return patchSpaceFlags(
		spaceIds,
		pinFlags(pinned),
		pinned
			? {
					addLabelRefs: [PINNED_LABEL_REF],
					removeLabelRefs: [ARCHIVED_LABEL_REF],
				}
			: { removeLabelRefs: [PINNED_LABEL_REF] },
	);
}

export function setSpacesArchived(spaceIds: string[], archived: boolean) {
	return patchSpaceFlags(
		spaceIds,
		archiveFlags(archived),
		archived
			? {
					addLabelRefs: [ARCHIVED_LABEL_REF],
					removeLabelRefs: [PINNED_LABEL_REF],
				}
			: { removeLabelRefs: [ARCHIVED_LABEL_REF] },
	);
}

export async function toggleSpacePin(spaceId: string): Promise<void> {
	await authStore.ensureLoaded();
	const cached = await getCachedSpaceRecord(spaceId);
	await setSpacesPinned([spaceId], !(cached?.space.isPinned ?? false));
}
