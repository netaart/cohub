/**
 * Connection drawing.
 *
 * Connections render into shared layers beneath the cards rather than as a
 * container per relation. A connection is a thin stroke with no texture and no
 * interactive chrome of its own, so a per-connection container would add a
 * transform, a render group and a draw call each for geometry that batches
 * perfectly — on a densely connected board that is the difference between a few
 * draw calls and a few thousand.
 *
 * Tessellation is the real cost, so both layers are cached: `base` holds idle
 * relations, `live` those touching manipulated, selected or hovered nodes.
 * Details too small to read degrade to plain strokes; the document never changes.
 *
 * Labels are the exception to batching: text needs its own object to rasterise,
 * so a `Text` is materialised only for visible connections that carry one and is
 * pooled by connection id.
 */

import { BOARD_FONT_STACK } from "@cohub/protocol/board-constants";
import type { BoardConnection } from "@cohub/protocol/board-connection";
import type { BoardFrame } from "@cohub/protocol/board-document";
import { Container, Graphics, type StrokeStyle, Text } from "pixi.js";
import {
	type ConnectionGeometry,
	connectionArrowheads,
	createConnectionGeometryCache,
	type FrameLookup,
	type ResolvedConnection,
} from "../core/connections.js";
import { pickBoardColor } from "../core/palette.js";
import type { BoardShapeColors } from "../core/palette.js";
import { type Rect, rectsIntersect, type WorldPoint } from "../geometry.js";
import {
	syncTextResolution,
	textResolutionForZoom,
	textZoomBucket,
} from "./text-resolution.js";

/** Arrowhead length relative to stroke width, and its floor in world units. */
const HEAD_SCALE = 5.5;
const HEAD_MIN = 11;
const HEAD_SPREAD = Math.PI / 6;
/** Dash pattern for `dashed` connections, in world units. */
const DASH_LENGTH = 10;
const DASH_GAP = 7;
const LABEL_FONT_SIZE = 12;
/** Minimum on-screen sizes before a detail is drawn. */
const MIN_DASH_PX = 4;
const MIN_HEAD_PX = 3;
const MIN_LABEL_PX = 5;
const MIN_SEGMENT_PX = 2;
const MIN_ROUND_PX = 2;
/** Dashes per frame; past it all dashed relations draw solid (with hysteresis). */
const DASH_BUDGET = 40_000;
const DASH_RESUME_RATIO = 0.8;

export type ConnectionRenderInput = {
	connections: readonly BoardConnection[];
	getFrame: FrameLookup;
	colors: BoardShapeColors;
	colorScheme: "dark" | "light";
	zoom: number;
	/** Connections drawn in their selected state. */
	selectedIds?: ReadonlySet<string>;
	/** Connection under the pointer, if any. */
	hoveredId?: string | null;
	/**
	 * Ids to skip because the host is drawing them itself this frame (e.g. a live
	 * drag preview on the interaction overlay). Skipping avoids the doubled stroke
	 * of a preview drawn over its own committed geometry.
	 */
	skipIds?: ReadonlySet<string>;
	/** Cull and dash-clip rect; use `stableCullRect` so small pans keep the cache. */
	cullRect?: Rect | null;
	/** Nodes being manipulated; their relations are drawn on the live layer. */
	liveNodeIds?: ReadonlySet<string>;
};

export type ConnectionLayer = {
	/** Draw the connection set; only changed layers re-tessellate. */
	sync: (input: ConnectionRenderInput) => void;
	/** Resolved geometry from the last sync, for hit testing and overlays. */
	resolved: (connectionId: string) => ResolvedConnection | null;
	/**
	 * The display objects this layer owns, so a host can place them in its own
	 * z-ordering scheme without the layer needing to know about it.
	 */
	readonly children: readonly Container[];
	destroy: () => void;
};

/** Drawing decisions for the half-octave zoom bucket at or below `zoom`. */
type Detail = {
	zoom: number;
	dashes: boolean;
	labels: boolean;
	minWidth: number;
	minStep: number;
};

function detailForZoom(zoom: number): Detail {
	const bucket = 2 ** (Math.floor(Math.log2(Math.max(zoom, 0.0001)) * 2) / 2);
	return {
		zoom: bucket,
		dashes: DASH_LENGTH * bucket >= MIN_DASH_PX,
		labels: LABEL_FONT_SIZE * bucket >= MIN_LABEL_PX,
		minWidth: 1 / bucket,
		minStep: MIN_SEGMENT_PX / bucket,
	};
}

/** Visit each dash piece inside `clip`; `start` marks the first piece of a dash. */
function walkDashes(
	path: readonly WorldPoint[],
	clip: Rect | null,
	visit: (x0: number, y0: number, x1: number, y1: number, start: boolean) => void,
) {
	let penDown = true;
	let remaining = DASH_LENGTH;
	let open = false;
	for (let index = 1; index < path.length; index += 1) {
		const a = path[index - 1];
		const b = path[index];
		if (!a || !b) continue;
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const length = Math.hypot(dx, dy);
		let travelled = 0;
		while (length - travelled > 0.0001) {
			const step = Math.min(length - travelled, remaining);
			if (penDown) {
				const t0 = travelled / length;
				const t1 = (travelled + step) / length;
				const x0 = a.x + dx * t0;
				const y0 = a.y + dy * t0;
				const x1 = a.x + dx * t1;
				const y1 = a.y + dy * t1;
				const inside =
					!clip ||
					(Math.max(x0, x1) >= clip.x &&
						Math.min(x0, x1) <= clip.x + clip.width &&
						Math.max(y0, y1) >= clip.y &&
						Math.min(y0, y1) <= clip.y + clip.height);
				if (inside) {
					visit(x0, y0, x1, y1, !open);
					open = true;
				} else open = false;
			}
			travelled += step;
			remaining -= step;
			if (remaining <= 0.0001) {
				penDown = !penDown;
				remaining = penDown ? DASH_LENGTH : DASH_GAP;
				open = false;
			}
		}
	}
}

function countDashes(entries: readonly ConnectionGeometry[], clip: Rect | null): number {
	let count = 0;
	for (const { connection, resolved } of entries) {
		if (connection.style.line !== "dashed") continue;
		walkDashes(resolved.path, clip, (_x0, _y0, _x1, _y1, start) => {
			if (start) count += 1;
		});
		if (count > DASH_BUDGET) break;
	}
	return count;
}

function traceSolid(graphics: Graphics, path: readonly WorldPoint[], minStep: number) {
	const first = path[0];
	const last = path[path.length - 1];
	if (!first || !last) return;
	graphics.moveTo(first.x, first.y);
	let previous = first;
	for (let index = 1; index < path.length - 1; index += 1) {
		const point = path[index];
		if (!point) continue;
		if (Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y) < minStep) continue;
		graphics.lineTo(point.x, point.y);
		previous = point;
	}
	graphics.lineTo(last.x, last.y);
}

/** Trace an open chevron arrowhead aimed along `angle`. */
function traceArrowhead(graphics: Graphics, tip: WorldPoint, angle: number, size: number) {
	graphics
		.moveTo(
			tip.x - size * Math.cos(angle - HEAD_SPREAD),
			tip.y - size * Math.sin(angle - HEAD_SPREAD),
		)
		.lineTo(tip.x, tip.y)
		.lineTo(
			tip.x - size * Math.cos(angle + HEAD_SPREAD),
			tip.y - size * Math.sin(angle + HEAD_SPREAD),
		);
}

type ConnectionState = "idle" | "selected" | "hovered";

/** Stroke each style once instead of once per relation. */
function createStrokeBatch(graphics: Graphics) {
	const groups = new Map<string, { style: StrokeStyle; traces: Array<() => void> }>();
	return {
		add(style: StrokeStyle, trace: () => void) {
			const key = `${style.color}|${style.width}|${style.alpha}|${style.cap}|${style.join}`;
			const group = groups.get(key);
			if (group) group.traces.push(trace);
			else groups.set(key, { style, traces: [trace] });
		},
		flush() {
			for (const { style, traces } of groups.values()) {
				for (const trace of traces) trace();
				graphics.stroke(style);
			}
			groups.clear();
		},
	};
}

function drawConnections(
	graphics: Graphics,
	entries: readonly ConnectionGeometry[],
	states: readonly ConnectionState[],
	input: ConnectionRenderInput,
	detail: Detail,
	clip: Rect | null,
	dashes: boolean,
) {
	const batch = createStrokeBatch(graphics);
	entries.forEach(({ connection, resolved }, index) => {
		const state = states[index] ?? "idle";
		const color = pickBoardColor(input.colors, connection.style.color, input.colorScheme);
		const width = Math.max(
			connection.style.size + (state === "selected" ? 1 : 0),
			detail.minWidth,
		);
		const round = width * detail.zoom >= MIN_ROUND_PX;
		const alpha = state === "idle" ? 0.9 : 1;
		const path = resolved.path;
		const dashed = dashes && connection.style.line === "dashed";
		batch.add(
			{
				color: color.stroke,
				width,
				alpha,
				cap: dashed || !round ? "butt" : "round",
				join: round ? "round" : "miter",
			},
			dashed
				? () =>
						walkDashes(path, clip, (x0, y0, x1, y1, start) => {
							if (start) graphics.moveTo(x0, y0);
							graphics.lineTo(x1, y1);
						})
				: () => traceSolid(graphics, path, detail.minStep),
		);

		const headSize = Math.max(HEAD_MIN, connection.style.size * HEAD_SCALE);
		if (headSize * detail.zoom < MIN_HEAD_PX) return;
		const heads = connectionArrowheads(connection);
		const headStyle: StrokeStyle = {
			color: color.stroke,
			width,
			alpha,
			cap: round ? "round" : "butt",
			join: round ? "round" : "miter",
		};
		const tip = path[path.length - 1];
		const beforeTip = path[path.length - 2];
		if (heads.atTarget && tip && beforeTip) {
			const angle = Math.atan2(tip.y - beforeTip.y, tip.x - beforeTip.x);
			batch.add(headStyle, () => traceArrowhead(graphics, tip, angle, headSize));
		}
		const origin = path[0];
		const afterOrigin = path[1];
		if (heads.atSource && origin && afterOrigin) {
			const angle = Math.atan2(origin.y - afterOrigin.y, origin.x - afterOrigin.x);
			batch.add(headStyle, () => traceArrowhead(graphics, origin, angle, headSize));
		}
	});
	batch.flush();
}

/** Inputs a layer was last drawn from. */
type DrawnLayer = {
	entries: readonly ConnectionGeometry[];
	states: readonly ConnectionState[];
	view: string;
	colors: BoardShapeColors;
	dashCount: number;
	dashes: boolean;
	labelIds: ReadonlySet<string>;
};

function isCurrent(
	drawn: DrawnLayer | null,
	entries: readonly ConnectionGeometry[],
	states: readonly ConnectionState[],
	view: string,
	colors: BoardShapeColors,
): drawn is DrawnLayer {
	return (
		drawn !== null &&
		drawn.view === view &&
		drawn.colors === colors &&
		sameItems(drawn.entries, entries) &&
		sameItems(drawn.states, states)
	);
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index += 1) {
		if (a[index] !== b[index]) return false;
	}
	return true;
}

export function createConnectionLayer(options: {
	/** World-space container the layer attaches to. */
	parent: Container;
	/** zIndex applied to the layer's display objects once they exist. */
	zIndex?: number;
}): ConnectionLayer {
	// Display objects are created on first use, not up front: most boards have no
	// relations at all, and an unused Graphics still costs an allocation, a child on
	// the world container and a slot in every sort of its children.
	let layers: { base: Graphics; live: Graphics; labels: Container } | null = null;

	const geometry = createConnectionGeometryCache();
	const labels = new Map<string, { text: Text; resolution: number; sig: string }>();
	let lastConnections: readonly BoardConnection[] | null = null;
	let drawnBase: DrawnLayer | null = null;
	let drawnLive: DrawnLayer | null = null;
	let withinBudget = true;

	function ensureAttached() {
		if (layers) return layers;
		const next = {
			base: new Graphics({ label: "board-connections" }),
			live: new Graphics({ label: "board-connections-live" }),
			labels: new Container({ label: "board-connection-labels" }),
		};
		if (options.zIndex !== undefined) {
			next.base.zIndex = options.zIndex;
			next.live.zIndex = options.zIndex;
			next.labels.zIndex = options.zIndex;
		}
		options.parent.addChild(next.base, next.live, next.labels);
		layers = next;
		return next;
	}

	function releaseLabel(connectionId: string) {
		const entry = labels.get(connectionId);
		if (!entry) return;
		layers?.labels.removeChild(entry.text);
		entry.text.destroy();
		labels.delete(connectionId);
	}

	function syncLabel(
		{ connection, resolved }: ConnectionGeometry,
		input: ConnectionRenderInput,
		host: Container,
	): boolean {
		const value = connection.label.trim();
		if (!value) return false;
		const color = pickBoardColor(input.colors, connection.style.color, input.colorScheme).label;
		let entry = labels.get(connection.id);
		if (!entry) {
			const resolution = textResolutionForZoom(input.zoom);
			const text = new Text({
				text: value,
				style: {
					fill: color,
					fontFamily: BOARD_FONT_STACK,
					fontSize: LABEL_FONT_SIZE,
					fontWeight: "500",
				},
				resolution,
				roundPixels: true,
			});
			text.anchor.set(0.5);
			host.addChild(text);
			entry = { text, resolution, sig: "" };
			labels.set(connection.id, entry);
		}
		syncTextResolution(entry.text, entry, input.zoom);
		const sig = `${value}|${color}`;
		if (sig !== entry.sig) {
			entry.sig = sig;
			entry.text.text = value;
			entry.text.style.fill = color;
		}
		entry.text.position.set(resolved.mid.x, resolved.mid.y);
		return true;
	}

	function drawLayer(
		graphics: Graphics,
		layer: Omit<DrawnLayer, "labelIds">,
		input: ConnectionRenderInput,
		detail: Detail,
		clip: Rect | null,
	): DrawnLayer {
		graphics.clear();
		drawConnections(graphics, layer.entries, layer.states, input, detail, clip, layer.dashes);
		const labelIds = new Set<string>();
		if (detail.labels && layers) {
			for (const entry of layer.entries) {
				if (syncLabel(entry, input, layers.labels)) labelIds.add(entry.connection.id);
			}
		}
		return { ...layer, labelIds };
	}

	function sync(input: ConnectionRenderInput) {
		// Nothing to draw and nothing drawn before: stay unattached so a board without
		// relations pays nothing at all for the feature.
		if (input.connections.length === 0 && !layers) return;
		const host = ensureAttached();
		if (input.connections !== lastConnections) {
			geometry.retain(input.connections);
			lastConnections = input.connections;
		}

		const detail = detailForZoom(input.zoom);
		const cull = input.cullRect ?? null;
		const clip = detail.dashes ? cull : null;
		const selected = input.selectedIds;
		const liveNodes = input.liveNodeIds;

		const baseEntries: ConnectionGeometry[] = [];
		const baseStates: ConnectionState[] = [];
		const liveEntries: ConnectionGeometry[] = [];
		const liveStates: ConnectionState[] = [];
		let hovered: ConnectionGeometry | null = null;
		for (const connection of input.connections) {
			const entry = geometry.get(connection, input.getFrame);
			if (!entry || input.skipIds?.has(connection.id)) continue;
			if (cull && !rectsIntersect(entry.bounds, cull)) continue;
			if (selected?.has(connection.id)) {
				liveEntries.push(entry);
				liveStates.push("selected");
			} else if (
				liveNodes?.has(connection.source.itemId) ||
				liveNodes?.has(connection.target.itemId)
			) {
				liveEntries.push(entry);
				liveStates.push(connection.id === input.hoveredId ? "hovered" : "idle");
			} else {
				baseEntries.push(entry);
				baseStates.push("idle");
				if (connection.id === input.hoveredId) hovered = entry;
			}
		}
		// Overdraw the hovered relation live so hover never invalidates the base.
		if (hovered) {
			liveEntries.push(hovered);
			liveStates.push("hovered");
		}

		const view = `${detail.zoom}|${textZoomBucket(input.zoom)}|${input.colorScheme}|${
			clip ? `${clip.x},${clip.y},${clip.width},${clip.height}` : ""
		}`;
		const baseCurrent = isCurrent(drawnBase, baseEntries, baseStates, view, input.colors);
		const liveCurrent = isCurrent(drawnLive, liveEntries, liveStates, view, input.colors);
		const countFor = (current: boolean, drawn: DrawnLayer | null, entries: ConnectionGeometry[]) =>
			!detail.dashes ? 0 : current && drawn ? drawn.dashCount : countDashes(entries, clip);
		const baseDashes = countFor(baseCurrent, drawnBase, baseEntries);
		// The hover overlay repeats a base relation; do not count it twice.
		const liveDashes = countFor(
			liveCurrent,
			drawnLive,
			hovered ? liveEntries.slice(0, -1) : liveEntries,
		);
		const total = baseDashes + liveDashes;
		withinBudget = withinBudget
			? total <= DASH_BUDGET
			: total <= DASH_BUDGET * DASH_RESUME_RATIO;
		const dashes = detail.dashes && withinBudget;

		const redraw = (
			graphics: Graphics,
			entries: ConnectionGeometry[],
			states: ConnectionState[],
			dashCount: number,
		) =>
			drawLayer(
				graphics,
				{ entries, states, view, colors: input.colors, dashCount, dashes },
				input,
				detail,
				clip,
			);
		let labelsChanged = false;
		if (!baseCurrent || drawnBase?.dashes !== dashes) {
			drawnBase = redraw(host.base, baseEntries, baseStates, baseDashes);
			labelsChanged = true;
		}
		if (!liveCurrent || drawnLive?.dashes !== dashes) {
			drawnLive = redraw(host.live, liveEntries, liveStates, liveDashes);
			labelsChanged = true;
		}
		if (!labelsChanged) return;
		const wanted = new Set([...(drawnBase?.labelIds ?? []), ...(drawnLive?.labelIds ?? [])]);
		for (const connectionId of [...labels.keys()]) {
			if (!wanted.has(connectionId)) releaseLabel(connectionId);
		}
	}

	return {
		sync,
		resolved: (connectionId) => geometry.peek(connectionId)?.resolved ?? null,
		get children() {
			return layers ? [layers.base, layers.live, layers.labels] : [];
		},
		destroy: () => {
			for (const entry of labels.values()) entry.text.destroy();
			labels.clear();
			if (layers) {
				layers.base.destroy();
				layers.live.destroy();
				layers.labels.destroy({ children: true });
			}
			layers = null;
			drawnBase = null;
			drawnLive = null;
			withinBudget = true;
			lastConnections = null;
			geometry.clear();
		},
	};
}

/** Frame lookup over a plain item list, for hosts without an index. */
export function framesFromItems(
	items: readonly { id: string; frame: BoardFrame }[],
): FrameLookup {
	const frames = new Map(items.map((item) => [item.id, item.frame]));
	return (id) => frames.get(id);
}
