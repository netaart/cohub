import type {
	LabelAssignmentListItem,
	LabelAssignmentRecord,
	LabelListItem,
	LabelResourceType,
} from "@neta-art/cohub";
import { resourceLabelsRepo } from "#lib/cache/repositories/resource-labels-repo.ts";
import {
	markLabelItemsStale,
	setCachedSpaceLabels,
} from "#lib/stores/space-labels.ts";

type ResourceLabelSnapshot = {
	spaceId: string;
	resourceType: LabelResourceType;
	resourceRef: string;
	labels: LabelListItem[];
	assignments: LabelAssignmentRecord[];
	items?: LabelAssignmentListItem[];
	affectedLabelIds?: string[];
};

function isLabelResourceType(value: unknown): value is LabelResourceType {
	return value === "session" || value === "checkpoint" || value === "file";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLabel(value: unknown): value is LabelListItem {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.name === "string"
	);
}

function isAssignment(value: unknown): value is LabelAssignmentRecord {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.labelId === "string" &&
		(value.rank === null || typeof value.rank === "number") &&
		isLabelResourceType(value.resourceType) &&
		typeof value.resourceRef === "string"
	);
}

function isLabelItem(value: unknown): value is LabelAssignmentListItem {
	if (!isRecord(value) || !isAssignment(value)) return false;
	return typeof (value as Record<string, unknown>).href === "string";
}

export async function syncResourceLabelsToCache(
	snapshot: ResourceLabelSnapshot,
) {
	await Promise.all([
		setCachedSpaceLabels(snapshot.spaceId, snapshot.labels),
		resourceLabelsRepo.set(
			snapshot.spaceId,
			snapshot.resourceType,
			snapshot.resourceRef,
			{ labels: snapshot.labels, assignments: snapshot.assignments },
			{ source: "network" },
		),
	]);
	const affectedLabelIds = Array.from(
		new Set([
			...(snapshot.affectedLabelIds ?? []),
			...snapshot.assignments.map((assignment) => assignment.labelId),
		]),
	);
	await Promise.all(
		affectedLabelIds.map((labelId) =>
			markLabelItemsStale(snapshot.spaceId, labelId).catch(() => undefined),
		),
	);
	if (typeof window !== "undefined") {
		window.dispatchEvent(
			new CustomEvent("cohub:label-assignments-updated", {
				detail: {
					spaceId: snapshot.spaceId,
					resourceType: snapshot.resourceType,
					resourceRef: snapshot.resourceRef,
					affectedLabelIds,
				},
			}),
		);
	}
}

export function parseResourceLabelRealtimePayload(input: {
	spaceId?: string | null;
	payload?: Record<string, unknown> | null;
}): ResourceLabelSnapshot | null {
	const payload = input.payload;
	const spaceId = input.spaceId?.trim();
	if (!payload) return null;
	const resourceType = payload?.resourceType;
	const resourceRef =
		typeof payload?.resourceRef === "string" ? payload.resourceRef.trim() : "";
	if (!spaceId || !isLabelResourceType(resourceType) || !resourceRef)
		return null;
	if (!Array.isArray(payload.labels) || !Array.isArray(payload.assignments)) {
		return null;
	}
	const labels = payload.labels.filter(isLabel);
	const assignments = payload.assignments.filter(isAssignment);
	if (
		labels.length !== payload.labels.length ||
		assignments.length !== payload.assignments.length
	) {
		return null;
	}
	const rawItems = payload.items;
	let items: LabelAssignmentListItem[] | undefined;
	if (Array.isArray(rawItems)) {
		items = rawItems.filter(isLabelItem);
		if (items.length !== rawItems.length) return null;
	}
	return {
		spaceId,
		resourceType,
		resourceRef,
		labels,
		assignments,
		items,
		affectedLabelIds: Array.isArray(payload.affectedLabelIds)
			? payload.affectedLabelIds.filter(
					(value): value is string =>
						typeof value === "string" && Boolean(value),
				)
			: undefined,
	};
}
