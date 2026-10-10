import { type BoardItem, hasAuthoredSize, parseBoardItem } from "@cohub/protocol";
import { frameContainsPoint, itemBounds, type Rect, type WorldPoint } from "../geometry.js";
import type { BoardSceneItem } from "../scene.js";
import { builtinBoardItems } from "./builtin.js";
import type { BoardItemEntry } from "./create.js";
import {
	type BoardItemCapabilities,
	type BoardItemDefinition,
	type BoardItemResizeMode,
	FULL_CAPABILITIES,
} from "./definition.js";
import { createBoardItemId } from "./id.js";

export type BoardItemInput = {
	props?: Record<string, unknown>;
	at: WorldPoint;
	size?: { width: number; height: number };
	id?: string;
};

const DEFAULT_ITEM_SIZE = { width: 240, height: 160 };

export type BoardRegistry = {
	readonly definitions: readonly BoardItemDefinition[];
	get(type: string): BoardItemDefinition | undefined;
	capabilities(item: Pick<BoardItem, "type">): BoardItemCapabilities;
	resizeMode(item: Pick<BoardItem, "type">): BoardItemResizeMode;
	bounds(item: BoardSceneItem): Rect;
	hitTest(item: BoardSceneItem, point: WorldPoint): boolean;
	validateProps(type: string, props: unknown): { ok: true } | { ok: false; message: string };
	create(type: string, input: BoardItemInput): BoardItemEntry;
};

export function createBoardRegistry(definitions: Iterable<BoardItemDefinition> = []): BoardRegistry {
	const byType = new Map<string, BoardItemDefinition>();
	for (const definition of [...builtinBoardItems, ...definitions]) byType.set(definition.type, definition);
	const capabilities = new Map<string, BoardItemCapabilities>();

	function capabilitiesOf(type: string): BoardItemCapabilities {
		let value = capabilities.get(type);
		if (!value) {
			value = { ...FULL_CAPABILITIES, ...byType.get(type)?.capabilities };
			capabilities.set(type, value);
		}
		return value;
	}

	function validateProps(type: string, props: unknown): { ok: true } | { ok: false; message: string } {
		const schema = byType.get(type)?.props;
		if (!schema) return { ok: true };
		const parsed = schema.safeParse(props);
		if (parsed.success) return { ok: true };
		const issue = parsed.error.issues[0];
		const path = issue?.path.length ? `.${issue.path.join(".")}` : "";
		return { ok: false, message: `${type} props${path}: ${issue?.message ?? "invalid"}` };
	}

	return {
		definitions: [...byType.values()],
		get: (type) => byType.get(type),
		capabilities: (item) => capabilitiesOf(item.type),
		resizeMode(item) {
			const value = capabilitiesOf(item.type);
			if (!value.canResize) return "none";
			return value.aspectLocked ? "uniform" : "free";
		},
		bounds: (item) => byType.get(item.type)?.bounds?.(item) ?? itemBounds(item.frame),
		hitTest(item, point) {
			const hitTest = byType.get(item.type)?.hitTest;
			return hitTest ? hitTest(item, point) : frameContainsPoint(item.frame, point);
		},
		validateProps,
		create(type, { props = {}, at, size, id = createBoardItemId() }) {
			const valid = validateProps(type, props);
			if (!valid.ok) throw new Error(valid.message);
			const box = size ?? byType.get(type)?.size ?? DEFAULT_ITEM_SIZE;
			const placement = hasAuthoredSize(type)
				? { position: { x: at.x - box.width / 2, y: at.y - box.height / 2 }, size: { ...box } }
				: { position: { x: at.x, y: at.y } };
			const parsed = parseBoardItem({ type, ...placement, props });
			if (!parsed.ok) {
				const diagnostic = parsed.diagnostics[0];
				throw new Error(`Invalid ${type} item: ${diagnostic?.path}: ${diagnostic?.message}`);
			}
			return { id, item: parsed.item };
		},
	};
}

export const defaultBoardRegistry = createBoardRegistry();
