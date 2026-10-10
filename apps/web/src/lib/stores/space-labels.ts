import type {
	LabelAssignmentListItem,
	LabelAssignmentRecord,
	LabelItemsResponse,
	LabelListItem,
	LabelResourceType,
	SessionRecord,
} from "@neta-art/cohub";
import { canUseUserScopedCache, getCacheUserKeyAsync } from "$lib/cache/keys";
import { labelItemsRepo } from "$lib/cache/repositories/label-items-repo";
import { labelTreeRepo } from "$lib/cache/repositories/label-tree-repo";
import { resourceLabelsRepo } from "$lib/cache/repositories/resource-labels-repo";
import { userProfilesRepo } from "$lib/cache/repositories/user-profiles-repo";
import { sdk } from "$lib/sdk";
import {
	formatChannelLabelName,
	getChannelLabelInfo,
	hydrateChannelLabels,
	onChannelLabelDisplayUpdated,
} from "$lib/stores/channel-label-display";
import { sessionStore } from "$lib/stores/session-store";

const LABEL_ITEMS_PAGE_SIZE = 30;
const SESSION_USER_LABEL_SYSTEM_KEY_PREFIX = "session-user:";
const SESSION_CHANNEL_LABEL_SYSTEM_KEY_PREFIX = "session-channel:";
function fallbackUserName(userUuid: string) {
	return userUuid.replaceAll("-", "").slice(0, 8) || "User";
}

export function getSessionUserUuidFromLabel(label: LabelListItem) {
	const systemKey = label.systemKey?.trim() ?? "";
	if (systemKey.startsWith(SESSION_USER_LABEL_SYSTEM_KEY_PREFIX)) {
		const userUuid = systemKey
			.slice(SESSION_USER_LABEL_SYSTEM_KEY_PREFIX.length)
			.trim();
		return userUuid && userUuid !== "root" ? userUuid : null;
	}
	return null;
}

export function getSessionChannelIdFromLabel(label: LabelListItem) {
	const systemKey = label.systemKey?.trim() ?? "";
	if (systemKey.startsWith(SESSION_CHANNEL_LABEL_SYSTEM_KEY_PREFIX)) {
		const channelId = systemKey
			.slice(SESSION_CHANNEL_LABEL_SYSTEM_KEY_PREFIX.length)
			.trim();
		return channelId && channelId !== "root" ? channelId : null;
	}
	return null;
}

export function isSessionUserLabel(label: LabelListItem) {
	return Boolean(getSessionUserUuidFromLabel(label));
}

export function isSessionChannelLabel(label: LabelListItem) {
	return Boolean(getSessionChannelIdFromLabel(label));
}

export function getLabelDisplayName(
	label: LabelListItem,
	options?: { channelIncludeProvider?: boolean },
) {
	if (label.systemKey === `${SESSION_USER_LABEL_SYSTEM_KEY_PREFIX}root`)
		return "User";
	if (label.systemKey === `${SESSION_CHANNEL_LABEL_SYSTEM_KEY_PREFIX}root`)
		return "Channel";
	const userUuid = getSessionUserUuidFromLabel(label);
	if (userUuid) {
		return (
			userProfilesRepo.getSync(userUuid)?.displayName?.trim() ||
			fallbackUserName(userUuid)
		);
	}
	const channelId = getSessionChannelIdFromLabel(label);
	if (channelId) {
		return formatChannelLabelName(getChannelLabelInfo(channelId), channelId, {
			includeProvider: options?.channelIncludeProvider,
		});
	}
	return label.name;
}

export function getLabelChannelInfo(label: LabelListItem) {
	const channelId = getSessionChannelIdFromLabel(label);
	return channelId ? getChannelLabelInfo(channelId) : null;
}

export function getLabelDisplayTitle(label: LabelListItem) {
	if (label.systemKey === `${SESSION_USER_LABEL_SYSTEM_KEY_PREFIX}root`)
		return label.name === "User" ? "User" : `${label.name} · User`;
	if (label.systemKey === `${SESSION_CHANNEL_LABEL_SYSTEM_KEY_PREFIX}root`)
		return label.name === "Channel" ? "Channel" : `${label.name} · Channel`;
	const userUuid = getSessionUserUuidFromLabel(label);
	if (userUuid) {
		const profile = userProfilesRepo.getSync(userUuid);
		return [
			profile?.displayName?.trim() || fallbackUserName(userUuid),
			profile?.username ? `@${profile.username}` : null,
			userUuid,
		]
			.filter(Boolean)
			.join(" · ");
	}
	const channelId = getSessionChannelIdFromLabel(label);
	if (channelId) {
		const info = getChannelLabelInfo(channelId);
		return `${formatChannelLabelName(info, channelId)} · ${channelId}`;
	}
	return label.name;
}

export function getLabelUserProfile(label: LabelListItem) {
	const userUuid = getSessionUserUuidFromLabel(label);
	return userUuid ? userProfilesRepo.getSync(userUuid) : null;
}

export function onUserLabelProfilesUpdated(handler: () => void) {
	return userProfilesRepo.subscribe(() => handler());
}

export function onChannelLabelDisplayNamesUpdated(handler: () => void) {
	return onChannelLabelDisplayUpdated(handler);
}

function collectSessionUserUuids(labels: LabelListItem[]) {
	const userUuids = new Set<string>();
	const visit = (items: LabelListItem[]) => {
		for (const label of items) {
			const userUuid = getSessionUserUuidFromLabel(label);
			if (userUuid) userUuids.add(userUuid);
			if (label.children?.length) visit(label.children);
		}
	};
	visit(labels);
	return [...userUuids];
}

function collectSessionChannelIds(labels: LabelListItem[]) {
	const channelIds = new Set<string>();
	const visit = (items: LabelListItem[]) => {
		for (const label of items) {
			const channelId = getSessionChannelIdFromLabel(label);
			if (channelId) channelIds.add(channelId);
			if (label.children?.length) visit(label.children);
		}
	};
	visit(labels);
	return [...channelIds];
}

export async function hydrateUserProfilesForLabels(labels: LabelListItem[]) {
	await userProfilesRepo.hydrate(collectSessionUserUuids(labels));
}

export async function hydrateChannelLabelsForLabels(
	spaceId: string,
	labels: LabelListItem[],
) {
	await hydrateChannelLabels(spaceId, collectSessionChannelIds(labels));
}

function queueHydrateSystemLabelDisplays(
	spaceId: string,
	labels: LabelListItem[],
) {
	void hydrateUserProfilesForLabels(labels).catch(() => undefined);
	void hydrateChannelLabelsForLabels(spaceId, labels).catch(() => undefined);
}

async function resolveCacheUserKey() {
	const userKey = await getCacheUserKeyAsync();
	return canUseUserScopedCache(userKey) ? userKey : null;
}

export async function getCachedSpaceLabelsSnapshot(spaceId: string) {
	if (!(await resolveCacheUserKey())) return null;
	return labelTreeRepo.get(spaceId).catch((error) => {
		console.warn("[space-labels] Failed to read cached labels", {
			spaceId,
			error,
		});
		return null;
	});
}

export async function getCachedSpaceLabels(spaceId: string) {
	const labels = (await getCachedSpaceLabelsSnapshot(spaceId))?.labels ?? null;
	if (labels) queueHydrateSystemLabelDisplays(spaceId, labels);
	return labels;
}

export async function setCachedSpaceLabels(
	spaceId: string,
	labels: LabelListItem[],
) {
	queueHydrateSystemLabelDisplays(spaceId, labels);
	if (!(await resolveCacheUserKey())) return labels;
	return (await labelTreeRepo.set(spaceId, labels)).labels;
}

export function onSpaceLabelsCacheUpdated(
	handler: (event: { spaceId: string; labels: LabelListItem[] }) => void,
) {
	if (typeof window === "undefined") return () => {};
	const listener = (event: Event) => {
		const custom = event as CustomEvent<{
			spaceId: string;
			labels: LabelListItem[];
		}>;
		if (!custom.detail?.spaceId || !Array.isArray(custom.detail.labels)) return;
		handler(custom.detail);
	};
	window.addEventListener("cohub:space-labels-updated", listener);
	return () =>
		window.removeEventListener("cohub:space-labels-updated", listener);
}

export async function fetchSpaceLabelsFresh(spaceId: string) {
	// Auth hydrate for token readiness; cache identity is optional.
	await getCacheUserKeyAsync();
	const labels = (await sdk.space(spaceId).labels.list()).labels ?? [];
	queueHydrateSystemLabelDisplays(spaceId, labels);
	if (!(await resolveCacheUserKey())) return labels;
	try {
		return (await labelTreeRepo.set(spaceId, labels, { source: "network" }))
			.labels;
	} catch (error) {
		console.warn("[space-labels] Failed to cache labels", { spaceId, error });
		return labels;
	}
}

export async function fetchSpaceLabels(spaceId: string, force = false) {
	if (!force) {
		const cached = await getCachedSpaceLabelsSnapshot(spaceId);
		if (cached && !cached.stale) {
			queueHydrateSystemLabelDisplays(spaceId, cached.labels);
			return cached.labels;
		}
	}
	return fetchSpaceLabelsFresh(spaceId);
}

export type LabelWithRef = LabelListItem & { ref: string };

export function flattenLabelsWithRefs(labels: LabelListItem[]) {
	const result: LabelWithRef[] = [];
	const visit = (items: LabelListItem[], parentRef = "") => {
		for (const label of items) {
			const ref = parentRef ? `${parentRef}/${label.name}` : label.name;
			result.push({ ...label, ref });
			if (label.children?.length) visit(label.children, ref);
		}
	};
	visit(labels);
	return result;
}

export async function getLabelRefById(spaceId: string, labelId: string) {
	const labels = await fetchSpaceLabels(spaceId);
	return (
		flattenLabelsWithRefs(labels).find((label) => label.id === labelId)?.ref ??
		null
	);
}

export async function getLabelByRef(spaceId: string, labelRef: string) {
	const labels = await fetchSpaceLabels(spaceId);
	return (
		flattenLabelsWithRefs(labels).find((label) => label.ref === labelRef) ??
		null
	);
}

export function getLabelRefsFromAssignments(
	labels: LabelListItem[],
	assignments: LabelAssignmentRecord[],
) {
	const refsById = new Map(
		flattenLabelsWithRefs(labels).map((label) => [label.id, label.ref]),
	);
	return assignments
		.map((assignment) => refsById.get(assignment.labelId))
		.filter((ref): ref is string => Boolean(ref));
}

export function getLabelIdsByRefs(labels: LabelListItem[], refs: string[]) {
	const idsByRef = new Map(
		flattenLabelsWithRefs(labels).map((label) => [label.ref, label.id]),
	);
	return refs
		.map((ref) => idsByRef.get(ref))
		.filter((id): id is string => Boolean(id));
}

export function flattenLabels(labels: LabelListItem[]) {
	const result: LabelListItem[] = [];
	const visit = (items: LabelListItem[]) => {
		for (const label of items) {
			result.push(label);
			if (label.children?.length) visit(label.children);
		}
	};
	visit(labels);
	return result;
}

export async function createSpaceLabel(spaceId: string, labelRef: string) {
	const result = await sdk.space(spaceId).labels.create(labelRef);
	await fetchSpaceLabelsFresh(spaceId);
	return result.labels[0] ?? null;
}

export async function deleteSpaceLabel(spaceId: string, labelRef: string) {
	const label = await getLabelByRef(spaceId, labelRef);
	await sdk.space(spaceId).labels.delete(labelRef);
	const labels = await fetchSpaceLabelsFresh(spaceId);
	if (label)
		await labelItemsRepo
			.deleteFirstPage(spaceId, label.id)
			.catch(() => undefined);
	return labels;
}

export async function getCachedResourceLabelsSnapshot(
	spaceId: string,
	resourceType: LabelResourceType,
	resourceRef: string,
) {
	if (!(await resolveCacheUserKey())) return null;
	return resourceLabelsRepo.get(spaceId, resourceType, resourceRef);
}

export async function getResourceLabels(
	spaceId: string,
	resourceType: LabelResourceType,
	resourceRef: string,
) {
	await getCacheUserKeyAsync();
	const result = await sdk
		.space(spaceId)
		.labels.getResourceLabels(resourceType, resourceRef);
	queueHydrateSystemLabelDisplays(spaceId, result.labels);
	if (await resolveCacheUserKey()) {
		await Promise.all([
			labelTreeRepo.set(spaceId, result.labels, { source: "network" }),
			resourceLabelsRepo.set(spaceId, resourceType, resourceRef, result, {
				source: "network",
			}),
		]).catch((error) => {
			console.warn("[space-labels] Failed to cache resource labels", {
				spaceId,
				error,
			});
		});
	}
	return result;
}

export async function fetchResourceLabelsFresh(
	spaceId: string,
	resourceType: LabelResourceType,
	resourceRef: string,
) {
	return getResourceLabels(spaceId, resourceType, resourceRef);
}

export async function fetchResourceLabels(
	spaceId: string,
	resourceType: LabelResourceType,
	resourceRef: string,
	force = false,
) {
	if (!force) {
		const cached = await getCachedResourceLabelsSnapshot(
			spaceId,
			resourceType,
			resourceRef,
		);
		if (cached && !cached.stale) {
			queueHydrateSystemLabelDisplays(spaceId, cached.labels);
			return {
				labels: cached.labels,
				assignments: cached.assignments,
				fromCache: true,
			} as const;
		}
	}
	return getResourceLabels(spaceId, resourceType, resourceRef).then(
		(result) => ({ ...result, fromCache: false }) as const,
	);
}

function sessionRefs(items: readonly LabelAssignmentListItem[]) {
	return items.flatMap((item) =>
		item.resourceType === "session" ? [item.resourceRef] : [],
	);
}

function storedSessions(refs: readonly string[]) {
	return refs.flatMap((ref) => {
		const session = sessionStore.get(ref);
		return session ? [session] : [];
	});
}

export async function getCachedLabelItemsSnapshot(
	spaceId: string,
	labelId: string,
) {
	const snapshot = await labelItemsRepo.getFirstPage(spaceId, labelId);
	if (!snapshot) return null;
	sessionStore.seedAll(snapshot.sessions);
	const refs = sessionRefs(snapshot.items);
	await sessionStore.hydrate(spaceId, refs);
	return { ...snapshot, sessions: storedSessions(refs) };
}

export async function fetchLabelItemsFirstPageFresh(
	spaceId: string,
	labelId: string,
	labelRef?: string,
) {
	const ref = labelRef ?? (await getLabelRefById(spaceId, labelId));
	if (!ref)
		return {
			items: [] as LabelAssignmentListItem[],
			pageInfo: { hasMore: false, nextCursor: null },
			sessions: [] as SessionRecord[],
			forks: [] as NonNullable<LabelItemsResponse["forks"]>,
		};
	const result = await sdk.space(spaceId).labels.listItems(ref, {
		limit: LABEL_ITEMS_PAGE_SIZE,
		cursor: null,
	});
	const page = {
		items: result.items ?? [],
		pageInfo: result.pageInfo,
		sessions: sessionStore.mergeAll(result.sessions ?? []),
		forks: result.forks ?? [],
	};
	// Always return network data first. Cache is best-effort and must not keep the
	// sidebar on Loading… after labels/items already returned 200.
	if (await resolveCacheUserKey()) {
		void labelItemsRepo
			.setFirstPage(
				spaceId,
				labelId,
				{ ...page, sessions: [] },
				{ source: "network" },
			)
			.catch((error) => {
				console.warn("[space-labels] Failed to cache label items", {
					spaceId,
					labelId,
					error,
				});
			});
	}
	return page;
}

export async function markLabelItemsStale(spaceId: string, labelId: string) {
	if (!(await resolveCacheUserKey())) return;
	return labelItemsRepo.markStale(spaceId, labelId);
}

async function cacheResourceLabelMutation(input: {
	spaceId: string;
	resourceType: LabelResourceType;
	resourceRef: string;
	result: { labels: LabelListItem[]; assignments: LabelAssignmentRecord[] };
	affectedRefs: string[];
}) {
	queueHydrateSystemLabelDisplays(input.spaceId, input.result.labels);
	if (!(await resolveCacheUserKey())) return;
	await Promise.all([
		labelTreeRepo.set(input.spaceId, input.result.labels, {
			source: "network",
		}),
		resourceLabelsRepo.set(
			input.spaceId,
			input.resourceType,
			input.resourceRef,
			input.result,
			{ source: "network" },
		),
	]);

	const affectedLabelIds = getLabelIdsByRefs(
		input.result.labels,
		input.affectedRefs,
	);
	await Promise.all(
		affectedLabelIds.map((labelId) =>
			markLabelItemsStale(input.spaceId, labelId),
		),
	).catch(() => undefined);

	if (typeof window !== "undefined") {
		window.dispatchEvent(
			new CustomEvent("cohub:label-assignments-updated", {
				detail: {
					spaceId: input.spaceId,
					resourceType: input.resourceType,
					resourceRef: input.resourceRef,
					affectedLabelIds,
				},
			}),
		);
	}
}

export async function patchResourceLabels(
	spaceId: string,
	resourceType: LabelResourceType,
	resourceRef: string,
	input: { addLabelRefs?: string[]; removeLabelRefs?: string[] },
): Promise<{
	labels: LabelListItem[];
	assignments: LabelAssignmentRecord[];
	changed: boolean;
}> {
	const result = await sdk
		.space(spaceId)
		.labels.patchResourceLabels(resourceType, resourceRef, input);
	await cacheResourceLabelMutation({
		spaceId,
		resourceType,
		resourceRef,
		result,
		affectedRefs: result.changed
			? [...(input.addLabelRefs ?? []), ...(input.removeLabelRefs ?? [])]
			: [],
	});
	return result;
}

export async function setResourceLabels(
	spaceId: string,
	resourceType: LabelResourceType,
	resourceRef: string,
	labelRefs: string[],
	options?: { previousLabelRefs?: string[] },
): Promise<{ labels: LabelListItem[]; assignments: LabelAssignmentRecord[] }> {
	const previousLabelRefs =
		options?.previousLabelRefs ??
		(await getResourceLabels(spaceId, resourceType, resourceRef)
			.then((result) =>
				getLabelRefsFromAssignments(result.labels, result.assignments),
			)
			.catch(() => undefined));
	const result = await sdk
		.space(spaceId)
		.labels.setResourceLabels(resourceType, resourceRef, labelRefs);
	await cacheResourceLabelMutation({
		spaceId,
		resourceType,
		resourceRef,
		result,
		affectedRefs: previousLabelRefs
			? Array.from(new Set([...previousLabelRefs, ...labelRefs]))
			: labelRefs,
	});
	return result;
}

export { LABEL_ITEMS_PAGE_SIZE };
