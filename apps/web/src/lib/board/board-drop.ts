import type { BoardTaskSnapshot } from "@neta-art/cohub/board";
import type { BoardAppMetadata } from "@neta-art/cohub/board/editor";
import type { BoardDropItem } from "$lib/drag/pointer-drag-core";

export type BoardResourceDrop = {
	files: BoardDropItem[];
	tasks: Array<{ taskRunId: string; snapshot: BoardTaskSnapshot }>;
	apps: BoardAppMetadata[];
};

type DroppedResource = {
	type?: string;
	title?: string;
	path?: string;
	ref?: string;
	appId?: string;
	icon?: string;
	href?: string;
	mimeType?: string;
	size?: number;
	mtimeMs?: number;
	taskRunId?: string;
	snapshot?: BoardTaskSnapshot;
};

export function readBoardResourceDrop(
	data: Pick<DataTransfer, "getData"> | null | undefined,
): BoardResourceDrop {
	const drop: BoardResourceDrop = { files: [], tasks: [], apps: [] };
	const raw = data?.getData("application/x-cohub-resource");
	if (raw) {
		try {
			const payload = JSON.parse(raw) as { resources?: DroppedResource[] };
			for (const resource of payload.resources ?? []) {
				if (
					resource.type === "app" &&
					resource.appId &&
					resource.ref &&
					resource.href &&
					resource.title
				) {
					drop.apps.push({
						appId: resource.appId,
						ref: resource.ref,
						url: resource.href,
						name: resource.title,
						icon: resource.icon,
					});
					continue;
				}
				if (
					resource.type === "task" &&
					resource.taskRunId &&
					resource.snapshot
				) {
					drop.tasks.push({
						taskRunId: resource.taskRunId,
						snapshot: resource.snapshot,
					});
					continue;
				}
				if (resource.type && resource.type !== "file") continue;
				const path = (resource.path ?? resource.ref ?? "").replace(/\/$/, "");
				if (!path) continue;
				drop.files.push({
					path,
					snapshot: {
						title: resource.title,
						mimeType: resource.mimeType,
						size: resource.size,
						mtimeMs: resource.mtimeMs,
					},
				});
			}
		} catch {}
	}
	if (drop.files.length === 0 && drop.tasks.length === 0) {
		const path = data?.getData("text/cohub-path")?.replace(/\/$/, "");
		if (path && !path.startsWith("cohub://tasks/")) drop.files.push({ path });
	}
	return drop;
}
