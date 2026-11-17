import type { LabelResourceType } from "@neta-art/cohub";
import type { LabelAssignableCohubResource } from "#lib/drag/cohub-resource-drag.ts";
import {
	getLabelIdsByRefs,
	getLabelRefsFromAssignments,
	patchResourceLabels,
} from "#lib/stores/space-labels.ts";

export type ResourceLabelMutationResult = {
	changed: boolean;
	previousLabelRefs: string[];
	nextLabelRefs: string[];
	affectedLabelIds: string[];
};

function unique(values: string[]) {
	return Array.from(new Set(values.filter(Boolean)));
}

function emptyMutationResult(): ResourceLabelMutationResult {
	return {
		changed: false,
		previousLabelRefs: [],
		nextLabelRefs: [],
		affectedLabelIds: [],
	};
}

async function applyResourceLabelPatch(input: {
	spaceId: string;
	resource: LabelAssignableCohubResource;
	addLabelRefs?: string[];
	removeLabelRefs?: string[];
}): Promise<ResourceLabelMutationResult> {
	const addLabelRefs = unique(input.addLabelRefs ?? []);
	const removeLabelRefs = unique(input.removeLabelRefs ?? []);
	const affectedRefs = unique([...addLabelRefs, ...removeLabelRefs]);
	if (affectedRefs.length === 0) return emptyMutationResult();

	const result = await patchResourceLabels(
		input.spaceId,
		input.resource.type as LabelResourceType,
		input.resource.ref,
		{ addLabelRefs, removeLabelRefs },
	);
	const nextLabelRefs = getLabelRefsFromAssignments(
		result.labels,
		result.assignments,
	);
	return {
		changed: result.changed,
		previousLabelRefs: [],
		nextLabelRefs,
		affectedLabelIds: result.changed
			? getLabelIdsByRefs(result.labels, affectedRefs)
			: [],
	};
}

export async function addResourceToLabel(input: {
	spaceId: string;
	resource: LabelAssignableCohubResource;
	targetLabelRef: string;
}): Promise<ResourceLabelMutationResult> {
	return applyResourceLabelPatch({
		spaceId: input.spaceId,
		resource: input.resource,
		addLabelRefs: [input.targetLabelRef],
	});
}

export async function moveResourceToLabel(input: {
	spaceId: string;
	resource: LabelAssignableCohubResource;
	sourceLabelRef: string;
	targetLabelRef: string;
}): Promise<ResourceLabelMutationResult> {
	if (input.sourceLabelRef === input.targetLabelRef)
		return emptyMutationResult();
	return applyResourceLabelPatch({
		spaceId: input.spaceId,
		resource: input.resource,
		addLabelRefs: [input.targetLabelRef],
		removeLabelRefs: [input.sourceLabelRef],
	});
}

export async function removeResourceFromLabel(input: {
	spaceId: string;
	resource: LabelAssignableCohubResource;
	sourceLabelRef: string;
}): Promise<ResourceLabelMutationResult> {
	return applyResourceLabelPatch({
		spaceId: input.spaceId,
		resource: input.resource,
		removeLabelRefs: [input.sourceLabelRef],
	});
}
