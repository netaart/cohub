import type { BoardArrowItem } from "@cohub/protocol";
import { pathPointAt, type ResolvedArrow } from "../model/arrow-geometry.js";
import type { WorldPoint } from "../model/geometry.js";

export const FRAME_LABEL_WEIGHT = "600";

export const ARROW_LABEL = { fontWeight: "500", lineHeight: 1.25, padX: 0.5, padY: 0.25 } as const;

export function arrowLabelAnchor(arrow: ResolvedArrow, style: BoardArrowItem["style"]): WorldPoint {
	return style.trim === undefined ? arrow.mid : pathPointAt(arrow.path, 0.5);
}
