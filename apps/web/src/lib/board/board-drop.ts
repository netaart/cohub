import type { BoardTaskSnapshot } from "@neta-art/cohub/board";
import {
	normalizeBoardRemoteUrl,
	parseBoardMediaSource,
} from "@neta-art/cohub/board";
import type { BoardAppMetadata } from "@neta-art/cohub/board/editor";
import { boardAppFace } from "$lib/board/board-app";
import {
	type BoardDropItem,
	type PointerDragPayload,
	toBoardDropItems,
} from "$lib/drag/pointer-drag-core";

export type BoardResourceDrop = {
	files: BoardDropItem[];
	tasks: Array<{ taskRunId: string; snapshot: BoardTaskSnapshot }>;
	sessions: Array<{ sessionId: string; title?: string }>;
	apps: BoardAppMetadata[];
	urls: string[];
};

type DroppedResource = {
	type?: string;
	title?: string;
	path?: string;
	ref?: string;
	appId?: string;
	icon?: string;
	cover?: string;
	themeColor?: string;
	href?: string;
	url?: string;
	mimeType?: string;
	size?: number;
	mtimeMs?: number;
	taskRunId?: string;
	snapshot?: BoardTaskSnapshot;
};

export function readBoardResourceDrop(
	data: Pick<DataTransfer, "getData"> | null | undefined,
): BoardResourceDrop {
	const drop: BoardResourceDrop = {
		files: [],
		tasks: [],
		sessions: [],
		apps: [],
		urls: [],
	};
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
						...boardAppFace(resource),
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
				if (resource.type === "session" && resource.ref) {
					drop.sessions.push({
						sessionId: resource.ref,
						title: resource.title,
					});
					continue;
				}
				if (resource.type && resource.type !== "file") continue;
				const path =
					normalizeBoardRemoteUrl(resource.url) ??
					(resource.path ?? resource.ref ?? "").replace(/\/$/, "");
				if (!parseBoardMediaSource(path)) continue;
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
	if (!drop.files.length && !drop.tasks.length && !drop.sessions.length) {
		const path = data?.getData("text/cohub-path")?.replace(/\/$/, "");
		if (path && parseBoardMediaSource(path)) drop.files.push({ path });
	}
	if (
		!drop.files.length &&
		!drop.tasks.length &&
		!drop.sessions.length &&
		!drop.apps.length
	) {
		const text =
			data?.getData("text/uri-list") || data?.getData("text/plain") || "";
		drop.urls = [
			...new Set(
				text.split(/\r?\n/).flatMap((line) => {
					if (line.startsWith("#")) return [];
					const url = normalizeBoardRemoteUrl(line);
					return url ? [url] : [];
				}),
			),
		];
	}
	return drop;
}

export function boardPointerResources(
	payload: PointerDragPayload,
): BoardResourceDrop {
	const apps = payload.items.flatMap((item) =>
		item.type === "app" && item.appId && item.appRef && item.appUrl
			? [
					{
						appId: item.appId,
						ref: item.appRef,
						url: item.appUrl,
						name: item.name,
						icon: item.icon,
						...boardAppFace(item),
					},
				]
			: [],
	);
	return {
		files: toBoardDropItems(payload),
		tasks: [],
		sessions: [],
		apps,
		urls: [],
	};
}
