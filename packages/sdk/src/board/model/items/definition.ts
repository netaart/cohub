import {
	BOARD_EXTENSION_TYPE_PATTERN,
	type BoardExtensionItem,
	type BoardItemType,
	isBuiltinItemType,
} from "@cohub/protocol";
import type { z } from "zod";
import type { Rect, WorldPoint } from "../geometry.js";
import type { BoardSceneItem } from "../scene.js";

export type BoardItemCapabilities = {
	canMove: boolean;
	canResize: boolean;
	aspectLocked: boolean;
	canRotate: boolean;
	canEdit: boolean;
	canConnect: boolean;
	canSnap: boolean;
	canLock: boolean;
};

export type BoardItemResizeMode = "none" | "uniform" | "free";

export const FULL_CAPABILITIES: BoardItemCapabilities = {
	canMove: true,
	canResize: true,
	aspectLocked: false,
	canRotate: true,
	canEdit: false,
	canConnect: true,
	canSnap: true,
	canLock: true,
};

export type BoardItemDefinition<Props extends Record<string, unknown> = Record<string, unknown>> = {
	type: BoardItemType;
	capabilities?: Partial<BoardItemCapabilities>;
	size?: { width: number; height: number };
	props?: z.ZodType<Props>;
	bounds?: (item: BoardSceneItem) => Rect;
	hitTest?: (item: BoardSceneItem, point: WorldPoint) => boolean;
};

export type BoardItemOf<Definition> = Definition extends BoardItemDefinition<infer Props>
	? BoardExtensionItem & { props: Props }
	: never;

export function defineBoardItem<Props extends Record<string, unknown>>(
	definition: BoardItemDefinition<Props>,
): BoardItemDefinition<Props> {
	if (!isBuiltinItemType(definition.type) && !BOARD_EXTENSION_TYPE_PATTERN.test(definition.type))
		throw new Error(`Board item type "${definition.type}" must be namespaced, like "acme.order".`);
	return definition;
}
