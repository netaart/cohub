
import { z } from "zod";
import { BOARD_DEFAULT_SIZES, BOARD_MEDIA_EDGE, BOARD_PAGE_SIZE, BOARD_TEXT_SCALE } from "./board-constants.js";
import {
	BOARD_CAMERA_TARGET,
	BOARD_COLOR_TOKENS,
	BOARD_EFFECT_KINDS,
	BOARD_EFFECT_KIND_INFO,
	BOARD_ITEM_SCHEMAS,
	BOARD_ITEM_TYPES,
	BoardAnimationHeaderSchema,
	BoardKeySchema,
	BoardScriptSchema,
	BoardSettingsSchema,
	BoardTrackSchema,
	isBuiltinItemType,
} from "./board-model.js";
import { listBoardProperties, resolveBoardProperty } from "./board-patch.js";

type JsonSchema = Record<string, unknown>;

function toJsonSchema(schema: z.ZodType): JsonSchema {
	const { $schema: _schema, ...rest } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
	return rest;
}

export const BOARD_SCHEMA_TARGETS = ["board", "animation", "track", "script", BOARD_CAMERA_TARGET, ...BOARD_ITEM_TYPES] as const;

export type BoardJsonSchemaResult = {
	schema?: JsonSchema;
	properties?: Array<{ property: string; kind: string }>;
	kinds?: Record<string, { description: string; parameters: Record<string, string> }>;
};

export function boardJsonSchema(target: string): BoardJsonSchemaResult | null {
	if (target === "board") return { schema: toJsonSchema(BoardSettingsSchema) };
	if (target === "animation") {
		return {
			schema: toJsonSchema(BoardAnimationHeaderSchema.extend({ tracks: z.record(BoardKeySchema, BoardTrackSchema).optional() })),
			properties: listBoardProperties("animation"),
		};
	}
	if (target === "track") return { schema: toJsonSchema(BoardTrackSchema) };
	if (target === "script") return { schema: toJsonSchema(BoardScriptSchema) };
	if (target === BOARD_CAMERA_TARGET) {
		const properties = listBoardProperties(target);
		const fields = Object.fromEntries(properties.map(({ property }) => {
			const result = resolveBoardProperty(target, property);
			if (!result.ok) throw new Error(result.message);
			return [property, result.spec.schema];
		}));
		return { schema: toJsonSchema(z.object(fields).partial().strict()), properties };
	}
	if (!isBuiltinItemType(target)) return null;
	return {
		schema: toJsonSchema(BOARD_ITEM_SCHEMAS[target] as unknown as z.ZodType),
		properties: listBoardProperties(target),
		...(target === "effect" ? { kinds: Object.fromEntries(BOARD_EFFECT_KINDS.map((kind) => [kind, BOARD_EFFECT_KIND_INFO[kind]])) } : {}),
	};
}

export function boardSchemaOverview() {
	return {
		units: { time: "milliseconds", rotation: "degrees", length: "board units (1 = 1 CSS px at zoom 1)" },
		coordinates: "Positions, draw points and unbound arrow endpoints are relative to their parent frame; without a parent they are world coordinates. Shape paths are fitted to the item size.",
		scale: {
			guide: "Sizes that read together at 100% zoom. Match the content already nearby; use page for slide frames, a long edge of mediaEdge for media, and fontSizes for text.",
			page: BOARD_PAGE_SIZE,
			mediaEdge: BOARD_MEDIA_EDGE,
			fontSizes: BOARD_TEXT_SCALE,
			itemSizes: BOARD_DEFAULT_SIZES,
		},
		types: BOARD_ITEM_TYPES,
		colors: { tokens: BOARD_COLOR_TOKENS, css: "any CSS color", themed: "{ light, dark }" },
		properties: Object.fromEntries(
			[...BOARD_ITEM_TYPES, BOARD_CAMERA_TARGET, "animation"].map((target) => [target, listBoardProperties(target).map((entry) => entry.property)]),
		),
	};
}
