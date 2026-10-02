
import { z } from "zod";
import {
	BOARD_CAMERA_TARGET,
	BOARD_COLOR_TOKENS,
	BOARD_EFFECT_KINDS,
	BOARD_EFFECT_KIND_INFO,
	BOARD_ITEM_SCHEMAS,
	BOARD_ITEM_TYPES,
	BoardAnimationHeaderSchema,
	BoardSettingsSchema,
	BoardTrackSchema,
	isBuiltinItemType,
} from "./board-model.js";
import { listBoardProperties } from "./board-patch.js";

type JsonSchema = Record<string, unknown>;

function toJsonSchema(schema: z.ZodType): JsonSchema {
	const { $schema: _schema, ...rest } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
	return rest;
}

export const BOARD_SCHEMA_TARGETS = ["board", "animation", "track", BOARD_CAMERA_TARGET, ...BOARD_ITEM_TYPES] as const;

export type BoardJsonSchemaResult = {
	schema?: JsonSchema;
	properties?: Array<{ property: string; kind: string }>;
	kinds?: Record<string, { description: string; parameters: Record<string, string> }>;
};

export function boardJsonSchema(target: string): BoardJsonSchemaResult | null {
	if (target === "board") return { schema: toJsonSchema(BoardSettingsSchema) };
	if (target === "animation") {
		return {
			schema: toJsonSchema(BoardAnimationHeaderSchema.extend({ tracks: z.record(z.string(), BoardTrackSchema).optional() })),
			properties: listBoardProperties("animation"),
		};
	}
	if (target === "track") return { schema: toJsonSchema(BoardTrackSchema) };
	if (target === "effect") {
		return {
			schema: toJsonSchema(BOARD_ITEM_SCHEMAS.effect as unknown as z.ZodType),
			properties: listBoardProperties("effect"),
			kinds: Object.fromEntries(BOARD_EFFECT_KINDS.map((kind) => [kind, BOARD_EFFECT_KIND_INFO[kind]])),
		};
	}
	if (target === BOARD_CAMERA_TARGET) return { properties: listBoardProperties(BOARD_CAMERA_TARGET) };
	if (!isBuiltinItemType(target)) return null;
	return { schema: toJsonSchema(BOARD_ITEM_SCHEMAS[target] as unknown as z.ZodType), properties: listBoardProperties(target) };
}

export function boardSchemaOverview() {
	return {
		units: { time: "milliseconds", rotation: "degrees", length: "board units (1 = 1 CSS px at zoom 1)" },
		types: BOARD_ITEM_TYPES,
		colors: { tokens: BOARD_COLOR_TOKENS, css: "any CSS color", themed: "{ light, dark }" },
		properties: Object.fromEntries(
			[...BOARD_ITEM_TYPES, BOARD_CAMERA_TARGET, "animation"].map((target) => [target, listBoardProperties(target).map((entry) => entry.property)]),
		),
	};
}
