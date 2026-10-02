import type { BoardItem, BoardTrack } from "@cohub/protocol";
import { BOARD_CAMERA_TARGET } from "@cohub/protocol";

export type BoardTrackRow = {
	id: string;
	target: string;
	property: string;
	kind: "item" | "camera";
	label: string;
	itemType: string | null;
	keyframes: BoardTrack["keyframes"];
};

function itemLabel(item: BoardItem, fallback: string): string {
	switch (item.type) {
		case "text":
			return item.props.text.split("\n")[0] || item.type;
		case "shape":
			return item.props.text.split("\n")[0] || item.props.geometry;
		case "arrow":
			return item.props.label || item.type;
		case "frame":
			return item.props.label || item.type;
		case "image":
		case "video":
		case "audio":
		case "file":
			return (
				item.props.snapshot?.title ??
				item.props.src.split("/").pop() ??
				item.type
			);
		case "task":
			return item.props.snapshot.title;
		case "effect":
			return item.props.kind;
		case "sketch":
			return item.props.src.split("/").pop() ?? item.type;
		default:
			return fallback;
	}
}

export function boardTrackRows(
	items: Readonly<Record<string, BoardItem>>,
	tracks: Readonly<Record<string, BoardTrack>>,
): BoardTrackRow[] {
	const rows: BoardTrackRow[] = [];
	for (const [id, track] of Object.entries(tracks)) {
		const isCamera = track.target === BOARD_CAMERA_TARGET;
		const item = isCamera ? undefined : items[track.target];
		rows.push({
			id,
			target: track.target,
			property: track.property,
			kind: isCamera ? "camera" : "item",
			label: isCamera
				? track.property
				: item
					? itemLabel(item, track.target)
					: track.target,
			itemType: item?.type ?? null,
			keyframes: track.keyframes,
		});
	}
	return rows.sort((left, right) => {
		if (left.kind !== right.kind) return left.kind === "camera" ? -1 : 1;
		if (left.target !== right.target)
			return left.target < right.target ? -1 : 1;
		return left.property < right.property ? -1 : 1;
	});
}

export const BOARD_EASE_PRESETS = [
	"linear",
	"ease",
	"ease-in",
	"ease-out",
	"ease-in-out",
] as const;
