import {
	type LabelAssignmentListItem,
	type LabelListItem,
	SESSION_ARCHIVED_LABEL_SYSTEM_KEY,
	type SessionRecord,
} from "@neta-art/cohub";
import { buildSpaceSessionRoute } from "$lib/space-routes";

export const ALL_CHATS_LABEL_ID = "__all_chats__";
export const SESSION_SOURCE_LABEL_SYSTEM_KEY_PREFIX = "session-source:";
export const SESSION_USER_LABEL_SYSTEM_KEY_PREFIX = "session-user:";
export const SESSION_CHANNEL_LABEL_SYSTEM_KEY_PREFIX = "session-channel:";
export const SESSION_USER_ROOT_LABEL_SYSTEM_KEY = `${SESSION_USER_LABEL_SYSTEM_KEY_PREFIX}root`;
export const SESSION_CHANNEL_ROOT_LABEL_SYSTEM_KEY = `${SESSION_CHANNEL_LABEL_SYSTEM_KEY_PREFIX}root`;
export const WEB_APP_SOURCE_LABEL_SYSTEM_KEY = `${SESSION_SOURCE_LABEL_SYSTEM_KEY_PREFIX}web`;

export function isWebAppSourceLabel(label: LabelListItem) {
	return (
		label.systemKey === WEB_APP_SOURCE_LABEL_SYSTEM_KEY ||
		label.name === "Web App"
	);
}

export function compareSourceLabels(a: LabelListItem, b: LabelListItem) {
	const aWeb = isWebAppSourceLabel(a);
	const bWeb = isWebAppSourceLabel(b);
	if (aWeb !== bWeb) return aWeb ? -1 : 1;
	if (a.rank !== b.rank) return a.rank - b.rank;
	return a.name.localeCompare(b.name);
}

export function findSourceRootLabel(labels: LabelListItem[]) {
	return (
		labels.find(
			(label) =>
				label.source === "system" &&
				label.parentId === null &&
				label.name.toLowerCase() === "source",
		) ?? null
	);
}

export function getSourceLabels(labels: LabelListItem[]) {
	return (findSourceRootLabel(labels)?.children ?? [])
		.slice()
		.sort(compareSourceLabels);
}

export function findSessionUserRootLabel(labels: LabelListItem[]) {
	return (
		labels.find(
			(label) =>
				label.source === "system" &&
				label.parentId === null &&
				label.systemKey === SESSION_USER_ROOT_LABEL_SYSTEM_KEY,
		) ?? null
	);
}

export function getSessionUserLabelSystemKey(userUuid: string) {
	return `${SESSION_USER_LABEL_SYSTEM_KEY_PREFIX}${userUuid}`;
}

export function findSessionUserLabel(
	labels: LabelListItem[],
	userUuid: string | null | undefined,
) {
	const normalized = userUuid?.trim();
	if (!normalized) return null;
	const systemKey = getSessionUserLabelSystemKey(normalized);
	const root = findSessionUserRootLabel(labels);
	return (
		(root?.children ?? []).find(
			(label) => label.source === "system" && label.systemKey === systemKey,
		) ?? null
	);
}

export function getSystemUserLabels(labels: LabelListItem[]) {
	const userRootLabel = findSessionUserRootLabel(labels);
	return userRootLabel ? [userRootLabel] : [];
}

export function findSessionChannelRootLabel(labels: LabelListItem[]) {
	return (
		labels.find(
			(label) =>
				label.source === "system" &&
				label.parentId === null &&
				label.systemKey === SESSION_CHANNEL_ROOT_LABEL_SYSTEM_KEY,
		) ?? null
	);
}

export function getSystemChannelLabels(labels: LabelListItem[]) {
	const channelRootLabel = findSessionChannelRootLabel(labels);
	return channelRootLabel ? [channelRootLabel] : [];
}

export function isArchivedLabel(label: LabelListItem) {
	return label.systemKey === SESSION_ARCHIVED_LABEL_SYSTEM_KEY;
}

export function getArchivedLabels(labels: LabelListItem[]) {
	return labels.filter(
		(label) => label.parentId === null && isArchivedLabel(label),
	);
}

export function showsSessionInLabel(
	label: LabelListItem,
	session: Pick<SessionRecord, "archivedAt">,
) {
	if (label.source !== "system") return true;
	return Boolean(session.archivedAt) === isArchivedLabel(label);
}

export function getDisplayLabels(labels: LabelListItem[]) {
	return labels.filter((label) => !isSystemLabel(label, labels));
}

// `legacy:pinned` belongs to migrated user labels; only active session keys
// provide a system-ownership fallback when historical source data is incorrect.
function hasSessionSystemKey(label: LabelListItem) {
	const systemKey = label.systemKey?.trim();
	return Boolean(
		systemKey &&
			[
				SESSION_SOURCE_LABEL_SYSTEM_KEY_PREFIX,
				SESSION_USER_LABEL_SYSTEM_KEY_PREFIX,
				SESSION_CHANNEL_LABEL_SYSTEM_KEY_PREFIX,
				SESSION_ARCHIVED_LABEL_SYSTEM_KEY,
			].some((prefix) => systemKey.startsWith(prefix)),
	);
}

export function isSystemLabel(
	label: LabelListItem,
	allLabels: LabelListItem[] = [],
): boolean {
	if (label.source === "system" || hasSessionSystemKey(label)) return true;
	if (label.source !== "user") return true;
	if (label.parentId && allLabels.length > 0) {
		const parent = allLabels.find((l) => l.id === label.parentId);
		if (parent && isSystemLabel(parent, allLabels)) return true;
	}
	return false;
}

export function findWebAppSourceLabel(labels: LabelListItem[]) {
	return (
		getSourceLabels(labels).find((label) => isWebAppSourceLabel(label)) ?? null
	);
}

export function findDefaultExpandedLabelId(_labels: LabelListItem[]) {
	return ALL_CHATS_LABEL_ID;
}

export function isWebSessionSource(session: SessionRecord) {
	const source =
		session.source
			?.trim()
			.toLowerCase()
			.replace(/[\s-]+/g, "_") ?? "web";
	return source === "web" || source === "web_app";
}

export function buildOptimisticWebAppLabelSessionItem(input: {
	spaceId: string;
	labelId: string;
	session: SessionRecord;
}): LabelAssignmentListItem {
	const { spaceId, labelId, session } = input;
	const now = new Date().toISOString();
	return {
		id: `optimistic:${labelId}:${session.id}`,
		labelId,
		scopeType: "space",
		scopeId: spaceId,
		resourceType: "session",
		resourceRef: session.id,
		rank: null,
		source: "system",
		createdBy: null,
		meta: null,
		createdAt: session.createdAt ?? now,
		updatedAt: session.updatedAt ?? now,
		href: buildSpaceSessionRoute(spaceId, session.id),
		resource: {
			title: session.title ?? session.latestMessageText ?? "New chat",
			subtitle:
				session.lastMessageAt ?? session.updatedAt ?? session.createdAt ?? null,
			status: session.status ?? null,
		},
	};
}
