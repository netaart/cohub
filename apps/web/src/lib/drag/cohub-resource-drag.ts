import type { LabelResourceType } from "@neta-art/cohub";
import type { BoardTaskSnapshot } from "@neta-art/cohub/board";

export const COHUB_RESOURCE_MIME = "application/x-cohub-resource";
export const COHUB_PATH_MIME = "text/cohub-path";

export type CohubResourceType = LabelResourceType | "task" | "app";

export type CohubDragResource = {
	type: CohubResourceType;
	ref: string;
	title?: string;
	subtitle?: string | null;
	href?: string;
	appId?: string;
	path?: string;
	mimeType?: string | null;
	size?: number;
	mtimeMs?: number;
	taskRunId?: string;
	snapshot?: BoardTaskSnapshot;
};

export type CohubDragOrigin =
	| { kind: "sidebar-session-list" }
	| { kind: "space-file-tree" }
	| { kind: "task-list" }
	| { kind: "side-panel" }
	| { kind: "label-items"; labelRef: string; labelName?: string };

export type CohubResourceDragPayload = {
	version: 1;
	resources: CohubDragResource[];
	origin?: CohubDragOrigin;
	createdAt?: number;
};

export type LabelAssignableCohubResource = CohubDragResource & {
	type: "session" | "checkpoint" | "file";
	ref: string;
};

function normalizeResource(
	resource: CohubDragResource,
): CohubDragResource | null {
	if (!resource || typeof resource !== "object") return null;
	if (
		resource.type !== "session" &&
		resource.type !== "file" &&
		resource.type !== "checkpoint" &&
		resource.type !== "task" &&
		resource.type !== "app"
	)
		return null;
	if (typeof resource.ref !== "string" || !resource.ref.trim()) return null;
	if (
		resource.type === "task" &&
		(typeof resource.taskRunId !== "string" || !resource.snapshot)
	)
		return null;
	return {
		...resource,
		ref: resource.ref.trim(),
	};
}

function normalizeOrigin(origin: unknown): CohubDragOrigin | undefined {
	if (!origin || typeof origin !== "object") return undefined;
	const value = origin as Partial<CohubDragOrigin>;
	if (
		value.kind === "sidebar-session-list" ||
		value.kind === "space-file-tree" ||
		value.kind === "task-list" ||
		value.kind === "side-panel"
	) {
		return { kind: value.kind };
	}
	if (value.kind === "label-items") {
		const labelRef = "labelRef" in value ? value.labelRef : undefined;
		if (typeof labelRef !== "string" || !labelRef.trim()) return undefined;
		const labelName = "labelName" in value ? value.labelName : undefined;
		return {
			kind: "label-items",
			labelRef: labelRef.trim(),
			labelName: typeof labelName === "string" ? labelName : undefined,
		};
	}
	return undefined;
}

export function normalizeCohubResourceDragPayload(
	value: unknown,
): CohubResourceDragPayload | null {
	if (!value || typeof value !== "object") return null;
	const payload = value as Partial<CohubResourceDragPayload>;
	if (payload.version !== 1 || !Array.isArray(payload.resources)) return null;
	const resources = payload.resources
		.map((resource) => normalizeResource(resource))
		.filter((resource): resource is CohubDragResource => Boolean(resource));
	if (resources.length === 0) return null;
	return {
		version: 1,
		resources,
		origin: normalizeOrigin(payload.origin),
		createdAt:
			typeof payload.createdAt === "number" ? payload.createdAt : undefined,
	};
}

export function setCohubResourceDragData(
	dataTransfer: DataTransfer | null,
	payload: CohubResourceDragPayload,
	options?: {
		cohubPath?: string;
		plainText?: string;
		effectAllowed?: DataTransfer["effectAllowed"];
	},
) {
	if (!dataTransfer) return;
	dataTransfer.setData(COHUB_RESOURCE_MIME, JSON.stringify(payload));
	if (options?.cohubPath)
		dataTransfer.setData(COHUB_PATH_MIME, options.cohubPath);
	if (options?.plainText) dataTransfer.setData("text/plain", options.plainText);
	if (options?.effectAllowed)
		dataTransfer.effectAllowed = options.effectAllowed;
}

export function getCohubResourceDragData(
	dataTransfer: DataTransfer | null,
): CohubResourceDragPayload | null {
	if (!dataTransfer) return null;
	const raw = dataTransfer.getData(COHUB_RESOURCE_MIME);
	if (!raw) return null;
	try {
		return normalizeCohubResourceDragPayload(JSON.parse(raw));
	} catch {
		return null;
	}
}

export function hasCohubResourceDragData(dataTransfer: DataTransfer | null) {
	return Boolean(dataTransfer?.types.includes(COHUB_RESOURCE_MIME));
}

export function getFirstCohubResource(
	payload: CohubResourceDragPayload | null,
) {
	return payload?.resources[0] ?? null;
}

export function isLabelAssignableResource(
	resource: CohubDragResource | null,
): resource is LabelAssignableCohubResource {
	return Boolean(
		resource &&
			(resource.type === "session" ||
				resource.type === "checkpoint" ||
				resource.type === "file") &&
			resource.ref.trim(),
	);
}
