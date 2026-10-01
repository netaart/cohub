
import { z } from "zod";
import { boardJsonEquals } from "./board-json.js";
import { applyMatrix, arrowBindings, createBoardLayout, invertMatrix, isArrowBinding } from "./board-layout.js";
import {
	BOARD_CAMERA_TARGET,
	type BoardAnimationHeader,
	BoardAnimationHeaderSchema,
	type BoardArrowItem,
	BoardColorSchema,
	type BoardDelta,
	type BoardDiagnostic,
	type BoardDocument,
	type BoardItem,
	BoardPatchSchema,
	type BoardPatch,
	type BoardSettings,
	BoardSettingsSchema,
	type BoardTrack,
	BoardTrackSchema,
	BoardVec2Schema,
	type BoardVec2,
	boardItemSchema,
	isBuiltinItemType,
	parseBoardItem,
} from "./board-model.js";


type JsonRecord = Record<string, unknown>;

function slot<T>(map: Record<string, Record<string, T>>, key: string): Record<string, T> {
	let value = map[key];
	if (!value) {
		value = {};
		map[key] = value;
	}
	return value;
}

function emptyDelta(): BoardDelta & Required<Pick<BoardDelta, "items" | "animations" | "tracks">> {
	return { items: {}, animations: {}, tracks: {} };
}

function withoutEmpty<T extends object>(value: T): T {
	for (const [key, entry] of Object.entries(value)) {
		if (entry === undefined || (isRecord(entry) && Object.keys(entry).length === 0)) delete (value as JsonRecord)[key];
	}
	return value;
}

function isRecord(value: unknown): value is JsonRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergePatch(target: unknown, patch: unknown): unknown {
	if (!isRecord(patch)) return patch;
	const result: JsonRecord = isRecord(target) ? { ...target } : {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete result[key];
		else result[key] = mergePatch(result[key], value);
	}
	return result;
}

export function diffMergePatch(before: unknown, after: unknown): unknown {
	if (boardJsonEquals(before, after)) return undefined;
	if (after === undefined) return null;
	if (!isRecord(before) || !isRecord(after)) return after;
	const patch: JsonRecord = {};
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const value = diffMergePatch(before[key], after[key]);
		if (value !== undefined) patch[key] = value;
	}
	return patch;
}


type AnyZod = z.ZodType & { _zod: { def: JsonRecord } };

function def(schema: unknown): JsonRecord {
	return (schema as AnyZod)._zod.def;
}

function unwrap(schema: unknown): unknown {
	let current = schema;
	for (let guard = 0; guard < 16; guard += 1) {
		const d = def(current);
		if (d.type === "optional" || d.type === "default" || d.type === "nullable" || d.type === "readonly" || d.type === "prefault") current = d.innerType;
		else if (d.type === "pipe") current = d.in;
		else return current;
	}
	return current;
}

function unwrapObjectShape(schema: unknown): Record<string, unknown> | null {
	const inner = unwrap(schema);
	const d = def(inner);
	return d.type === "object" ? (d.shape as Record<string, unknown>) : null;
}

function schemaAtPath(schema: unknown, path: readonly string[]): unknown {
	let current = schema;
	for (const segment of path) {
		const inner = unwrap(current);
		const d = def(inner);
		if (d.type === "object") {
			const shape = d.shape as Record<string, unknown>;
			if (!Object.hasOwn(shape, segment)) return null;
			current = shape[segment];
		} else if (d.type === "record") current = d.valueType;
		else if (d.type === "union") {
			const branch = (d.options as unknown[]).find((option) => unwrapObjectShape(option)?.[segment]);
			if (!branch) return null;
			current = (unwrapObjectShape(branch) as Record<string, unknown>)[segment];
		} else return null;
	}
	return current;
}


export type BoardValueKind = "number" | "vec2" | "scale" | "color" | "discrete";

export type BoardPropertySpec = {
	kind: BoardValueKind;
	schema: z.ZodType;
	multiplicative?: boolean;
};

const NOT_ANIMATABLE = new Set(["type", "parent", "z", "locked", "metadata"]);

const CAMERA_PROPERTIES: Record<string, BoardPropertySpec> = {
	focus: {
		kind: "discrete",
		schema: z.union([
			z.string().min(1),
			z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().positive(), height: z.number().finite().positive() }).strict(),
		]),
	},
	zoom: { kind: "number", schema: z.number().finite().positive(), multiplicative: true },
	center: { kind: "vec2", schema: BoardVec2Schema },
	shake: { kind: "number", schema: z.number().finite().nonnegative() },
};

const ANIMATION_PROPERTIES: Record<string, BoardPropertySpec> = {
	time: { kind: "number", schema: z.number().finite().nonnegative() },
};

function kindOf(schema: unknown, path: readonly string[]): BoardValueKind {
	const leaf = path[path.length - 1];
	if (path.length === 1 && leaf === "scale") return "scale";
	if (schema === BoardColorSchema || unwrap(schema) === BoardColorSchema) return "color";
	const d = def(unwrap(schema));
	if (d.type === "number") return "number";
	const shape = unwrapObjectShape(schema);
	if (shape && Object.keys(shape).length === 2 && "x" in shape && "y" in shape) return "vec2";
	return "discrete";
}

export function resolveBoardProperty(
	targetType: string,
	property: string,
): { ok: true; spec: BoardPropertySpec } | { ok: false; message: string } {
	if (targetType === BOARD_CAMERA_TARGET) {
		const spec = CAMERA_PROPERTIES[property];
		return spec ? { ok: true, spec } : { ok: false, message: `camera has no property ${property}; expected ${Object.keys(CAMERA_PROPERTIES).join(", ")}` };
	}
	if (targetType === "animation") {
		const spec = ANIMATION_PROPERTIES[property];
		return spec ? { ok: true, spec } : { ok: false, message: `animations are driven through time` };
	}
	const path = property.split(".");
	if (path.some((segment) => !segment) || NOT_ANIMATABLE.has(path[0] as string)) {
		return { ok: false, message: `${property} cannot be animated` };
	}
	const schema = boardItemSchema(targetType);
	if (!schema) return { ok: false, message: `unknown item type ${targetType}` };
	if (!isBuiltinItemType(targetType) && path[0] === "props") {
		return { ok: true, spec: { kind: "discrete", schema: z.unknown() } };
	}
	const leaf = schemaAtPath(schema, path);
	if (!leaf) return { ok: false, message: `${targetType} has no property ${property}` };
	const kind = kindOf(leaf, path);
	return {
		ok: true,
		spec: {
			kind,
			schema: unwrap(leaf) as z.ZodType,
			...(property === "opacity" || kind === "scale" ? { multiplicative: true } : {}),
		},
	};
}

export function listBoardProperties(targetType: string): Array<{ property: string; kind: BoardValueKind }> {
	if (targetType === BOARD_CAMERA_TARGET) return Object.entries(CAMERA_PROPERTIES).map(([property, spec]) => ({ property, kind: spec.kind }));
	if (targetType === "animation") return [{ property: "time", kind: "number" }];
	const schema = boardItemSchema(targetType);
	const shape = schema ? unwrapObjectShape(schema) : null;
	const result: Array<{ property: string; kind: BoardValueKind }> = [];
	const visit = (field: unknown, path: string[]) => {
		const kind = kindOf(field, path);
		if (kind !== "discrete") {
			result.push({ property: path.join("."), kind });
			if (kind === "vec2" || kind === "scale") return;
		}
		const nested = unwrapObjectShape(field);
		if (nested && kind !== "color") {
			for (const [key, child] of Object.entries(nested)) visit(child, [...path, key]);
		} else if (kind === "discrete") result.push({ property: path.join("."), kind });
	};
	for (const [key, field] of Object.entries(shape ?? {})) {
		if (NOT_ANIMATABLE.has(key) || key === "type") continue;
		visit(field, [key]);
	}
	return result;
}

function lastKeyframeAt(trackPatches: Iterable<JsonRecord | null | undefined>): number | undefined {
	let end = 0;
	for (const track of trackPatches) {
		const keyframes = track?.keyframes;
		if (!Array.isArray(keyframes)) continue;
		for (const keyframe of keyframes) {
			const at = (keyframe as JsonRecord | null)?.at;
			if (typeof at === "number" && Number.isFinite(at)) end = Math.max(end, at);
		}
	}
	return end > 0 ? end : undefined;
}


export type BoardState = {
	settings(): BoardSettings;
	item(id: string): BoardItem | undefined;
	animation(id: string): BoardAnimationHeader | undefined;
	track(animationId: string, trackId: string): BoardTrack | undefined;
	trackIds(animationId: string): string[];
	children(id: string): string[];
	binders(id: string): string[];
	trackRefs(id: string): Array<{ animation: string; track: string }>;
	maxZ(parent: string | undefined): number;
};

export function trackReferences(track: BoardTrack): string[] {
	const refs = new Set<string>([track.target]);
	if (track.target === BOARD_CAMERA_TARGET && track.property === "focus") {
		for (const keyframe of track.keyframes) if (typeof keyframe.value === "string") refs.add(keyframe.value);
	}
	refs.delete(BOARD_CAMERA_TARGET);
	return [...refs];
}

export function pruneBoardTrack(track: BoardTrack, deleted: ReadonlySet<string>): BoardTrack | null {
	if (deleted.has(track.target)) return null;
	if (track.target !== BOARD_CAMERA_TARGET || track.property !== "focus") return track;
	const keyframes = track.keyframes.filter((entry) => typeof entry.value !== "string" || !deleted.has(entry.value));
	if (keyframes.length === track.keyframes.length) return track;
	return keyframes.length ? { ...track, keyframes } : null;
}

export function boardPatchTouches(patch: BoardPatch): {
	items: string[];
	animations: string[];
	tracks: Array<{ animation: string; track: string }>;
	deletedItems: string[];
	deletedAnimations: string[];
	parents: string[];
	references: string[];
} {
	const items = new Set<string>();
	const deletedItems: string[] = [];
	const parents = new Set<string>();
	const references = new Set<string>();
	for (const [id, value] of Object.entries(patch.items ?? {})) {
		items.add(id);
		if (value === null) {
			deletedItems.push(id);
			continue;
		}
		if (typeof value.parent === "string") parents.add(value.parent);
		const props = isRecord(value.props) ? value.props : null;
		for (const end of [props?.start, props?.end]) {
			if (isRecord(end) && typeof end.item === "string") references.add(end.item);
		}
	}
	const animations = new Set<string>();
	const deletedAnimations: string[] = [];
	const tracks: Array<{ animation: string; track: string }> = [];
	for (const [id, value] of Object.entries(patch.animations ?? {})) {
		animations.add(id);
		if (value === null) {
			deletedAnimations.push(id);
			continue;
		}
		for (const [trackId, track] of Object.entries(value.tracks ?? {})) {
			tracks.push({ animation: id, track: trackId });
			if (!isRecord(track)) continue;
			if (typeof track.target === "string") references.add(track.target);
			if (Array.isArray(track.keyframes)) {
				for (const keyframe of track.keyframes) {
					if (isRecord(keyframe) && typeof keyframe.value === "string") references.add(keyframe.value);
				}
			}
		}
	}
	references.delete(BOARD_CAMERA_TARGET);
	return {
		items: [...items],
		animations: [...animations],
		tracks,
		deletedItems,
		deletedAnimations,
		parents: [...parents],
		references: [...references],
	};
}

export type BoardApplyOptions = {
	cascade?: boolean;
	resolveArrowEnd?: (arrowId: string, which: "start" | "end") => BoardVec2;
};

export type BoardPatchResult =
	| { ok: true; before: BoardDelta; after: BoardDelta; diagnostics: BoardDiagnostic[] }
	| { ok: false; diagnostics: BoardDiagnostic[] };

function error(path: string, code: string, message: string): BoardDiagnostic {
	return { severity: "error", code, path, message };
}

function stripId(value: JsonRecord): JsonRecord {
	if (!("id" in value)) return value;
	const { id: _id, ...rest } = value;
	return rest;
}

export function applyBoardPatch(
	state: BoardState,
	input: BoardPatch,
	options: BoardApplyOptions = {},
): BoardPatchResult {
	const parsedPatch = BoardPatchSchema.safeParse(input);
	if (!parsedPatch.success) {
		return {
			ok: false,
			diagnostics: parsedPatch.error.issues.map((issue) =>
				error(issue.path.map(String).join("."), "INVALID_PATCH", issue.message),
			),
		};
	}
	const patch = parsedPatch.data as BoardPatch;
	const diagnostics: BoardDiagnostic[] = [];
	const nextItems = new Map<string, BoardItem | null>();
	const nextAnimations = new Map<string, BoardAnimationHeader | null>();
	const nextTracks = new Map<string, Map<string, BoardTrack | null>>();
	let nextSettings: BoardSettings | undefined;

	const item = (id: string) => (nextItems.has(id) ? (nextItems.get(id) ?? undefined) : state.item(id));
	const animation = (id: string) => (nextAnimations.has(id) ? (nextAnimations.get(id) ?? undefined) : state.animation(id));
	const setTrack = (animationId: string, trackId: string, value: BoardTrack | null) => {
		const tracks = nextTracks.get(animationId) ?? new Map<string, BoardTrack | null>();
		tracks.set(trackId, value);
		nextTracks.set(animationId, tracks);
	};
	const track = (animationId: string, trackId: string) => {
		const pending = nextTracks.get(animationId);
		if (pending?.has(trackId)) return pending.get(trackId) ?? undefined;
		return state.track(animationId, trackId);
	};

	if (patch.board !== undefined) {
		const merged = patch.board === null ? {} : mergePatch(state.settings(), patch.board);
		const parsed = BoardSettingsSchema.safeParse(merged);
		if (parsed.success) nextSettings = parsed.data;
		else for (const issue of parsed.error.issues) diagnostics.push(error(["board", ...issue.path.map(String)].join("."), "INVALID_BOARD", issue.message));
	}

	const zByParent = new Map<string, number>();
	for (const [id, value] of Object.entries(patch.items ?? {})) {
		if (value === null) {
			if (state.item(id)) nextItems.set(id, null);
			continue;
		}
		const current = state.item(id);
		const body = stripId(value);
		const replacing = !current || (typeof body.type === "string" && body.type !== current.type);
		const candidate = replacing ? { ...body } : (mergePatch(current, body) as JsonRecord);
		if (candidate.z === undefined) {
			const parent = typeof candidate.parent === "string" ? candidate.parent : undefined;
			const key = parent ?? "";
			const top = zByParent.get(key) ?? state.maxZ(parent);
			candidate.z = current?.z ?? top + 1;
			if (!current) zByParent.set(key, top + 1);
		}
		const parsed = parseBoardItem(candidate, `items.${id}`);
		if (!parsed.ok) {
			diagnostics.push(...parsed.diagnostics);
			continue;
		}
		if (current && boardJsonEquals(current, parsed.item)) continue;
		nextItems.set(id, parsed.item);
	}

	for (const [id, value] of Object.entries(patch.animations ?? {})) {
		if (value === null) {
			if (!state.animation(id)) continue;
			nextAnimations.set(id, null);
			for (const trackId of state.trackIds(id)) setTrack(id, trackId, null);
			continue;
		}
		const { tracks, ...headerPatch } = stripId(value) as JsonRecord & { tracks?: Record<string, JsonRecord | null> };
		if (state.item(id) || nextItems.get(id)) {
			diagnostics.push(error(`animations.${id}`, "ID_CONFLICT", `${id} is already an item id`));
			continue;
		}
		const current = state.animation(id);
		if (!current || Object.keys(headerPatch).length > 0) {
			const header = current
				? mergePatch(current, headerPatch)
				: { ...headerPatch, ...(headerPatch.duration === undefined ? { duration: lastKeyframeAt([...Object.values(tracks ?? {}), ...state.trackIds(id).map((trackId) => state.track(id, trackId) as JsonRecord | undefined)]) } : {}) };
			const parsed = BoardAnimationHeaderSchema.safeParse(header);
			if (!parsed.success) {
				for (const issue of parsed.error.issues) diagnostics.push(error(["animations", id, ...issue.path.map(String)].join("."), "INVALID_ANIMATION", issue.message));
				continue;
			}
			if (!current || !boardJsonEquals(current, parsed.data)) nextAnimations.set(id, parsed.data);
		}
		for (const [trackId, trackPatch] of Object.entries(tracks ?? {})) {
			const existing = state.track(id, trackId);
			if (trackPatch === null) {
				if (existing) setTrack(id, trackId, null);
				continue;
			}
			const parsed = BoardTrackSchema.safeParse(existing ? mergePatch(existing, trackPatch) : trackPatch);
			if (!parsed.success) {
				for (const issue of parsed.error.issues) diagnostics.push(error(["animations", id, "tracks", trackId, ...issue.path.map(String)].join("."), "INVALID_TRACK", issue.message));
				continue;
			}
			if (!existing || !boardJsonEquals(existing, parsed.data)) setTrack(id, trackId, parsed.data);
		}
	}
	for (const id of nextItems.keys()) {
		if (nextItems.get(id) && animation(id)) diagnostics.push(error(`items.${id}`, "ID_CONFLICT", `${id} is already an animation id`));
	}
	if (diagnostics.length) return { ok: false, diagnostics };

	const deletedItems = [...nextItems].filter(([, value]) => value === null).map(([id]) => id);
	const deletionLayout = createBoardLayout((id) => item(id) ?? state.item(id));
	const pendingDeletes = [...deletedItems];
	while (pendingDeletes.length) {
		const id = pendingDeletes.pop() as string;
		for (const child of state.children(id)) {
			if (nextItems.has(child) && nextItems.get(child)?.parent !== id) continue;
			if (options.cascade) {
				if (nextItems.get(child) !== null) {
					nextItems.set(child, null);
					pendingDeletes.push(child);
				}
			} else diagnostics.push(error(`items.${id}`, "ITEM_REFERENCED", `${id} still has child ${child}; delete it too or use cascade`));
		}
		for (const arrowId of state.binders(id)) {
			const arrow = item(arrowId);
			if (arrow?.type !== "arrow") continue;
			const props = { ...(arrow as BoardArrowItem).props };
			for (const which of ["start", "end"] as const) {
				const end = props[which];
				if (!isArrowBinding(end) || end.item !== id) continue;
				const world = options.resolveArrowEnd?.(arrowId, which) ?? deletionLayout.arrowEnd(arrowId, which);
				props[which] = applyMatrix(invertMatrix(deletionLayout.matrix(arrowId)), world);
			}
			nextItems.set(arrowId, { ...arrow, props } as BoardItem);
		}
		for (const ref of state.trackRefs(id)) {
			const current = track(ref.animation, ref.track);
			if (!current || !trackReferences(current).includes(id)) continue;
			if (options.cascade) setTrack(ref.animation, ref.track, pruneBoardTrack(current, new Set([id])));
			else diagnostics.push(error(`items.${id}`, "ITEM_REFERENCED", `${id} is animated by ${ref.animation}.${ref.track}; delete the track or use cascade`));
		}
	}
	for (const [id, value] of nextAnimations) {
		if (value !== null) continue;
		for (const ref of state.trackRefs(id)) {
			if (ref.animation === id || track(ref.animation, ref.track) === undefined) continue;
			if (options.cascade) setTrack(ref.animation, ref.track, null);
			else diagnostics.push(error(`animations.${id}`, "ANIMATION_REFERENCED", `${id} is nested in ${ref.animation}.${ref.track}; delete the track or use cascade`));
		}
	}

	const validationState: BoardState = {
		...state,
		trackIds: (id) => [...new Set([...state.trackIds(id), ...(nextTracks.get(id)?.keys() ?? [])])],
	};

	const validationItems = new Map(nextItems);
	const descendants: string[] = [];
	for (const [id, value] of nextItems) {
		if (value && value.parent !== state.item(id)?.parent) descendants.push(...state.children(id));
	}
	const seenDescendants = new Set<string>();
	while (descendants.length) {
		const id = descendants.pop() as string;
		if (seenDescendants.has(id)) continue;
		seenDescendants.add(id);
		validationItems.set(id, item(id) ?? null);
		descendants.push(...state.children(id));
	}
	for (const [id, value] of validationItems) {
		if (!value) continue;
		if (value.parent !== undefined) {
			const parent = item(value.parent);
			if (!parent) diagnostics.push(error(`items.${id}.parent`, "PARENT_NOT_FOUND", `parent ${value.parent} does not exist`));
			else if (parent.type !== "frame") diagnostics.push(error(`items.${id}.parent`, "INVALID_PARENT", `parent ${value.parent} is a ${parent.type}; only frames contain items`));
			else {
				let cursor: string | undefined = value.parent;
				for (let depth = 0; cursor; depth += 1) {
					if (depth >= 64) {
						diagnostics.push(error(`items.${id}.parent`, "PARENT_DEPTH", "parent hierarchy exceeds 64 levels"));
						break;
					}
					if (cursor === id) {
						diagnostics.push(error(`items.${id}.parent`, "PARENT_CYCLE", `${id} cannot be inside itself`));
						break;
					}
					cursor = item(cursor)?.parent;
				}
			}
		}
		for (const bound of arrowBindings(value)) {
			const target = item(bound);
			if (!target) diagnostics.push(error(`items.${id}.props`, "BINDING_NOT_FOUND", `bound item ${bound} does not exist`));
			else if (bound === id || target.type === "arrow") diagnostics.push(error(`items.${id}.props`, "INVALID_BINDING", "arrows bind to items other than arrows"));
		}
	}
	for (const [id, value] of nextItems) {
		if (!value || !state.item(id) || state.item(id)?.type === value.type) continue;
		if (value.type !== "frame") {
			for (const child of state.children(id)) {
				if (item(child)?.parent === id) diagnostics.push(error(`items.${child}.parent`, "INVALID_PARENT", `${id} is not a frame`));
			}
		}
		if (value.type === "arrow") {
			for (const binder of state.binders(id)) {
				const arrow = item(binder);
				if (arrow && arrowBindings(arrow).includes(id)) diagnostics.push(error(`items.${binder}.props`, "INVALID_BINDING", "arrows cannot bind to arrows"));
			}
		}
		for (const ref of state.trackRefs(id)) {
			const current = track(ref.animation, ref.track);
			if (current) diagnostics.push(...validateTrack(`animations.${ref.animation}.tracks.${ref.track}`, ref.animation, current, item, animation, track, validationState));
		}
	}
	for (const [animationId, tracks] of nextTracks) {
		if (!animation(animationId)) {
			for (const [trackId, value] of tracks) if (value) diagnostics.push(error(`animations.${animationId}.tracks.${trackId}`, "ANIMATION_NOT_FOUND", `animation ${animationId} does not exist`));
			continue;
		}
		for (const [trackId, value] of tracks) {
			if (!value) continue;
			diagnostics.push(...validateTrack(`animations.${animationId}.tracks.${trackId}`, animationId, value, item, animation, track, validationState));
		}
	}
	if (diagnostics.length) return { ok: false, diagnostics };

	const before = emptyDelta();
	const after = emptyDelta();
	if (nextSettings && !boardJsonEquals(nextSettings, state.settings())) {
		before.board = state.settings();
		after.board = nextSettings;
	}
	for (const [id, value] of nextItems) {
		const previous = state.item(id) ?? null;
		if (boardJsonEquals(previous, value)) continue;
		before.items[id] = previous;
		after.items[id] = value;
	}
	for (const [id, value] of nextAnimations) {
		before.animations[id] = state.animation(id) ?? null;
		after.animations[id] = value;
	}
	for (const [animationId, tracks] of nextTracks) {
		for (const [trackId, value] of tracks) {
			const previous = state.track(animationId, trackId) ?? null;
			if (boardJsonEquals(previous, value)) continue;
			slot(before.tracks, animationId)[trackId] = previous;
			slot(after.tracks, animationId)[trackId] = value;
		}
	}
	return { ok: true, before: withoutEmpty(before), after: withoutEmpty(after), diagnostics: [] };
}

function validateTrack(
	path: string,
	animationId: string,
	value: BoardTrack,
	item: (id: string) => BoardItem | undefined,
	animation: (id: string) => BoardAnimationHeader | undefined,
	track: (animationId: string, trackId: string) => BoardTrack | undefined,
	state: BoardState,
): BoardDiagnostic[] {
	const diagnostics: BoardDiagnostic[] = [];
	let targetType: string;
	if (value.target === BOARD_CAMERA_TARGET) targetType = BOARD_CAMERA_TARGET;
	else if (item(value.target)) targetType = (item(value.target) as BoardItem).type;
	else if (animation(value.target)) {
		targetType = "animation";
		if (value.target === animationId || nestsInto(value.target, animationId, animation, track, state)) {
			return [error(`${path}.target`, "ANIMATION_CYCLE", `${animationId} cannot contain itself through ${value.target}`)];
		}
	} else return [error(`${path}.target`, "TARGET_NOT_FOUND", `target ${value.target} is not an item, animation or camera`)];
	const resolved = resolveBoardProperty(targetType, value.property);
	if (!resolved.ok) return [error(`${path}.property`, "INVALID_PROPERTY", resolved.message)];
	for (const [index, keyframe] of value.keyframes.entries()) {
		const parsed = resolved.spec.schema.safeParse(keyframe.value);
		if (!parsed.success) {
			diagnostics.push(error(`${path}.keyframes.${index}.value`, "INVALID_KEYFRAME", parsed.error.issues[0]?.message ?? "invalid value"));
			continue;
		}
		if (value.property === "focus" && typeof keyframe.value === "string" && !item(keyframe.value)) {
			diagnostics.push(error(`${path}.keyframes.${index}.value`, "TARGET_NOT_FOUND", `focus item ${keyframe.value} does not exist`));
		}
	}
	if (value.interpolation === "spline" && resolved.spec.kind !== "vec2") {
		diagnostics.push(error(`${path}.interpolation`, "INVALID_TRACK", "spline interpolation needs a position-like property"));
	}
	return diagnostics;
}

function nestsInto(
	from: string,
	into: string,
	animation: (id: string) => BoardAnimationHeader | undefined,
	track: (animationId: string, trackId: string) => BoardTrack | undefined,
	state: BoardState,
): boolean {
	const seen = new Set<string>();
	const stack = [from];
	while (stack.length) {
		const current = stack.pop() as string;
		if (current === into) return true;
		if (seen.has(current) || !animation(current)) continue;
		seen.add(current);
		for (const trackId of state.trackIds(current)) {
			const value = track(current, trackId);
			if (value && value.property === "time" && animation(value.target)) stack.push(value.target);
		}
	}
	return false;
}


export function createDocumentState(document: BoardDocument): BoardState {
	let children: Map<string, string[]> | null = null;
	let binders: Map<string, string[]> | null = null;
	let refs: Map<string, Array<{ animation: string; track: string }>> | null = null;
	const index = () => {
		if (children) return;
		children = new Map();
		binders = new Map();
		refs = new Map();
		for (const [id, value] of Object.entries(document.items)) {
			if (value.parent) children.set(value.parent, [...(children.get(value.parent) ?? []), id]);
			for (const bound of arrowBindings(value)) binders.set(bound, [...(binders.get(bound) ?? []), id]);
		}
		for (const [animationId, value] of Object.entries(document.animations)) {
			for (const [trackId, track] of Object.entries(value.tracks)) {
				for (const ref of trackReferences(track)) refs.set(ref, [...(refs.get(ref) ?? []), { animation: animationId, track: trackId }]);
			}
		}
	};
	return {
		settings: () => document.board,
		item: (id) => document.items[id],
		animation: (id) => {
			const value = document.animations[id];
			if (!value) return undefined;
			const { tracks: _tracks, ...header } = value;
			return header;
		},
		track: (animationId, trackId) => document.animations[animationId]?.tracks[trackId],
		trackIds: (animationId) => Object.keys(document.animations[animationId]?.tracks ?? {}),
		children: (id) => {
			index();
			return children?.get(id) ?? [];
		},
		binders: (id) => {
			index();
			return binders?.get(id) ?? [];
		},
		trackRefs: (id) => {
			index();
			return refs?.get(id) ?? [];
		},
		maxZ: (parent) => {
			let max = 0;
			for (const value of Object.values(document.items)) {
				if (value.parent === parent && (value.z ?? 0) > max) max = value.z ?? 0;
			}
			return max;
		},
	};
}

export function applyBoardDelta(document: BoardDocument, delta: BoardDelta): BoardDocument {
	const items = delta.items ? { ...document.items } : document.items;
	for (const [id, value] of Object.entries(delta.items ?? {})) {
		if (value) items[id] = value;
		else delete items[id];
	}
	const animations = delta.animations || delta.tracks ? { ...document.animations } : document.animations;
	for (const [id, value] of Object.entries(delta.animations ?? {})) {
		if (value) animations[id] = { ...value, tracks: animations[id]?.tracks ?? {} };
		else delete animations[id];
	}
	for (const [animationId, tracks] of Object.entries(delta.tracks ?? {})) {
		const current = animations[animationId];
		if (!current) continue;
		const nextTracks = { ...current.tracks };
		for (const [trackId, value] of Object.entries(tracks)) {
			if (value) nextTracks[trackId] = value;
			else delete nextTracks[trackId];
		}
		animations[animationId] = { ...current, tracks: nextTracks };
	}
	return { board: delta.board ?? document.board, items, animations };
}

export function applyBoardPatchToDocument(
	document: BoardDocument,
	patch: BoardPatch,
	options: BoardApplyOptions = {},
): { ok: true; document: BoardDocument; before: BoardDelta; after: BoardDelta } | { ok: false; diagnostics: BoardDiagnostic[] } {
	const result = applyBoardPatch(createDocumentState(document), patch, options);
	return result.ok ? { ok: true, document: applyBoardDelta(document, result.after), before: result.before, after: result.after } : result;
}

export function diffBoardDocuments(before: BoardDocument, after: BoardDocument): BoardPatch {
	const items: NonNullable<BoardPatch["items"]> = {};
	for (const id of new Set([...Object.keys(before.items), ...Object.keys(after.items)])) {
		const previous = before.items[id];
		const next = after.items[id];
		if (previous === next) continue;
		const value = !next ? null : previous && previous.type === next.type ? diffMergePatch(previous, next) : next;
		if (value !== undefined) items[id] = value as JsonRecord | null;
	}
	const animations: NonNullable<BoardPatch["animations"]> = {};
	for (const id of new Set([...Object.keys(before.animations), ...Object.keys(after.animations)])) {
		const previous = before.animations[id];
		const next = after.animations[id];
		if (previous === next) continue;
		if (!next || !previous) {
			animations[id] = next ?? null;
			continue;
		}
		const { tracks: previousTracks, ...previousHeader } = previous;
		const { tracks: nextTracks, ...nextHeader } = next;
		const header = diffMergePatch(previousHeader, nextHeader);
		const tracks: Record<string, JsonRecord | null> = {};
		for (const trackId of new Set([...Object.keys(previousTracks), ...Object.keys(nextTracks)])) {
			const value = diffMergePatch(previousTracks[trackId], nextTracks[trackId]);
			if (value !== undefined) tracks[trackId] = value as JsonRecord | null;
		}
		const entry = withoutEmpty({ ...(isRecord(header) ? header : {}), tracks });
		if (Object.keys(entry).length) animations[id] = entry;
	}
	return withoutEmpty({ board: diffMergePatch(before.board, after.board) as JsonRecord | undefined, items, animations });
}

export function isEmptyBoardPatch(patch: BoardPatch): boolean {
	return (
		patch.board === undefined &&
		Object.keys(patch.items ?? {}).length === 0 &&
		Object.keys(patch.animations ?? {}).length === 0
	);
}

export function parseBoardDocument(
	input: unknown,
): { ok: true; document: BoardDocument } | { ok: false; diagnostics: BoardDiagnostic[] } {
	if (!isRecord(input)) return { ok: false, diagnostics: [error("", "INVALID_DOCUMENT", "expected an object")] };
	const result = applyBoardPatchToDocument(
		{ board: BoardSettingsSchema.parse({}), items: {}, animations: {} },
		{
			...(isRecord(input.board) ? { board: input.board } : {}),
			...(isRecord(input.items) ? { items: input.items as Record<string, JsonRecord> } : {}),
			...(isRecord(input.animations) ? { animations: input.animations as BoardPatch["animations"] } : {}),
		},
	);
	return result.ok ? { ok: true, document: result.document } : result;
}
