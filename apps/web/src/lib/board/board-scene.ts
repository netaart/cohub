import type {
	BoardConnection,
	BoardFrame,
	BoardItem,
	ResolvedConnection,
} from "@neta-art/cohub/board";
import {
	CORNER_RESIZE_HANDLES,
	frameCorners,
	frameHandlePosition,
	frameRayIntersection,
	type Rect,
	type ResizeHandle,
	rotationHandleAnchor,
	rotationHandlePosition,
	type WorldPoint,
} from "@neta-art/cohub/board";
import type {
	BoardCardRenderer,
	BoardRenderContext,
	BoardRenderPalette,
	getBoardCardRenderer,
} from "@neta-art/cohub/board/render";
import { createConnectionLayer } from "@neta-art/cohub/board/render";
import type { Container, Graphics } from "pixi.js";
import type {
	BoardSelectionTransform,
	BoardTransformControl,
} from "$lib/board/core/selection-transform";

type CardEntry = {
	item: BoardItem;
	container: Container;
	renderer: BoardCardRenderer;
	/** Last per-card selection state seen by this card. */
	selected: boolean;
	/** Last per-card hover state seen by this card. */
	hovered: boolean;
	/** Last live-resize state seen by this card. */
	resizing: boolean;
	/** Last global signal (asset readiness / theme) seen by this card. */
	globalSig: string;
};

/**
 * Above this many simultaneously visible cards the scene switches to the far
 * layer: every far-capable item is drawn as flat batched geometry instead of a
 * live container. Hysteresis avoids flapping right at the boundary.
 */
const FAR_LAYER_ENTER = 450;
const FAR_LAYER_EXIT = 350;
/**
 * z-index bands.
 *
 * Ordering is expressed through Pixi's `zIndex` (one sort per dirty frame)
 * rather than `setChildIndex` per card, which splices the child array and would
 * be quadratic in the number of live cards on every pan frame. Cards occupy the
 * middle band so the far layer and the overlay can never be reordered into it.
 */
const Z_FAR_LAYER = -1;
/**
 * Connections sit above the far layer but below every card.
 *
 * Relations are context for the nodes they join, so a line must never cover the
 * content it describes. One band for all of them also means the whole relation set
 * is a single batched draw regardless of how many there are.
 */
const Z_CONNECTIONS = -0.5;
const Z_OVERLAY = Number.MAX_SAFE_INTEGER;

/**
 * Materialised containers kept for reuse after their card leaves the viewport.
 * Panning back is then allocation-free; beyond this the surplus is destroyed.
 */
const POOL_LIMIT_PER_RENDERER = 48;

/**
 * Order-independent hash of an id set.
 *
 * The far batch depends on *which* ids it covers — the visible set, minus the
 * pinned ones which are live containers instead — so it must rebuild when that
 * membership changes, not merely when its size does. A size-only key would miss
 * both a pan that swaps one card for another and the common "select A, then
 * select B". Comparing the sets directly would cost the same as hashing them.
 */
function idSetSignature(ids: Set<string>): number {
	let hash = ids.size;
	for (const id of ids) {
		let local = 0;
		for (let i = 0; i < id.length; i += 1) {
			local = (local * 31 + id.charCodeAt(i)) | 0;
		}
		// XOR keeps the combination independent of iteration order.
		hash ^= local;
	}
	return hash;
}

function traceFrame(graphics: Graphics, frame: BoardFrame) {
	const corners = frameCorners(frame);
	const first = corners[0];
	if (!first) return graphics;
	graphics.moveTo(first.x, first.y);
	for (let index = 1; index < corners.length; index += 1) {
		const point = corners[index];
		if (point) graphics.lineTo(point.x, point.y);
	}
	return graphics.closePath();
}

function frameEdgePoints(
	frame: BoardFrame,
	handle: ResizeHandle,
): readonly [{ x: number; y: number }, { x: number; y: number }] | null {
	switch (handle) {
		case "n":
			return [
				frameHandlePosition(frame, "nw"),
				frameHandlePosition(frame, "ne"),
			];
		case "e":
			return [
				frameHandlePosition(frame, "ne"),
				frameHandlePosition(frame, "se"),
			];
		case "s":
			return [
				frameHandlePosition(frame, "sw"),
				frameHandlePosition(frame, "se"),
			];
		case "w":
			return [
				frameHandlePosition(frame, "nw"),
				frameHandlePosition(frame, "sw"),
			];
		default:
			return null;
	}
}

export type SceneSyncInput = {
	items: BoardItem[];
	/** Relations to draw. Resolved against the live item frames each sync. */
	connections?: readonly BoardConnection[];
	/** Stable cull rect for relations; null draws them all. */
	cullRect?: Rect | null;
	/** Connection ids the overlay is previewing, so they are not drawn twice. */
	connectionSkipIds?: ReadonlySet<string>;
	/** Selected connection ids, drawn in their selected state. */
	selectedConnectionIds?: ReadonlySet<string>;
	/** Connection under the pointer, if any. */
	hoveredConnectionId?: string | null;
	context: BoardRenderContext;
	/**
	 * O(1) item lookup by id. The appearance pass walks the visible set and
	 * resolves items through this, so per-frame cost tracks what is on screen
	 * rather than the size of `items`.
	 */
	getItem: (id: string) => BoardItem | null;
	/**
	 * Ids whose cards should be rendered this frame, or null to disable culling
	 * (render everything — used until the surface has a real size).
	 */
	visibleIds: Set<string> | null;
	/** Ids always rendered as live containers (selected, editing). */
	pinnedIds: Set<string>;
	/**
	 * A signature of the *global* render signals that affect every card equally
	 * (asset readiness, theme). Selection and hover are tracked per card, so a
	 * hover change refreshes only the two affected cards rather than the whole
	 * viewport.
	 */
	globalSig: string;
	/** Bumped on item membership/order changes. Gates the far-layer rebuild. */
	structureVersion: number;
	/** Bumped on geometry changes (nudge, align, drag commit). */
	geometryVersion: number;
	/**
	 * True while a pointer gesture is running. During a gesture only pinned
	 * items move, and pinned items are never part of the far batch, so the far
	 * layer is left untouched instead of rebuilt every frame.
	 */
	gestureActive: boolean;
};

export type SceneOverlayInput = {
	zoom: number;
	pointerType: string;
	marquee: Rect | null;
	selection: string[];
	transform: BoardSelectionTransform | null;
	/** Whether resize/rotate handles are actionable for the active tool. */
	controls: boolean;
	hoveredControl: BoardTransformControl | null;
	/** Live pointer while rotating; keeps the handle attached to the gesture. */
	rotationPointer: WorldPoint | null;
	/** World-space arrow endpoint handles to draw as circles. */
	arrowEndpoints?: Array<{ x: number; y: number }>;
	/**
	 * Connection ports to draw for the hovered or selected node, already resolved
	 * to world space by the editor (it owns the zoom-normalised offsets).
	 */
	ports?: ReadonlyArray<{ x: number; y: number; radius: number }>;
	/** The port under the pointer, drawn larger so the target is unambiguous. */
	hoveredPort?: { x: number; y: number } | null;
	/**
	 * A relation being dragged: anchor to live pointer, plus the node it would
	 * attach to. Drawn before the selection chrome so it reads as the active
	 * gesture rather than as part of the selection.
	 */
	connectionDraft?: {
		from: { x: number; y: number };
		to: { x: number; y: number };
		size: number;
		targetFrame: BoardFrame | null;
	} | null;
};

const EMPTY_CONNECTIONS: readonly BoardConnection[] = [];

export type BoardSceneNode = {
	item: BoardItem;
	container: Container;
};

export type BoardScene = {
	sync: (input: SceneSyncInput) => void;
	getNode: (nodeId: string) => BoardSceneNode | null;
	/** Resolved geometry of a drawn connection, for overlays and hit testing. */
	resolvedConnection: (connectionId: string) => ResolvedConnection | null;
	drawOverlay: (input: SceneOverlayInput, palette: BoardRenderPalette) => void;
	destroy: (context: BoardRenderContext) => void;
};

/**
 * Owns the Pixi display list for board cards and the selection overlay.
 *
 * The scene is sized by what is *on screen*, not by how large the document is,
 * so a board with tens of thousands of nodes costs the same per frame as one
 * with a few hundred:
 *
 * - **Lazy materialisation.** A card's container is created the first time it
 *   becomes visible and returned to a per-renderer pool when it scrolls away.
 *   Nothing is allocated for the off-screen remainder of the document.
 * - **Visible-set iteration.** Every per-frame pass walks the visible set, never
 *   the full item array. Structure reconciliation is gated on `structureVersion`
 *   so a pan, hover or drag skips it entirely.
 * - **Far layer.** Past `FAR_LAYER_ENTER` visible cards the per-card containers
 *   are dropped in favour of one batched `Graphics` — a couple of draw calls for
 *   the whole viewport. It covers the visible set, so its cost tracks the viewport
 *   too, and it is rebuilt only when that set's membership changes.
 *
 * The far layer sits below the cards (`Z_FAR_LAYER`), which is only correct because
 * *every* renderer implements `renderFar`. Batched shapes keep document order
 * naturally, since one `Graphics` draws in the order it was traced; an item left
 * unbatched would become a live container and be drawn above the entire batch
 * regardless of its document position — a frame, for instance, would hide the cards
 * inside it. The one exception is pinned items (selected or being edited), which
 * stay live and above by design: they are the ones being manipulated.
 */
export function createBoardScene(options: {
	world: Container;
	/** Batched geometry layer for the far LOD; sits under the card containers. */
	farLayer: Graphics;
	overlay: Graphics;
	getRenderer: typeof getBoardCardRenderer;
}): BoardScene {
	const { world, farLayer, overlay, getRenderer } = options;
	// One layer for every relation on the board: connections batch perfectly, so a
	// container per relation would trade a handful of draw calls for thousands.
	const connectionLayer = createConnectionLayer({
		parent: world,
		zIndex: Z_CONNECTIONS,
	});
	// Ordering is by zIndex (see the Z_* bands); the layers that must stay at the
	// extremes are pinned once here rather than re-indexed every frame.
	world.sortableChildren = true;
	farLayer.zIndex = Z_FAR_LAYER;
	overlay.zIndex = Z_OVERLAY;
	/** Materialised (currently visible) cards, keyed by item id. */
	const cards = new Map<string, CardEntry>();
	/** True while the connection layer holds geometry, so it is cleared once. */
	let connectionsDrawn = false;
	/** Recycled containers by renderer id, ready to be re-adopted. */
	const pools = new Map<string, Container[]>();
	// Texture reference ownership: cardId → texture key currently held. The scene
	// acquires a ref when a card materialises and releases it when the card is
	// recycled, so the asset manager tracks only displayed preview textures.
	// Off-screen textures drop to zero refs and enter the cooling pool (LRU).
	const heldKeys = new Map<string, string>();
	/** Document z-order position per item id, refreshed on structural changes. */
	let orderById = new Map<string, number>();
	/** Signature of the document state the far layer was built from. */
	let farSig: string | null = null;
	let farActive = false;
	let lastStructureVersion = -1;

	function setHeldKey(
		context: BoardRenderContext,
		cardId: string,
		desiredKey: string | null,
	) {
		const heldKey = heldKeys.get(cardId) ?? null;
		if (desiredKey === heldKey) return;
		if (heldKey) context.releaseTexture(heldKey);
		if (desiredKey) context.acquireTexture(desiredKey);
		if (desiredKey) heldKeys.set(cardId, desiredKey);
		else heldKeys.delete(cardId);
	}

	/** Take a recycled container for this renderer, or null to create one. */
	function takeFromPool(rendererId: string): Container | null {
		const pool = pools.get(rendererId);
		if (!pool || pool.length === 0) return null;
		return pool.pop() ?? null;
	}

	/**
	 * Return a card's container to its pool. Containers keep their children and
	 * cached parts; the next adopter re-syncs them through `renderer.update`.
	 * Surplus beyond the pool limit is destroyed so memory stays bounded.
	 */
	function recycle(
		id: string,
		entry: CardEntry,
		context: BoardRenderContext,
		destroyed: boolean,
	) {
		setHeldKey(context, id, null);
		cards.delete(id);
		if (destroyed) return;
		world.removeChild(entry.container);
		entry.container.visible = false;
		const pool = pools.get(entry.renderer.id) ?? [];
		if (pool.length >= POOL_LIMIT_PER_RENDERER) {
			entry.renderer.destroy?.(entry.container, context);
			return;
		}
		pool.push(entry.container);
		pools.set(entry.renderer.id, pool);
	}

	/** Materialise a card as a live container, reusing a pooled one when possible. */
	function materialize(
		item: BoardItem,
		context: BoardRenderContext,
		globalSig: string,
	): CardEntry {
		const renderer = getRenderer(item, context);
		const pooled = takeFromPool(renderer.id);
		const container = pooled ?? renderer.create(item, context);
		container.visible = true;
		if (pooled) renderer.update(container, item, context);
		world.addChild(container);
		const entry: CardEntry = {
			item,
			container,
			renderer,
			selected: context.selectedIds.has(item.id),
			hovered: context.hoveredId === item.id,
			resizing: context.resizingIds.has(item.id),
			globalSig,
		};
		cards.set(item.id, entry);
		setHeldKey(context, item.id, context.assetKey(item));
		return entry;
	}

	/**
	 * Rebuild the batched far layer.
	 *
	 * Draws only what is on screen, in document order. Batching the whole document
	 * would defeat the point: a Graphics holding every plate uploads and draws all
	 * of them every frame, so the per-frame cost would track the board's size —
	 * exactly what the far layer exists to avoid. Iteration order follows `items`
	 * so plates stack the way the document says.
	 */
	function rebuildFarLayer(input: SceneSyncInput) {
		const { context, getItem, pinnedIds } = input;
		farLayer.clear();
		for (const id of visibleFacts(input).orderedIds) {
			// Pinned items are live containers, so drawing them here would double them.
			const item = pinnedIds.has(id) ? null : getItem(id);
			if (!item) continue;
			const renderer = getRenderer(item, context);
			renderer.renderFar?.(farLayer, item, context);
		}
	}

	/** Visible-set facts memoised per set and structure (renderers follow item type). */
	let visibleMemo: {
		ids: Set<string> | null;
		structureVersion: number;
		signature: number;
		orderedIds: string[];
		unbatched: Set<string>;
	} | null = null;
	function visibleFacts(input: SceneSyncInput) {
		const { items, visibleIds, structureVersion, context, getItem } = input;
		if (
			visibleMemo?.ids === visibleIds &&
			visibleMemo.structureVersion === structureVersion
		)
			return visibleMemo;
		const orderedIds =
			visibleIds === null
				? items.map((item) => item.id)
				: [...visibleIds].sort(
						(a, b) => (orderById.get(a) ?? 0) - (orderById.get(b) ?? 0),
					);
		const unbatched = new Set<string>();
		for (const id of orderedIds) {
			const item = getItem(id);
			if (item && !getRenderer(item, context).renderFar) unbatched.add(id);
		}
		visibleMemo = {
			ids: visibleIds,
			structureVersion,
			signature: visibleIds === null ? 0 : idSetSignature(visibleIds),
			orderedIds,
			unbatched,
		};
		return visibleMemo;
	}

	function sync(input: SceneSyncInput) {
		const {
			items,
			context,
			getItem,
			visibleIds,
			pinnedIds,
			globalSig,
			structureVersion,
			geometryVersion,
			gestureActive,
		} = input;

		const connections = input.connections ?? EMPTY_CONNECTIONS;
		if (connections.length > 0 || connectionsDrawn) {
			connectionLayer.sync({
				connections,
				getFrame: (id) => getItem(id)?.frame,
				colors: context.colors,
				colorScheme: context.colorScheme,
				zoom: context.zoom,
				cullRect: input.cullRect ?? null,
				liveNodeIds: pinnedIds,
				...(input.selectedConnectionIds
					? { selectedIds: input.selectedConnectionIds }
					: {}),
				hoveredId: input.hoveredConnectionId ?? null,
				...(input.connectionSkipIds
					? { skipIds: input.connectionSkipIds }
					: {}),
			});
			connectionsDrawn = connections.length > 0;
		}

		// Structure pass: only when membership/order actually changed. This is
		// what keeps a pan, hover or drag off the O(n) path.
		const structureChanged = structureVersion !== lastStructureVersion;
		if (structureChanged) {
			lastStructureVersion = structureVersion;
			const liveIds = new Set(items.map((item) => item.id));
			for (const [id, entry] of [...cards]) {
				if (!liveIds.has(id)) recycle(id, entry, context, false);
			}
			orderById = new Map(items.map((item, index) => [item.id, index]));
		}

		// Decide the LOD for this frame. Hysteresis around the threshold keeps a
		// board hovering near the limit from flipping modes every frame.
		const visibleCount = visibleIds === null ? items.length : visibleIds.size;
		const nextFarActive = farActive
			? visibleCount > FAR_LAYER_EXIT
			: visibleCount > FAR_LAYER_ENTER;
		const farModeChanged = nextFarActive !== farActive;
		farActive = nextFarActive;
		farLayer.visible = farActive;

		// The batch covers the visible set, so it rebuilds when that set's membership
		// changes — which, because the cull rect is margin-expanded, is once every
		// margin crossed rather than every pan frame. During a gesture only pinned
		// items move and pinned items are never batched, so the rebuild is skipped.
		if (farActive) {
			const nextFarSig = [
				structureVersion,
				geometryVersion,
				globalSig,
				idSetSignature(pinnedIds),
				visibleIds === null ? "all" : visibleFacts(input).signature,
			].join("|");
			if (farSig === null || (nextFarSig !== farSig && !gestureActive)) {
				rebuildFarLayer(input);
				farSig = nextFarSig;
			}
		} else if (farModeChanged) {
			farLayer.clear();
			farSig = null;
		}

		// Appearance pass over the visible set only — never over `items`. `wanted` is
		// the set of ids that must exist as live containers this frame.
		const wanted = new Set<string>(pinnedIds);
		if (farActive) {
			const { unbatched } = visibleFacts(input);
			for (const id of unbatched) wanted.add(id);
		} else if (visibleIds === null) {
			for (const item of items) wanted.add(item.id);
		} else {
			for (const id of visibleIds) wanted.add(id);
		}

		// Any change to the live set means the display list gained or lost children,
		// so document z-order has to be re-applied: a card materialised mid-pan is
		// appended at the end and would otherwise sit above its neighbours.
		let liveSetChanged = false;

		for (const [id, entry] of [...cards]) {
			if (!wanted.has(id)) {
				recycle(id, entry, context, false);
				liveSetChanged = true;
			}
		}

		for (const id of wanted) {
			const item = getItem(id);
			if (!item) continue;
			let entry = cards.get(id);
			const renderer = getRenderer(item, context);
			if (entry && entry.renderer.id !== renderer.id) {
				// The item changed shape type; drop the stale container outright
				// rather than pooling it under the wrong renderer.
				world.removeChild(entry.container);
				entry.renderer.destroy?.(entry.container, context);
				recycle(id, entry, context, true);
				entry = undefined;
			}
			if (!entry) {
				materialize(item, context, globalSig);
				liveSetChanged = true;
				continue;
			}

			// A live card only re-renders when something it depends on changed.
			const selected = context.selectedIds.has(id);
			const hovered = context.hoveredId === id;
			const resizing = context.resizingIds.has(id);
			const changed =
				item !== entry.item ||
				selected !== entry.selected ||
				hovered !== entry.hovered ||
				resizing !== entry.resizing ||
				globalSig !== entry.globalSig;
			entry.item = item;
			entry.selected = selected;
			entry.hovered = hovered;
			entry.resizing = resizing;
			entry.globalSig = globalSig;
			setHeldKey(context, id, context.assetKey(item));
			if (changed) entry.renderer.update(entry.container, item, context);
		}

		// Z-order: only the materialised subset needs ordering, and only when that
		// subset actually changed.
		if (structureChanged || farModeChanged || liveSetChanged) applyChildOrder();
	}

	/**
	 * Apply document z-order to the materialised containers.
	 *
	 * Each card carries its document position as a `zIndex` and Pixi sorts once per
	 * dirty frame. The earlier approach (`setChildIndex` per card) spliced the
	 * child array once per card, which is quadratic in the live count and showed up
	 * as soon as a pan materialised cards every frame.
	 */
	function applyChildOrder() {
		for (const [id, entry] of cards) {
			entry.container.zIndex = orderById.get(id) ?? 0;
		}
		world.sortableChildren = true;
		world.sortChildren();
	}

	function drawOverlay(input: SceneOverlayInput, palette: BoardRenderPalette) {
		overlay.clear();
		const {
			zoom,
			pointerType,
			marquee,
			selection,
			transform,
			controls,
			hoveredControl,
			rotationPointer,
			arrowEndpoints,
			ports,
			hoveredPort,
			connectionDraft,
		} = input;
		const inv = 1 / zoom;
		const brand = palette.brand;

		if (marquee) {
			overlay
				.rect(marquee.x, marquee.y, marquee.width, marquee.height)
				.fill({ color: brand, alpha: 0.08 });
			overlay
				.rect(marquee.x, marquee.y, marquee.width, marquee.height)
				.stroke({ color: brand, width: inv, alpha: 0.7 });
		}

		// The relation being dragged, and the node it would land on. Both are drawn
		// before the early return below, because a drag can start from a hovered node
		// that was never selected — there is no selection transform to gate on.
		if (connectionDraft) {
			const { from, to, size, targetFrame } = connectionDraft;
			if (targetFrame) {
				overlay
					.rect(
						targetFrame.x,
						targetFrame.y,
						targetFrame.width,
						targetFrame.height,
					)
					.stroke({ color: brand, width: 2 * inv, alpha: 0.9 });
			}
			overlay
				.moveTo(from.x, from.y)
				.lineTo(to.x, to.y)
				.stroke({
					color: brand,
					width: Math.max(size, 1.5) * inv,
					alpha: 0.85,
					cap: "round",
				});
			// A dot at the loose end reads as "this is where it will attach",
			// which a bare line end does not.
			overlay.circle(to.x, to.y, 3.5 * inv).fill({ color: brand, alpha: 0.95 });
		}

		// Ports are the only affordance for creating a relation, so they are drawn
		// whenever the editor says they are live — hover or selection, either tool.
		if (ports && ports.length > 0) {
			for (const port of ports) {
				const hovered =
					hoveredPort &&
					Math.abs(hoveredPort.x - port.x) < 0.001 &&
					Math.abs(hoveredPort.y - port.y) < 0.001;
				const r = (hovered ? port.radius * 1.5 : port.radius) * inv;
				overlay
					.circle(port.x, port.y, r)
					.fill({ color: palette.surface, alpha: 1 })
					.stroke({ color: brand, width: 1.5 * inv, alpha: hovered ? 1 : 0.8 });
			}
		}

		if (!transform || selection.length === 0) return;
		const source = transform.frame;
		traceFrame(overlay, source).stroke({
			color: brand,
			width: 1.5 * inv,
			alpha: 0.95,
		});
		if (!controls) return;

		// Arrow endpoints (or other custom handles) take priority over box chrome.
		if (arrowEndpoints && arrowEndpoints.length > 0) {
			const r = 5 * inv;
			for (const point of arrowEndpoints) {
				overlay
					.circle(point.x, point.y, r)
					.fill({ color: palette.surface, alpha: 1 })
					.stroke({ color: brand, width: 1.5 * inv });
			}
			return;
		}

		if (hoveredControl?.kind === "resize" && transform.resizeMode === "free") {
			const edge = frameEdgePoints(source, hoveredControl.handle);
			if (edge) {
				overlay
					.moveTo(edge[0].x, edge[0].y)
					.lineTo(edge[1].x, edge[1].y)
					.stroke({ color: brand, width: 2.5 * inv, alpha: 1 });
			}
		}

		if (transform.resizeMode !== "none") {
			for (const handle of CORNER_RESIZE_HANDLES) {
				const position = frameHandlePosition(source, handle);
				const hovered =
					hoveredControl?.kind === "resize" && hoveredControl.handle === handle;
				overlay
					.circle(position.x, position.y, (hovered ? 5 : 4) * inv)
					.fill({ color: hovered ? brand : palette.surface, alpha: 1 })
					.stroke({ color: brand, width: 1.5 * inv });
			}
		}

		if (
			transform.canRotate &&
			(pointerType === "touch" || transform.resizeMode === "none")
		) {
			const rotation = rotationPointer ?? rotationHandlePosition(source, zoom);
			const anchor = rotationPointer
				? frameRayIntersection(source, rotationPointer)
				: rotationHandleAnchor(source);
			const hovered =
				rotationPointer !== null || hoveredControl?.kind === "rotate";
			overlay
				.moveTo(anchor.x, anchor.y)
				.lineTo(rotation.x, rotation.y)
				.stroke({ color: brand, width: inv, alpha: 0.8 });
			overlay
				.circle(rotation.x, rotation.y, (hovered ? 6 : 5) * inv)
				.fill({ color: hovered ? brand : palette.surface })
				.stroke({ color: brand, width: 1.5 * inv });
		}
	}

	function destroy(context: BoardRenderContext) {
		for (const entry of cards.values())
			entry.renderer.destroy?.(entry.container, context);
		cards.clear();
		for (const pool of pools.values()) {
			for (const container of pool) container.destroy({ children: true });
		}
		pools.clear();
		for (const key of heldKeys.values()) context.releaseTexture(key);
		heldKeys.clear();
		orderById = new Map();
		connectionLayer.destroy();
		connectionsDrawn = false;
		farLayer.clear();
		farSig = null;
		farActive = false;
		visibleMemo = null;
		lastStructureVersion = -1;
	}

	return {
		sync,
		getNode: (nodeId) => {
			const entry = cards.get(nodeId);
			return entry ? { item: entry.item, container: entry.container } : null;
		},
		resolvedConnection: connectionLayer.resolved,
		drawOverlay,
		destroy,
	};
}
