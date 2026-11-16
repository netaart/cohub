
import * as z from "zod";
import { BOARD_DEFAULT_SIZES, BOARD_MEDIA_EDGE, BOARD_PAGE_SIZE, BOARD_TEXT_SCALE } from "./board-constants.js";
import {
	BOARD_CAMERA_TARGET,
	BOARD_COLOR_TOKENS,
	BOARD_EFFECT_KINDS,
	BOARD_EFFECT_KIND_INFO,
	BOARD_ITEM_SCHEMAS,
	BOARD_ITEM_TYPES,
	BoardAnimationHeaderSchema,
	BoardDepthSchema,
	BoardExtensionItemSchema,
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

export const BOARD_SCHEMA_TARGETS = ["board", "animation", "track", "script", "extension", "depth", BOARD_CAMERA_TARGET, ...BOARD_ITEM_TYPES] as const;

export const BOARD_DEPTH_GUIDE = {
	camera: "Like a map: the eye looks straight down at the middle of the view from 1.5 view heights away, so perspective reads the same on every screen and zoom, and lifted items lean away from the middle.",
	order: "Bend, then spin within the item's plane, tilt about its own axes through origin, rotation on the Board, then lift toward the viewer.",
	layers: "A lifted item draws above every flat item, with a soft shadow on the Board; lifted items hide each other by distance. Depth inside a lifted frame stays part of its picture.",
	editing: "Pointers act on what they touch in the lifted picture. Lifted items move but resize and turn once they lie flat again; arrows connect while flat.",
	animate: "Every number and vec2 animates by path (depth.lift, depth.tilt, depth.bend.phase); presets flip, lift, land, toss, sway, wave and curl write them. Scripts present depth with ctx.present.",
	custom: "depth.bend.kind custom runs the bend GLSL the item's own script module exports: export const bend = { glsl }. See schema script.",
	export: "Exports draw depth in local Chrome, like shaders; a whole-board export frames lifted items where they appear, and video frames keep the first frame's area unless --rect or --camera sets it.",
};

export type BoardJsonSchemaResult = {
	schema?: JsonSchema;
	properties?: Array<{ property: string; kind: string }>;
	kinds?: Record<string, { description: string; parameters: Record<string, string> }>;
	guide?: Record<string, string>;
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
	if (target === "extension") return { schema: toJsonSchema(BoardExtensionItemSchema) };
	if (target === "depth") return { schema: toJsonSchema(BoardDepthSchema), guide: BOARD_DEPTH_GUIDE, properties: listBoardProperties("frame").filter(({ property }) => property.startsWith("depth.")) };
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
		extensionTypes: "Namespaced types like acme.order keep props as written; give them a preview (title, excerpt, cover, src) so every client can show them. See schema extension.",
		depth: "Any item's depth lifts it off the Board into perspective: lift, tilt, spin, bend (wave, cloth, curl or custom GLSL), shade, shadow and a back face. See schema depth.",
		colors: { tokens: BOARD_COLOR_TOKENS, css: "any CSS color", themed: "{ light, dark }" },
		properties: Object.fromEntries(
			[...BOARD_ITEM_TYPES, BOARD_CAMERA_TARGET, "animation"].map((target) => [target, listBoardProperties(target).map((entry) => entry.property)]),
		),
	};
}
