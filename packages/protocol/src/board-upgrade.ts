
import { BOARD_PROTOCOL_VERSION, BOARD_SNAPSHOT_KIND } from "./board.js";
import type { BoardPatch } from "./board-model.js";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const num = (value: unknown, fallback = 0) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);

const EASES: Record<string, string> = {
	linear: "linear",
	"ease-in-quad": "cubic-bezier(0.11, 0, 0.5, 0)",
	"ease-out-quad": "cubic-bezier(0.5, 1, 0.89, 1)",
	"ease-in-out-quad": "cubic-bezier(0.45, 0, 0.55, 1)",
	"ease-in-cubic": "cubic-bezier(0.32, 0, 0.67, 0)",
	"ease-out-cubic": "cubic-bezier(0.33, 1, 0.68, 1)",
	"ease-in-out-cubic": "cubic-bezier(0.65, 0, 0.35, 1)",
	"ease-out-quart": "cubic-bezier(0.25, 1, 0.5, 1)",
	"ease-out-expo": "cubic-bezier(0.16, 1, 0.3, 1)",
};
const ease = (value: unknown) => (typeof value === "string" ? EASES[value] : undefined);
const withEase = (keyframe: Json, value: unknown) => {
	const mapped = ease(value);
	return mapped && mapped !== "linear" ? { ...keyframe, ease: mapped } : keyframe;
};
const easeOf = (value: unknown) => {
	const mapped = ease(value);
	return mapped && mapped !== "linear" ? mapped : undefined;
};

const SNAPSHOT_KEYS = ["title", "mimeType", "size", "mtimeMs", "naturalWidth", "naturalHeight", "durationMs", "excerpt", "coverPath", "coverUrl"];
function snapshotOf(value: unknown): Json | undefined {
	if (!isRecord(value)) return undefined;
	const result = Object.fromEntries(Object.entries(value).filter(([key]) => SNAPSHOT_KEYS.includes(key)));
	return Object.keys(result).length ? result : undefined;
}

function envelope(item: Json): Json {
	const position = isRecord(item.position) ? { x: num(item.position.x), y: num(item.position.y) } : { x: 0, y: 0 };
	return {
		position,
		...(num(item.rotation) ? { rotation: num(item.rotation) } : {}),
		...(item.locked === true ? { locked: true } : {}),
		...(isRecord(item.metadata) && Object.keys(item.metadata).length ? { metadata: item.metadata } : {}),
	};
}

function size(item: Json): Json | undefined {
	return isRecord(item.size) ? { width: num(item.size.width, 1), height: num(item.size.height, 1) } : undefined;
}

function upgradeItem(item: Json, z: number): Json | null {
	const props = isRecord(item.props) ? item.props : {};
	const style = isRecord(item.style) ? item.style : {};
	const source = isRecord(item.source) ? item.source : {};
	const color = str(style.color);
	const base = { ...envelope(item), z };
	const boxed = (type: string, extra: Json) => ({ ...base, type, ...(size(item) ? { size: size(item) } : {}), ...extra });
	switch (item.type) {
		case "text":
			return { ...base, type: "text", props: { text: String(props.text ?? ""), fontSize: num(props.fontSize, 24) }, ...(color && color !== "neutral" ? { style: { fill: color } } : {}) };
		case "geo": {
			const fillOpacity = num(style.fillOpacity);
			return boxed("shape", {
				props: { geometry: str(props.shape) ?? "rectangle", text: String(props.text ?? ""), fontSize: 14 },
				style: { stroke: color ?? "brand", ...(fillOpacity > 0 ? { fill: color ?? "brand", fillOpacity } : {}) },
			});
		}
		case "draw":
			return { ...base, position: { x: 0, y: 0 }, type: "draw", props: { points: Array.isArray(props.points) ? props.points : [] }, style: { stroke: color ?? "brand", strokeWidth: num(style.strokeWidth, 4) } };
		case "arrow":
			return {
				...base,
				position: { x: 0, y: 0 },
				type: "arrow",
				props: {
					start: isRecord(props.start) ? { x: num(props.start.x), y: num(props.start.y) } : { x: 0, y: 0 },
					end: isRecord(props.end) ? { x: num(props.end.x), y: num(props.end.y) } : { x: 1, y: 0 },
					...(num(props.bend) ? { bend: num(props.bend) } : {}),
					...(props.arrowStart === true ? { arrowStart: true } : {}),
					...(props.arrowEnd === false ? { arrowEnd: false } : {}),
					...(str(props.label) ? { label: props.label } : {}),
				},
				style: { stroke: color ?? "brand", strokeWidth: num(style.strokeWidth, 2.5) },
			};
		case "frame":
			return boxed("frame", { props: { label: String(props.label ?? "") }, ...(color && color !== "neutral" ? { style: { stroke: color } } : {}) });
		case "image":
		case "video":
		case "audio":
		case "file": {
			const path = str(source.path);
			if (!path) return null;
			const snapshot = snapshotOf(source.snapshot);
			return boxed(item.type, { props: { src: path, ...(snapshot ? { snapshot } : {}), ...(item.type === "image" && isRecord(props.crop) ? { crop: props.crop } : {}) } });
		}
		case "task":
			return boxed("task", { props: { taskRunId: String(props.taskRunId ?? ""), snapshot: props.snapshot } });
		default: {
			if (typeof item.type !== "string") return null;
			const type = item.type.includes(".") ? item.type : `legacy.${item.type}`;
			return boxed(type, { props, ...(Object.keys(style).length ? { metadata: { ...(isRecord(item.metadata) ? item.metadata : {}), legacyStyle: style } } : {}) });
		}
	}
}

function upgradeAnchor(anchor: unknown): unknown {
	if (!isRecord(anchor) || anchor.kind === "auto") return "auto";
	if (anchor.kind === "side") return { side: anchor.side, offset: num(anchor.offset, 0.5) };
	if (anchor.kind === "fixed") return { x: num(anchor.nx), y: num(anchor.ny) };
	return "auto";
}

function upgradeConnection(connection: Json, z: number): Json {
	const source = isRecord(connection.source) ? connection.source : {};
	const target = isRecord(connection.target) ? connection.target : {};
	const routing = isRecord(connection.routing) ? connection.routing : {};
	const style = isRecord(connection.style) ? connection.style : {};
	const direction = connection.direction;
	const end = (value: Json) => ({ item: String(value.itemId), anchor: upgradeAnchor(value.anchor), ...(str(value.portId) ? { port: value.portId } : {}) });
	return {
		type: "arrow",
		z,
		props: {
			start: end(source),
			end: end(target),
			route: str(routing.kind) ?? "curve",
			...(num(routing.bend) ? { bend: num(routing.bend) } : {}),
			...(Array.isArray(routing.waypoints) && routing.waypoints.length ? { waypoints: routing.waypoints } : {}),
			...(direction === "backward" || direction === "both" ? { arrowStart: true } : {}),
			...(direction === "backward" || direction === "none" ? { arrowEnd: false } : {}),
			...(str(connection.label) ? { label: connection.label } : {}),
			...(str(connection.relation) && connection.relation !== "related" ? { relation: connection.relation } : {}),
		},
		style: {
			stroke: str(style.color) ?? "brand",
			strokeWidth: num(style.size, 2.5),
			...(style.line === "dashed" ? { dash: "dashed" } : {}),
		},
	};
}

const CHANNELS: Record<string, string> = {
	"transform.translation": "position",
	"transform.rotation": "rotation",
	"transform.scale": "scale",
	"style.opacity": "opacity",
};

function upgradeFocus(focus: unknown): unknown {
	if (!isRecord(focus)) return undefined;
	if (focus.type === "item") return str(focus.itemId);
	if (focus.type === "frame") return str(focus.frameId);
	if (focus.type === "items" && Array.isArray(focus.itemIds)) return str(focus.itemIds[0]);
	if (focus.type === "rect" && isRecord(focus.rect)) return focus.rect;
	return undefined;
}

function upgradeComposition(composition: Json, autoplay: { delay: number } | null): Json {
	const timeline = isRecord(composition.timeline) ? composition.timeline : {};
	const playback = isRecord(composition.playback) ? composition.playback : {};
	const duration = Math.max(1, num(timeline.duration, 1));
	const tracks: Record<string, Json> = {};
	for (const track of Array.isArray(timeline.tracks) ? timeline.tracks : []) {
		if (!isRecord(track) || !isRecord(track.target) || track.target.type !== "item") continue;
		const property = CHANNELS[String(track.channel)];
		if (!property) continue;
		const keyframes = (Array.isArray(track.keyframes) ? track.keyframes : []).filter(isRecord).map((keyframe) => {
			const value = property === "rotation" ? (num(keyframe.value) * 180) / Math.PI : keyframe.value;
			return withEase({ at: num(keyframe.time), value }, keyframe.easing);
		});
		if (!keyframes.length) continue;
		tracks[String(track.id)] = {
			target: String(track.target.itemId),
			property,
			composite: "add",
			keyframes,
			...(track.interpolation === "step" ? { interpolation: "step" } : {}),
		};
	}
	const clips = (Array.isArray(timeline.clips) ? timeline.clips : []).filter(isRecord);
	const focusClips = clips
		.filter((value) => value.kind === "camera.focus")
		.map((clip) => ({ id: String(clip.id), start: num(clip.start), end: num(clip.start) + num(clip.duration), value: upgradeFocus(isRecord(clip.params) ? clip.params.focus : undefined), easing: clip.easing, seq: 0 }))
		.filter((entry): entry is typeof entry & { value: Json } => entry.value !== undefined)
		.sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.map((clip, seq) => ({ ...clip, seq }));
	const showingAt = (at: number): Json | undefined => {
		let owner: (typeof focusClips)[number] | undefined;
		for (const clip of focusClips) if (clip.start <= at) owner = clip;
		if (!owner) return (focusClips[0] as { value: Json } | undefined)?.value;
		if (at >= owner.end) return owner.value;
		let replaced: (typeof focusClips)[number] | undefined;
		for (const clip of focusClips) if (clip.seq < owner.seq) replaced = clip;
		return replaced?.value ?? owner.value;
	};
	const moments = [...new Set([0, ...focusClips.map((clip) => clip.end)])].sort((a, b) => a - b);
	const focusFrames: Json[] = [];
	for (const at of moments) {
		const value = showingAt(at);
		if (value === undefined) continue;
		const arrival = [...focusClips].reverse().find((clip) => clip.end === at);
		const frame = { at, value, ...(arrival === undefined || easeOf(arrival.easing) === undefined ? {} : { ease: easeOf(arrival.easing) }) };
		if (focusFrames.at(-1)?.at === at) focusFrames[focusFrames.length - 1] = frame;
		else focusFrames.push(frame);
	}
	if (focusFrames.length) tracks["camera-focus"] = { target: "camera", property: "focus", keyframes: focusFrames };
	for (const clip of clips) {
		const id = String(clip.id);
		const start = num(clip.start);
		const end = start + num(clip.duration);
		const target = isRecord(clip.target) && clip.target.type === "item" ? String(clip.target.itemId) : null;
		const params = isRecord(clip.params) ? clip.params : {};
		if (clip.kind === "text.reveal" && target) {
			tracks[id] = { target, property: "props.reveal", keyframes: [{ at: start, value: 0 }, withEase({ at: end, value: 1 }, clip.easing)] };
		} else if (clip.kind === "draw.reveal" && target) {
			tracks[id] = { target, property: "style.trim", keyframes: [{ at: start, value: 0 }, withEase({ at: end, value: 1 }, clip.easing)] };
		} else if (clip.kind === "camera.shake") {
			tracks[id] = { target: "camera", property: "shake", keyframes: [{ at: start, value: num(params.amount, 12) }, { at: end, value: 0 }] };
		} else if (clip.kind === "motion.path" && target && Array.isArray(params.points) && params.points.length >= 2) {
			const points = params.points.filter(isRecord);
			tracks[id] = {
				target,
				property: "position",
				composite: "add",
				interpolation: "spline",
				...(params.orient === true ? { orient: true } : {}),
				keyframes: points.map((point, index) => ({ at: start + ((end - start) * index) / (points.length - 1), value: { x: num(point.x), y: num(point.y) } })),
			};
		}
	}
	const markers = (Array.isArray(timeline.markers) ? timeline.markers : []).filter(isRecord).map((marker) => ({
		at: num(marker.time),
		...(isRecord(marker.metadata) && str(marker.metadata.label) ? { label: marker.metadata.label } : {}),
	}));
	return {
		...(str(composition.name) ? { name: composition.name } : {}),
		duration,
		...(autoplay ? { play: "auto", ...(autoplay.delay ? { delay: autoplay.delay } : {}) } : {}),
		...(playback.loop === true ? { loop: true } : {}),
		...(playback.endBehavior === "reset" ? { end: "reset" } : {}),
		...(markers.length ? { markers } : {}),
		tracks,
	};
}

function upgradeSettings(metadata: Json): Json {
	const appearance = isRecord(metadata.appearance) ? metadata.appearance : {};
	const background = isRecord(appearance.background) ? appearance.background : {};
	const grid = isRecord(appearance.grid) ? appearance.grid : null;
	const motion = isRecord(appearance.motion) ? appearance.motion : {};
	const enter = isRecord(motion.enter) && motion.enter.kind === "effects.deal" ? { preset: "deal" } : undefined;
	const kind = ["solid", "dots", "grid", "image"].includes(String(background.kind)) ? background.kind : "solid";
	return {
		background: {
			kind,
			...(str(background.color) ? { color: background.color } : {}),
			...(str(background.imageUrl) ? { imageUrl: background.imageUrl } : {}),
			...(str(background.fit) ? { fit: background.fit } : {}),
			...(typeof background.opacity === "number" ? { opacity: background.opacity } : {}),
		},
		...(grid && grid.visible === true ? { grid: { visible: true, size: num(grid.size, 24) } } : {}),
		...(enter ? { enter } : {}),
	};
}

export function boardSnapshotPatch(snapshot: unknown): BoardPatch {
	const value = isRecord(snapshot) ? snapshot : {};
	if (value.kind !== BOARD_SNAPSHOT_KIND) throw new Error("Not a Board snapshot");
	if (value.version === 2) return upgradeBoardSnapshotV2(value);
	if (value.version !== BOARD_PROTOCOL_VERSION) throw new Error(`Unsupported Board snapshot version: ${String(value.version)}`);
	return { board: value.board, items: value.items, animations: value.animations } as BoardPatch;
}

export function upgradeBoardSnapshotV2(snapshot: unknown): BoardPatch {
	const value = isRecord(snapshot) ? snapshot : {};
	const board = isRecord(value.board) ? value.board : {};
	const metadata = isRecord(board.metadata) ? board.metadata : {};
	const items: Record<string, Json> = {};
	let z = 0;
	for (const item of Array.isArray(value.items) ? value.items : []) {
		if (!isRecord(item) || typeof item.id !== "string") continue;
		z += 1;
		const upgraded = upgradeItem(item, z);
		if (upgraded) items[item.id] = upgraded;
	}
	for (const connection of Array.isArray(value.connections) ? value.connections : []) {
		if (!isRecord(connection) || typeof connection.id !== "string") continue;
		const source = isRecord(connection.source) ? connection.source.itemId : undefined;
		const target = isRecord(connection.target) ? connection.target.itemId : undefined;
		if (typeof source !== "string" || typeof target !== "string" || !items[source] || !items[target]) continue;
		const id = items[connection.id] ? `connection-${connection.id}` : connection.id;
		z += 1;
		items[id] = upgradeConnection(connection, z);
	}
	const policy = isRecord(metadata.playback) ? metadata.playback : null;
	const animations: Record<string, Json> = {};
	for (const composition of Array.isArray(value.compositions) ? value.compositions : []) {
		if (!isRecord(composition) || typeof composition.id !== "string") continue;
		const autoplay = policy?.compositionId === composition.id ? { delay: num(policy.delayMs) } : null;
		const id = items[composition.id] ? `animation-${composition.id}` : composition.id;
		const upgraded = upgradeComposition(composition, autoplay);
		const tracks = upgraded.tracks as Record<string, Json>;
		for (const [trackId, track] of Object.entries(tracks)) {
			const target = String(track.target);
			const focusMissing = track.property === "focus" && (track.keyframes as Json[]).some((keyframe) => typeof keyframe.value === "string" && !items[keyframe.value as string]);
			if ((target !== "camera" && !items[target]) || focusMissing) delete tracks[trackId];
		}
		animations[id] = upgraded;
	}
	return {
		board: { ...upgradeSettings(metadata), ...(str(board.title) ? { title: board.title } : {}) },
		items,
		animations,
	} as BoardPatch;
}
