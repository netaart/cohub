import type {
	AppDropResource,
	AppDropResourceType,
} from "@cohub/protocol/app-runtime";
import {
	type CohubDragResource,
	getCohubResourceDragData,
} from "$lib/drag/cohub-resource-drag";
import type { PointerDragPayload } from "$lib/drag/pointer-drag-core";

/** Maps a host drag resource to what crosses into an App on drop. */
export function toAppDropResource(
	resource: CohubDragResource,
): AppDropResource | null {
	// Spaces are not droppable into an App.
	if (resource.type === "space") return null;
	return {
		type: resource.type,
		ref: resource.ref,
		...(resource.title ? { title: resource.title } : {}),
		...(resource.path ? { path: resource.path } : {}),
		...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
		...(typeof resource.size === "number" ? { size: resource.size } : {}),
		...(typeof resource.mtimeMs === "number"
			? { mtimeMs: resource.mtimeMs }
			: {}),
		...(resource.appId ? { appId: resource.appId } : {}),
		...(resource.href ? { href: resource.href } : {}),
		...(resource.taskRunId ? { taskRunId: resource.taskRunId } : {}),
		...(resource.snapshot
			? { snapshot: { ...(resource.snapshot as Record<string, unknown>) } }
			: {}),
	};
}

/** Resources of a host drag; a path-only (folder) drag has none. */
export function readTransferResources(
	dataTransfer: DataTransfer | null,
): AppDropResource[] | null {
	const resources = (getCohubResourceDragData(dataTransfer)?.resources ?? [])
		.map(toAppDropResource)
		.filter((resource): resource is AppDropResource => resource !== null);
	return resources.length > 0 ? resources : null;
}

/** Resources in a touch drag; folders have nothing an App could place. */
export function pointerDragResources(
	payload: PointerDragPayload,
): AppDropResource[] {
	const resources: AppDropResource[] = [];
	for (const item of payload.items) {
		if (item.type === "file") {
			resources.push({
				type: "file",
				ref: item.path,
				path: item.path,
				title: item.name,
				...(item.mimeType ? { mimeType: item.mimeType } : {}),
				...(typeof item.size === "number" ? { size: item.size } : {}),
				...(typeof item.mtimeMs === "number" ? { mtimeMs: item.mtimeMs } : {}),
			});
		} else if (item.type === "app" && item.appRef) {
			resources.push({
				type: "app",
				ref: item.appRef,
				title: item.name,
				...(item.appId ? { appId: item.appId } : {}),
				...(item.appUrl ? { href: item.appUrl } : {}),
			});
		}
	}
	return resources;
}

export function dropTypesOf(
	resources: readonly AppDropResource[],
): AppDropResourceType[] {
	return [...new Set(resources.map((resource) => resource.type))];
}

class HostResourceDrag {
	/** Resources of the native drag the host started, while it is live. */
	resources = $state.raw<AppDropResource[] | null>(null);
}

export const hostResourceDrag = new HostResourceDrag();

let tracking = false;

/** Tracks host drags, since an App frame swallows drag events. */
export function trackHostResourceDrags() {
	if (tracking || typeof window === "undefined") return;
	tracking = true;
	// Bubble phase: the source's own dragstart has already written its data.
	window.addEventListener("dragstart", (event) => {
		hostResourceDrag.resources = readTransferResources(event.dataTransfer);
	});
	const clear = () => {
		hostResourceDrag.resources = null;
	};
	window.addEventListener("dragend", clear, true);
	// Bubble phase, so a drop target still sees the drag it is handling.
	window.addEventListener("drop", clear);
	// A detached source never delivers `dragend`; the next pointer event ends the drag.
	const clearStale = () => {
		if (hostResourceDrag.resources) clear();
	};
	window.addEventListener("pointermove", clearStale, { passive: true });
	window.addEventListener("pointerdown", clearStale, { passive: true });
}
