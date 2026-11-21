import type { BoardItem, BoardMediaPresentation } from "@cohub/protocol/board-model";
import { isBoardScriptTemporary } from "./script-scene.js";

/**
 * How an image or video shows: its own `props.presentation`, else the nearest
 * enclosing frame's, else plain for a script's temporary items and card for the
 * rest. Other item types are always cards.
 */
export function boardMediaPresentation(
	item: BoardItem & { readonly id: string },
	lookup: (id: string) => BoardItem | undefined,
): BoardMediaPresentation {
	if (item.type !== "image" && item.type !== "video") return "card";
	if (item.props.presentation) return item.props.presentation;
	const seen = new Set([item.id]);
	for (let id = item.parent; id && !seen.has(id); ) {
		seen.add(id);
		const parent = lookup(id);
		if (!parent) break;
		if (parent.type === "frame" && parent.props.presentation) return parent.props.presentation;
		id = parent.parent;
	}
	return isBoardScriptTemporary(item.id) ? "plain" : "card";
}
