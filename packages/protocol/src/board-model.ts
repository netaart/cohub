
import { z } from "zod";
import {
	BOARD_DEFAULT_ITEM_SIZE,
	BOARD_DEFAULT_SIZES,
	BOARD_TEXT_FONT_SIZE,
	BOARD_TEXT_MAX_FONT_SIZE,
	BOARD_TEXT_MIN_FONT_SIZE,
} from "./board-constants.js";

import { normalizeBoardRemoteUrl } from "./board-url.js";

export const BOARD_ID_MAX_LENGTH = 160;
export const BOARD_CAMERA_TARGET = "camera" as const;

export const BoardKeySchema = z
	.string()
	.min(1)
	.max(BOARD_ID_MAX_LENGTH)
	.regex(/^[^\s/]+$/, "ids must not contain whitespace or '/'");
export const BoardIdSchema = BoardKeySchema
	.refine((value) => value !== BOARD_CAMERA_TARGET, "\"camera\" is reserved");

const finite = z.number().finite();
const nonNegative = finite.nonnegative();
const ratio = finite.min(0).max(1);

export const BoardVec2Schema = z.object({ x: finite, y: finite }).strict();
export const BoardSizeSchema = z
	.object({ width: finite.positive(), height: finite.positive() })
	.strict();
export type BoardVec2 = z.infer<typeof BoardVec2Schema>;
export type BoardSize = z.infer<typeof BoardSizeSchema>;


export const BOARD_COLOR_TOKENS = [
	"brand",
	"neutral",
	"black",
	"white",
	"blue",
	"green",
	"amber",
	"violet",
	"rose",
] as const;
export type BoardColorToken = (typeof BOARD_COLOR_TOKENS)[number];

const CSS_NAMED_COLORS = new Set(
	"transparent aliceblue antiquewhite aqua aquamarine azure beige bisque blanchedalmond blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray grey greenyellow honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat whitesmoke yellow yellowgreen".split(
		" ",
	),
);

export function isBoardColorString(value: string): boolean {
	const color = value.trim().toLowerCase();
	return (
		(BOARD_COLOR_TOKENS as readonly string[]).includes(color) ||
		CSS_NAMED_COLORS.has(color) ||
		/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(color) ||
		/^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)$/.test(color)
	);
}

const colorString = z
	.string()
	.max(120)
	.refine(isBoardColorString, "expected a palette token or a CSS color");

export const BoardColorSchema = z.union([
	colorString,
	z.object({ light: colorString, dark: colorString }).strict(),
]).describe("Palette token (follows the theme), CSS color, or { light, dark }.");
export type BoardColor = z.infer<typeof BoardColorSchema>;


export const BOARD_DASHES = ["solid", "dashed", "dotted"] as const;
export type BoardDash = (typeof BOARD_DASHES)[number];

export const BoardStyleSchema = z
	.object({
		fill: BoardColorSchema.optional(),
		fillOpacity: ratio.optional().describe("Fill opacity, independent of the item's opacity."),
		stroke: BoardColorSchema.optional(),
		strokeWidth: finite.min(0).max(64).optional(),
		dash: z.enum(BOARD_DASHES).optional(),
		radius: nonNegative.optional().describe("Corner radius in board units."),
		trim: ratio.optional().describe("Fraction of the outline drawn; animate 0 → 1 to draw it in."),
	})
	.strict();
export type BoardStyle = z.infer<typeof BoardStyleSchema>;


export function isSafeBoardSourcePath(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 4096 &&
		!value.startsWith("/") &&
		!/^[a-z][a-z\d+.-]*:/i.test(value.trimStart()) &&
		!value.includes("\\") &&
		value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
	);
}

const srcSchema = z
	.string()
	.refine(isSafeBoardSourcePath, "src must be a relative Space file path");

export type BoardMediaSource = { kind: "url" | "file"; value: string };

export function parseBoardMediaSource(src: string): BoardMediaSource | null {
	if (isSafeBoardSourcePath(src)) return { kind: "file", value: src };
	return normalizeBoardRemoteUrl(src) ? { kind: "url", value: src } : null;
}

export const BoardMediaSourceSchema = z.string().max(4096).refine(
	(src) => parseBoardMediaSource(src) !== null,
	"src must be a public HTTP(S) URL or relative Space file path",
).describe("Prefer a public HTTP(S) URL; a Space path relative to the workspace root also works.");

export const BoardScriptSchema = z.object({
	src: srcSchema.refine((path) => /\.m?js$/.test(path), "script src must be a .js or .mjs module").describe("A .js or .mjs Space file."),
	params: z.record(z.string(), z.json()).default({}).describe("Values the module reads as params."),
	targets: z.record(z.string().min(1).max(80), BoardIdSchema).default({}).describe("Named items the module can reach, as ctx.targets."),
	seed: z.string().min(1).max(160).optional().describe("Seed for ctx.random(); defaults to the item id."),
	enabled: z.boolean().default(true),
}).strict().describe("A JavaScript module attached to the item; `cohub boards schema script` lists its API.");
export type BoardScript = z.infer<typeof BoardScriptSchema>;

const itemEnvelope = {
	script: BoardScriptSchema.optional(),
	parent: BoardIdSchema.optional().describe("A frame id; position becomes relative to the frame, and the item moves with it."),
	z: finite.optional().describe("Order among siblings; new items go on top."),
	position: BoardVec2Schema.default({ x: 0, y: 0 }),
	rotation: finite.default(0),
	scale: z.union([finite, BoardVec2Schema]).default(1),
	origin: BoardVec2Schema.default({ x: 0.5, y: 0.5 }).describe("Rotation and scale origin as fractions of the size."),
	opacity: ratio.default(1),
	style: BoardStyleSchema.default({}),
	locked: z.boolean().optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
};
const boxed = (size: { width: number; height: number }) => ({
	...itemEnvelope,
	size: BoardSizeSchema.default({ ...size }),
});
const unsized = { ...itemEnvelope };

const fontSize = finite.min(BOARD_TEXT_MIN_FONT_SIZE).max(BOARD_TEXT_MAX_FONT_SIZE);
export const BOARD_TEXT_ALIGNS = ["left", "center", "right"] as const;
export const BOARD_SHAPE_GEOMETRIES = [
	"rectangle",
	"rounded",
	"ellipse",
	"diamond",
	"triangle",
	"path",
] as const;
export type BoardShapeGeometry = (typeof BOARD_SHAPE_GEOMETRIES)[number];

export const BoardFrameItemSchema = z
	.object({
		...boxed(BOARD_DEFAULT_SIZES.frame),
		type: z.literal("frame"),
		props: z
			.object({
				label: z.string().max(280).default(""),
				decoration: z.enum(["frame", "none"]).optional().describe("none hides the title, border and background: an invisible group whose tracks move every child."),
				clip: z.boolean().default(true).describe("Hide children outside the frame."),
			})
			.strict()
			.prefault({}),
	})
	.strict();

export const BoardTextItemSchema = z
	.object({
		...unsized,
		type: z.literal("text"),
		props: z
			.object({
				text: z.string().default(""),
				fontSize: fontSize.default(BOARD_TEXT_FONT_SIZE),
				fontWeight: finite.min(100).max(900).default(500),
				font: z.string().min(1).max(120).default("sans").describe("sans, serif, mono, or a font family name."),
				align: z.enum(BOARD_TEXT_ALIGNS).default("left"),
				lineHeight: finite.min(0.5).max(4).default(4 / 3),
				width: finite.positive().optional().describe("Wrap width; the height follows the text."),
				reveal: ratio.default(1).describe("Fraction of the text shown; animate 0 → 1 to type it."),
				caret: z.boolean().default(false).describe("Blink a caret while the text is being revealed."),
			})
			.strict()
			.prefault({}),
	})
	.strict();

export const BoardShapeItemSchema = z
	.object({
		...boxed(BOARD_DEFAULT_SIZES.shape),
		type: z.literal("shape"),
		props: z
			.object({
				geometry: z.enum(BOARD_SHAPE_GEOMETRIES).default("rectangle"),
				path: z.string().min(1).max(200_000).optional().describe("SVG path data for path geometry, fitted to the item size."),
				text: z.string().default(""),
				fontSize: fontSize.default(20),
				align: z.enum(BOARD_TEXT_ALIGNS).default("center"),
			})
			.strict()
			.refine(
				(props) => props.geometry !== "path" || Boolean(props.path),
				{ message: "path geometry requires props.path", path: ["path"] },
			)
			.prefault({}),
	})
	.strict();

export const BoardDrawPointSchema = z
	.object({ x: finite, y: finite, p: ratio.default(0.5).describe("Pen pressure.") })
	.strict();
export type BoardDrawPoint = z.infer<typeof BoardDrawPointSchema>;

export const BoardDrawItemSchema = z
	.object({
		...unsized,
		type: z.literal("draw"),
		props: z
			.object({ points: z.array(BoardDrawPointSchema).min(1).max(100_000).describe("Stroke points relative to position; the size follows them.") })
			.strict(),
	})
	.strict();

export const BOARD_ANCHOR_SIDES = ["top", "right", "bottom", "left"] as const;
export type BoardAnchorSide = (typeof BOARD_ANCHOR_SIDES)[number];
export const BoardArrowAnchorSchema = z.union([
	z.literal("auto"),
	z.object({ side: z.enum(BOARD_ANCHOR_SIDES), offset: ratio.default(0.5) }).strict(),
	z.object({ x: ratio, y: ratio }).strict(),
]);
export type BoardArrowAnchor = z.infer<typeof BoardArrowAnchorSchema>;

export const BoardArrowBindingSchema = z
	.object({
		item: BoardIdSchema,
		anchor: BoardArrowAnchorSchema.default("auto").describe("auto uses the side facing the other end; or a side with an offset, or a point as fractions of the item."),
		port: z.string().min(1).max(120).optional(),
	})
	.strict();
export type BoardArrowBinding = z.infer<typeof BoardArrowBindingSchema>;

export const BoardArrowEndSchema = z
	.union([BoardVec2Schema, BoardArrowBindingSchema])
	.describe("A point relative to position, or { item } to follow that item.");
export type BoardArrowEnd = z.infer<typeof BoardArrowEndSchema>;

export const BOARD_ARROW_ROUTES = ["straight", "curve", "orthogonal"] as const;
export type BoardArrowRoute = (typeof BOARD_ARROW_ROUTES)[number];

export const BoardArrowItemSchema = z
	.object({
		...unsized,
		type: z.literal("arrow"),
		props: z
			.object({
				start: BoardArrowEndSchema,
				end: BoardArrowEndSchema,
				route: z.enum(BOARD_ARROW_ROUTES).default("straight"),
				bend: finite.min(-0.85).max(0.85).default(0).describe("Sideways curve as a fraction of the length; the sign picks the side."),
				waypoints: z.array(BoardVec2Schema).max(64).default([]).describe("Points the route passes through."),
				arrowStart: z.boolean().default(false),
				arrowEnd: z.boolean().default(true),
				label: z.string().max(280).default(""),
				fontSize: fontSize.default(14),
				relation: z
					.string()
					.max(64)
					.regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, "relation must be a lowercase slug")
					.optional()
					.describe("What the arrow means, as a slug such as triggers or depends-on."),
			})
			.strict(),
	})
	.strict();

export const BoardMediaSnapshotSchema = z
	.object({
		title: z.string().optional(),
		mimeType: z.string().optional(),
		size: nonNegative.optional(),
		mtimeMs: nonNegative.optional(),
		naturalWidth: finite.positive().optional(),
		naturalHeight: finite.positive().optional(),
		durationMs: nonNegative.optional(),
		excerpt: z.string().optional(),
		coverPath: z.string().optional(),
		coverUrl: z.string().optional(),
	})
	.strict()
	.describe("Cached facts for an instant preview; filled in when the media loads.");
export type BoardMediaSnapshot = z.infer<typeof BoardMediaSnapshotSchema>;

const fileProps = {
	src: BoardMediaSourceSchema,
	snapshot: BoardMediaSnapshotSchema.optional(),
};
export const BoardMediaOriginSchema = z
	.object({ taskRunId: z.string().min(1).max(160), artifactId: z.string().min(1).max(240) })
	.strict()
	.describe("The generation run and result this media came from.");
export type BoardMediaOrigin = z.infer<typeof BoardMediaOriginSchema>;
const mediaProps = { ...fileProps, origin: BoardMediaOriginSchema.optional() };
const timedFileProps = {
	...mediaProps,
	time: nonNegative.optional().describe("Playback position in milliseconds; animate props.time to play it on a timeline."),
};

export const BoardCropSchema = z
	.object({ x: ratio, y: ratio, w: ratio, h: ratio })
	.strict()
	.describe("Region shown, as fractions of the image. Without it the whole image fits inside size.");

export const BoardImageItemSchema = z
	.object({
		...boxed(BOARD_DEFAULT_SIZES.image),
		type: z.literal("image"),
		props: z.object({ ...mediaProps, crop: BoardCropSchema.optional() }).strict(),
	})
	.strict();
export const BoardVideoItemSchema = z
	.object({ ...boxed(BOARD_DEFAULT_SIZES.video), type: z.literal("video"), props: z.object(timedFileProps).strict() })
	.strict();
export const BoardAudioItemSchema = z
	.object({ ...boxed(BOARD_DEFAULT_SIZES.audio), type: z.literal("audio"), props: z.object(timedFileProps).strict() })
	.strict();
export const BoardFileItemSchema = z
	.object({ ...boxed(BOARD_DEFAULT_SIZES.file), type: z.literal("file"), props: z.object(fileProps).strict() })
	.strict();

export const BOARD_TASK_ARTIFACT_LIMIT = 6;
const httpsUrl = z.string().max(4096).url();
const artifactBase = {
	id: z.string().min(1).max(240),
	title: z.string().max(240).optional(),
	url: httpsUrl,
	mimeType: z.string().max(160).optional(),
};
export const BoardTaskArtifactSchema = z.discriminatedUnion("type", [
	z.object({ ...artifactBase, type: z.literal("image"), naturalWidth: finite.positive().optional(), naturalHeight: finite.positive().optional() }).strict(),
	z.object({ ...artifactBase, type: z.literal("video"), previewUrl: httpsUrl.optional(), durationMs: z.number().int().positive().optional(), naturalWidth: finite.positive().optional(), naturalHeight: finite.positive().optional() }).strict(),
	z.object({ ...artifactBase, type: z.literal("audio"), previewUrl: httpsUrl.optional(), durationMs: z.number().int().positive().optional() }).strict(),
	z.object({ id: z.string().min(1).max(240), type: z.literal("text"), title: z.string().max(240).optional(), textExcerpt: z.string().min(1).max(480) }).strict(),
]);
export type BoardTaskArtifact = z.infer<typeof BoardTaskArtifactSchema>;

export const BoardTaskSnapshotSchema = z
	.object({
		taskType: z.string().min(1).max(120),
		status: z.enum(["pending", "running", "completed", "failed"]),
		title: z.string().min(1).max(240),
		model: z.string().max(160).optional(),
		promptExcerpt: z.string().max(480).optional(),
		errorExcerpt: z.string().max(240).optional(),
		artifactCount: z.number().int().nonnegative(),
		artifacts: z.array(BoardTaskArtifactSchema).max(BOARD_TASK_ARTIFACT_LIMIT).default([]),
		startedAt: z.string().max(64).optional(),
		updatedAt: z.string().optional(),
	})
	.strict();
export type BoardTaskSnapshot = z.infer<typeof BoardTaskSnapshotSchema>;

export const BoardTaskItemSchema = z
	.object({
		...boxed(BOARD_DEFAULT_SIZES.task),
		type: z.literal("task"),
		props: z
			.object({
				taskRunId: z.string().min(1).max(160).describe("The generation run shown; the server keeps the card's status and results up to date."),
				snapshot: BoardTaskSnapshotSchema.describe("Maintained by the server; omit it."),
			})
			.strict(),
	})
	.strict();

export const BOARD_EFFECT_KINDS = ["particles", "trail", "impact", "flash", "glow"] as const;
export type BoardEffectKind = (typeof BOARD_EFFECT_KINDS)[number];

export const BOARD_EFFECT_KIND_INFO = {
	particles: {
		description: "Continuous particles emitted inside the effect frame.",
		parameters: {
			rate: "Particles per second.",
			life: "Particle lifetime in milliseconds.",
			particleSize: "Particle size in board units.",
			speed: "Particle speed in board units per second.",
			direction: "Emission direction in degrees.",
			spread: "Emission spread in degrees.",
			gravity: "Acceleration in board units per second squared.",
			intensity: "Opacity and size multiplier.",
			seed: "Stable seed for repeatable particle motion.",
		},
	},
	trail: {
		description: "A fading trail following another item.",
		parameters: {
			follow: "ID of the item to follow.",
			life: "Trail lifetime in milliseconds.",
			particleSize: "Trail width in board units.",
			intensity: "Opacity multiplier.",
		},
	},
	impact: {
		description: "A repeating radial burst centered in the effect frame.",
		parameters: {
			rate: "Particles per burst.",
			life: "Time between bursts in milliseconds.",
			particleSize: "Particle and ring size in board units.",
			speed: "Particle speed in board units per second.",
			direction: "Burst direction in degrees.",
			spread: "Burst spread in degrees.",
			gravity: "Acceleration in board units per second squared.",
			intensity: "Opacity multiplier.",
			seed: "Stable seed for repeatable bursts.",
		},
	},
	flash: {
		description: "A repeating full-frame flash.",
		parameters: {
			life: "Time between flashes in milliseconds.",
			intensity: "Flash opacity multiplier.",
		},
	},
	glow: {
		description: "A pulsing set of concentric rings.",
		parameters: {
			life: "Pulse period in milliseconds.",
			intensity: "Glow opacity multiplier.",
		},
	},
} satisfies Record<BoardEffectKind, { description: string; parameters: Record<string, string> }>;

export const BoardEffectItemSchema = z
	.object({
		...boxed(BOARD_DEFAULT_SIZES.effect),
		type: z.literal("effect"),
		props: z
			.object({
				kind: z.enum(BOARD_EFFECT_KINDS),
				rate: nonNegative.max(20_000).default(40),
				life: finite.positive().max(60_000).default(1_200),
				particleSize: finite.positive().max(512).default(6),
				speed: nonNegative.max(10_000).default(120),
				direction: finite.default(-90),
				spread: finite.min(0).max(360).default(360),
				gravity: finite.default(0),
				intensity: nonNegative.max(10).default(1),
				follow: BoardIdSchema.optional().describe("trail: the item to follow."),
				seed: z.string().min(1).max(160).optional().describe("Makes procedural motion repeatable."),
			})
			.strict(),
	})
	.strict();

export const BoardCustomItemSchema = z
	.object({
		...boxed(BOARD_DEFAULT_SIZES.custom),
		type: z.literal("custom"),
		script: BoardScriptSchema,
		props: z.object({}).strict().default({}),
	})
	.strict();

export const BOARD_EXTENSION_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/;
export const BoardExtensionItemSchema = z
	.object({
		...boxed(BOARD_DEFAULT_ITEM_SIZE),
		type: z.string().regex(BOARD_EXTENSION_TYPE_PATTERN),
		props: z.record(z.string(), z.unknown()).default({}),
	})
	.strict();

export const BOARD_ITEM_SCHEMAS = {
	frame: BoardFrameItemSchema,
	text: BoardTextItemSchema,
	shape: BoardShapeItemSchema,
	draw: BoardDrawItemSchema,
	arrow: BoardArrowItemSchema,
	image: BoardImageItemSchema,
	video: BoardVideoItemSchema,
	audio: BoardAudioItemSchema,
	file: BoardFileItemSchema,
	task: BoardTaskItemSchema,
	effect: BoardEffectItemSchema,
	custom: BoardCustomItemSchema,
} as const;
export type BoardBuiltinItemType = keyof typeof BOARD_ITEM_SCHEMAS;
export const BOARD_ITEM_TYPES = Object.keys(BOARD_ITEM_SCHEMAS) as BoardBuiltinItemType[];

export type BoardFrameItem = z.infer<typeof BoardFrameItemSchema>;
export type BoardTextItem = z.infer<typeof BoardTextItemSchema>;
export type BoardShapeItem = z.infer<typeof BoardShapeItemSchema>;
export type BoardDrawItem = z.infer<typeof BoardDrawItemSchema>;
export type BoardArrowItem = z.infer<typeof BoardArrowItemSchema>;
export type BoardImageItem = z.infer<typeof BoardImageItemSchema>;
export type BoardVideoItem = z.infer<typeof BoardVideoItemSchema>;
export type BoardAudioItem = z.infer<typeof BoardAudioItemSchema>;
export type BoardFileItem = z.infer<typeof BoardFileItemSchema>;
export type BoardTaskItem = z.infer<typeof BoardTaskItemSchema>;
export type BoardEffectItem = z.infer<typeof BoardEffectItemSchema>;
export type BoardCustomItem = z.infer<typeof BoardCustomItemSchema>;
export type BoardExtensionItem = Omit<z.infer<typeof BoardExtensionItemSchema>, "type"> & { type: `${string}.${string}` };
export type BoardBuiltinItem =
	| BoardFrameItem
	| BoardTextItem
	| BoardShapeItem
	| BoardDrawItem
	| BoardArrowItem
	| BoardImageItem
	| BoardVideoItem
	| BoardAudioItem
	| BoardFileItem
	| BoardTaskItem
	| BoardEffectItem
	| BoardCustomItem;
export type BoardItem = BoardBuiltinItem | BoardExtensionItem;
export type BoardItemType = BoardItem["type"];
export type BoardFileBackedItem =
	| BoardImageItem
	| BoardVideoItem
	| BoardAudioItem
	| BoardFileItem;

export function isBuiltinItemType(type: string): type is BoardBuiltinItemType {
	return Object.hasOwn(BOARD_ITEM_SCHEMAS, type);
}

export function isBuiltinItem(item: BoardItem): item is BoardBuiltinItem {
	return isBuiltinItemType(item.type);
}

export function isFileBackedItem(item: BoardItem): item is BoardFileBackedItem {
	return item.type === "image" || item.type === "video" || item.type === "audio" || item.type === "file";
}

export function isMediaItem(item: BoardItem): item is BoardImageItem | BoardVideoItem | BoardAudioItem {
	return item.type === "image" || item.type === "video" || item.type === "audio";
}

export const BOARD_DERIVED_SIZE_TYPES = ["text", "draw", "arrow"] as const;
export function hasAuthoredSize(type: string): boolean {
	return !(BOARD_DERIVED_SIZE_TYPES as readonly string[]).includes(type);
}

export function boardItemSchema(type: string): z.ZodType<BoardItem> | null {
	if (isBuiltinItemType(type)) return BOARD_ITEM_SCHEMAS[type] as unknown as z.ZodType<BoardItem>;
	return BOARD_EXTENSION_TYPE_PATTERN.test(type)
		? (BoardExtensionItemSchema as unknown as z.ZodType<BoardItem>)
		: null;
}

export type BoardDiagnostic = {
	severity: "error" | "warning";
	code: string;
	path: string;
	message: string;
};

function issuesToDiagnostics(error: z.ZodError, path: string): BoardDiagnostic[] {
	return error.issues.map((issue) => {
		const full = [path, ...issue.path.map(String)].filter(Boolean).join(".");
		const message =
			issue.code === "unrecognized_keys"
				? `unknown ${issue.keys.length === 1 ? "property" : "properties"} ${issue.keys.join(", ")}`
				: issue.message;
		return { severity: "error", code: "INVALID_ITEM", path: full, message };
	});
}

export function parseBoardItem(
	value: unknown,
	path = "item",
): { ok: true; item: BoardItem } | { ok: false; diagnostics: BoardDiagnostic[] } {
	const type =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>).type
			: undefined;
	if (typeof type !== "string") {
		return {
			ok: false,
			diagnostics: [{ severity: "error", code: "INVALID_ITEM", path: `${path}.type`, message: "type is required" }],
		};
	}
	const schema = boardItemSchema(type);
	if (!schema) {
		return {
			ok: false,
			diagnostics: [{
				severity: "error",
				code: "INVALID_ITEM",
				path: `${path}.type`,
				message: `unknown type ${type}; expected ${BOARD_ITEM_TYPES.join(", ")} or a namespaced extension type`,
			}],
		};
	}
	const parsed = schema.safeParse(value);
	return parsed.success
		? { ok: true, item: parsed.data }
		: { ok: false, diagnostics: issuesToDiagnostics(parsed.error, path) };
}


const CSS_EASE_KEYWORDS = new Set([
	"linear",
	"ease",
	"ease-in",
	"ease-out",
	"ease-in-out",
	"step-start",
	"step-end",
]);
export function isBoardEase(value: string): boolean {
	const ease = value.trim();
	if (CSS_EASE_KEYWORDS.has(ease)) return true;
	const bezier = /^cubic-bezier\(\s*([^,()]+),\s*([^,()]+),\s*([^,()]+),\s*([^,()]+)\)$/.exec(ease);
	if (bezier) {
		const [x1, , x2] = bezier.slice(1).map(Number);
		return bezier.slice(1).every((part) => Number.isFinite(Number(part))) &&
			(x1 as number) >= 0 && (x1 as number) <= 1 && (x2 as number) >= 0 && (x2 as number) <= 1;
	}
	return /^steps\(\s*[1-9]\d*\s*(?:,\s*(?:start|end|jump-start|jump-end|jump-none|jump-both)\s*)?\)$/.test(ease);
}
export const BoardEaseSchema = z
	.string()
	.max(120)
	.refine(isBoardEase, "expected a CSS easing: linear, ease-in-out, cubic-bezier(…) or steps(…)");

export const BoardKeyframeSchema = z
	.object({
		at: nonNegative.describe("Time in milliseconds."),
		value: z.unknown(),
		ease: BoardEaseSchema.optional().describe("Easing into this keyframe: a CSS keyword, cubic-bezier() or steps(); defaults to linear."),
	})
	.strict();
export type BoardKeyframe = z.infer<typeof BoardKeyframeSchema>;

export const BoardTrackSchema = z
	.object({
		target: z.string().min(1).max(BOARD_ID_MAX_LENGTH).describe("An item id, camera, or another animation id (its time property nests that timeline)."),
		property: z.string().min(1).max(200).describe("JSON path in the target, e.g. position, opacity, style.fill, props.text."),
		keyframes: z.array(BoardKeyframeSchema).min(1).max(100_000).describe("Ordered by at. The value holds before the first and after the last keyframe."),
		composite: z.enum(["replace", "add"]).default("replace").describe("replace: the latest-started track wins. add: positions and rotations add; scale and opacity multiply."),
		interpolation: z.enum(["auto", "step", "spline"]).default("auto").describe("auto blends numbers, vectors and colors and steps other values; spline smooths position paths."),
		orient: z.boolean().optional().describe("Rotate the item along its path."),
	})
	.strict()
	.superRefine((track, context) => {
		for (let index = 1; index < track.keyframes.length; index += 1) {
			if ((track.keyframes[index]?.at ?? 0) < (track.keyframes[index - 1]?.at ?? 0)) {
				context.addIssue({ code: "custom", message: "keyframes must be ordered by at", path: ["keyframes", index, "at"] });
			}
		}
	});
export type BoardTrack = z.infer<typeof BoardTrackSchema>;

export const BoardMarkerSchema = z
	.object({
		at: nonNegative,
		label: z.string().max(280).optional(),
		pause: z.boolean().optional().describe("Hold shared playback here until next."),
	})
	.strict();
export type BoardMarker = z.infer<typeof BoardMarkerSchema>;

export const BOARD_PLAY_MODES = ["manual", "auto", "always"] as const;
export type BoardPlayMode = (typeof BOARD_PLAY_MODES)[number];

export const BoardAnimationHeaderSchema = z
	.object({
		name: z.string().max(280).optional(),
		duration: finite.positive().max(24 * 60 * 60 * 1000).describe("Milliseconds; a new animation without it ends at its last keyframe."),
		play: z.enum(BOARD_PLAY_MODES).default("manual").describe("manual: only shared playback starts it. auto: plays when the Board opens. always: loops continuously."),
		delay: nonNegative.default(0),
		loop: z.boolean().default(false),
		end: z.enum(["hold", "reset"]).default("hold").describe("hold keeps the last frame; reset returns to the start."),
		markers: z.array(BoardMarkerSchema).max(10_000).default([]).describe("Labeled points on this timeline; a nested animation's markers do not carry over."),
	})
	.strict();
export type BoardAnimationHeader = z.infer<typeof BoardAnimationHeaderSchema>;

export const BoardAnimationSchema = BoardAnimationHeaderSchema.extend({
	tracks: z.record(BoardKeySchema, BoardTrackSchema).default({}),
}).strict();
export type BoardAnimation = z.infer<typeof BoardAnimationSchema>;


export const BOARD_ENTER_PRESETS = ["fade-in", "rise", "drop", "pop", "deal"] as const;
export type BoardEnterPreset = (typeof BOARD_ENTER_PRESETS)[number];

export const BoardBackgroundSchema = z
	.object({
		kind: z.enum(["solid", "dots", "grid", "image"]).default("dots"),
		color: BoardColorSchema.optional(),
		imageUrl: z.string().url().max(4096).optional().describe("Background image for kind image."),
		fit: z.enum(["cover", "contain", "repeat"]).optional(),
		opacity: ratio.optional(),
	})
	.strict();

export const BOARD_GRID_MIN_SIZE = 4;
export const BOARD_GRID_MAX_SIZE = 512;
export const BOARD_GRID_DEFAULT_SIZE = 24;

export const BoardSettingsSchema = z
	.object({
		title: z.string().min(1).max(255).optional(),
		background: BoardBackgroundSchema.default({ kind: "dots" }),
		grid: z
			.object({
				visible: z.boolean().default(false).describe("Show the grid overlay."),
				size: finite.min(BOARD_GRID_MIN_SIZE).max(BOARD_GRID_MAX_SIZE).default(BOARD_GRID_DEFAULT_SIZE),
			})
			.strict()
			.optional(),
		enter: z
			.object({
				preset: z.enum(BOARD_ENTER_PRESETS),
				duration: finite.positive().max(10_000).optional(),
			})
			.strict()
			.optional()
			.describe("Motion for items as they are added."),
	})
	.strict();
export type BoardSettings = z.infer<typeof BoardSettingsSchema>;


export type BoardDocument = {
	board: BoardSettings;
	items: Record<string, BoardItem>;
	animations: Record<string, BoardAnimation>;
};

export function emptyBoardDocument(): BoardDocument {
	return { board: BoardSettingsSchema.parse({}), items: {}, animations: {} };
}

export type BoardPatch = {
	board?: Record<string, unknown> | null;
	items?: Record<string, Record<string, unknown> | null>;
	animations?: Record<string, (Record<string, unknown> & { tracks?: Record<string, Record<string, unknown> | null> }) | null>;
};

const patchObject = z.record(z.string(), z.unknown());
export const BoardPatchSchema = z
	.object({
		board: patchObject.nullable().optional(),
		items: z.record(BoardIdSchema, patchObject.nullable()).optional(),
		animations: z
			.record(
				BoardIdSchema,
				patchObject
					.and(z.object({ tracks: z.record(BoardKeySchema, patchObject.nullable()).optional() }))
					.nullable(),
			)
			.optional(),
	})
	.strict();

export type BoardDelta = {
	board?: BoardSettings;
	items?: Record<string, BoardItem | null>;
	animations?: Record<string, BoardAnimationHeader | null>;
	tracks?: Record<string, Record<string, BoardTrack | null>>;
};

export function isEmptyBoardDelta(delta: BoardDelta): boolean {
	return (
		!delta.board &&
		Object.keys(delta.items ?? {}).length === 0 &&
		Object.keys(delta.animations ?? {}).length === 0 &&
		Object.keys(delta.tracks ?? {}).length === 0
	);
}
