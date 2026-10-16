import {
	BOARD_NODE_CAPABILITIES,
	type BoardContentKind,
	type BoardNodeCapability,
	type BoardPort,
	EMPTY_BOARD_NODE_CAPABILITY,
} from "@cohub/protocol";
import type { BoardItem } from "@neta-art/cohub/board";

export type { BoardContentKind, BoardNodeCapability, BoardPort };
export { BOARD_NODE_CAPABILITIES };

export function nodeCapability(item: BoardItem): BoardNodeCapability {
	return BOARD_NODE_CAPABILITIES[item.type] ?? EMPTY_BOARD_NODE_CAPABILITY;
}

export function nodeOutputKind(item: BoardItem): BoardContentKind | null {
	return nodeCapability(item).outputs[0]?.kind ?? null;
}

export function canConnectContent(
	output: BoardContentKind,
	input: BoardPort,
): boolean {
	return input.kind === output || input.kind === "collection";
}

export function referencePortForKind(
	kind: "image" | "video" | "audio" | "3d",
): BoardPort {
	return {
		id: `${kind}-references`,
		kind,
		role: "reference",
		multiple: true,
	};
}
