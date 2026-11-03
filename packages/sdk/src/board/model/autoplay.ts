import { type BoardItem, featuredTaskArtifact } from "@cohub/protocol";
import type { BoardAppMetadata } from "./items/create.js";
import { isBoardModelItem } from "./media.js";
import type { BoardMediaState } from "./media-spans.js";
import type { BoardScene } from "./scene.js";

export type BoardAutoplayKind = "app" | "video" | "model";

const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined);

export function boardAppMetadata(item: BoardItem | null | undefined): BoardAppMetadata | null {
	if (item?.type !== "frame" || !item.metadata) return null;
	const value = item.metadata.cohubApp;
	if (!value || typeof value !== "object") return null;
	const app = value as Record<string, unknown>;
	const appId = text(app.appId);
	const ref = text(app.ref);
	const url = text(app.url);
	const name = text(app.name);
	if (!appId || !ref || !url || !name) return null;
	const icon = text(app.icon);
	const cover = text(app.cover);
	const themeColor = text(app.themeColor);
	return { appId, ref, url, name, ...(icon ? { icon } : {}), ...(cover ? { cover } : {}), ...(themeColor ? { themeColor } : {}) };
}

export function boardAutoplayKind(item: BoardItem | null | undefined): BoardAutoplayKind | null {
	if (!item) return null;
	if (item.type === "video") return item.props.time === undefined ? "video" : null;
	if (item.type === "task") return boardAutoplayVideo(item) ? "video" : null;
	if (isBoardModelItem(item)) return "model";
	return boardAppMetadata(item) ? "app" : null;
}

export function boardAutoplayVideo(item: BoardItem): string | null {
	if (item.type === "video") return item.props.time === undefined ? item.props.src : null;
	if (item.type !== "task" || item.props.snapshot.status !== "completed") return null;
	const artifact = featuredTaskArtifact(item.props.snapshot.artifacts);
	return artifact?.type === "video" ? artifact.url : null;
}

export function boardAutoplayLoops(scene: BoardScene, at: number): BoardMediaState[] {
	const loops: BoardMediaState[] = [];
	for (const item of scene.items) {
		const src = item.autoplay ? boardAutoplayVideo(item) : null;
		if (src) loops.push({ id: item.id, kind: "video", src, time: at, volume: 0, shown: scene.shown(item.id), loop: true });
	}
	return loops;
}
