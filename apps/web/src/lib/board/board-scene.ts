import type {
	BoardFrame,
	BoardSceneItem as BoardItem,
	BoardScene as BoardModelScene,
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
import { clippingAncestor, type ClipGroup, isClippingFrame, syncClipGroup } from "@neta-art/cohub/board/render";
import type { Container, Graphics } from "pixi.js";
import type {
	BoardSelectionTransform,
	BoardTransformControl,
} from "$lib/board/core/selection-transform";

type CardEntry = {
	item: BoardItem;
	container: Container;
	renderer: BoardCardRenderer;
	selected: boolean;
	hovered: boolean;
	resizing: boolean;
	globalSig: string;
};

const FAR_LAYER_ENTER = 450;
const FAR_LAYER_EXIT = 350;
const Z_FAR_LAYER = -1;
const Z_OVERLAY = Number.MAX_SAFE_INTEGER;

const POOL_LIMIT_PER_RENDERER = 48;

function idSetSignature(ids: Set<string>): number {
	let hash = ids.size;
	for (const id of ids) {
		let local = 0;
		for (let i = 0; i < id.length; i += 1) {
			local = (local * 31 + id.charCodeAt(i)) | 0;
		}
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
	items: readonly BoardItem[];
	scene: BoardModelScene;
	context: BoardRenderContext;
	getItem: (id: string) => BoardItem | null;
	visibleIds: Set<string> | null;
	pinnedIds: Set<string>;
	globalSig: string;
	structureVersion: number;
	geometryVersion: number;
	gestureActive: boolean;
};

export type SceneOverlayInput = {
	zoom: number;
	pointerType: string;
	marquee: Rect | null;
	selection: string[];
	transform: BoardSelectionTransform | null;
	controls: boolean;
	hoveredControl: BoardTransformControl | null;
	rotationPointer: WorldPoint | null;
	arrowEndpoints?: Array<{ x: number; y: number }>;
	ports?: ReadonlyArray<{ x: number; y: number; radius: number }>;
	hoveredPort?: { x: number; y: number } | null;
	arrowDraft?: {
		from: { x: number; y: number };
		to: { x: number; y: number };
		size: number;
		targetFrame: BoardFrame | null;
	} | null;
	bindTarget?: BoardFrame | null;
};

export type BoardSceneNode = {
	item: BoardItem;
	container: Container;
};

export type BoardScene = {
	sync: (input: SceneSyncInput) => void;
	getNode: (itemId: string) => BoardSceneNode | null;
	readonly animated: boolean;
	drawOverlay: (input: SceneOverlayInput, palette: BoardRenderPalette) => void;
	destroy: (context: BoardRenderContext) => void;
};

export function createBoardScene(options: {
	world: Container;
	farLayer: Graphics;
	overlay: Graphics;
	getRenderer: typeof getBoardCardRenderer;
	onFarLayerFrame?: () => void;
}): BoardScene {
	const { world, farLayer, overlay, getRenderer } = options;
	world.sortableChildren = true;
	farLayer.zIndex = Z_FAR_LAYER;
	overlay.zIndex = Z_OVERLAY;
	const cards = new Map<string, CardEntry>();
	const clips = new Map<string, ClipGroup>();
	const animatedIds = new Set<string>();
	const pools = new Map<string, Container[]>();
	const heldKeys = new Map<string, string>();
	let orderById = new Map<string, number>();
	let farSig: string | null = null;
	let farActive = false;
	let lastStructureVersion = -1;
	let farBuildToken = 0;
	let farBuildFrame = 0;

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

	function takeFromPool(rendererId: string): Container | null {
		const pool = pools.get(rendererId);
		if (!pool || pool.length === 0) return null;
		return pool.pop() ?? null;
	}

	function recycle(
		id: string,
		entry: CardEntry,
		context: BoardRenderContext,
		destroyed: boolean,
	) {
		setHeldKey(context, id, null);
		cards.delete(id);
		animatedIds.delete(id);
		if (destroyed) return;
		entry.container.parent?.removeChild(entry.container);
		entry.container.visible = false;
		const pool = pools.get(entry.renderer.id) ?? [];
		if (pool.length >= POOL_LIMIT_PER_RENDERER) {
			entry.renderer.destroy?.(entry.container, context);
			return;
		}
		pool.push(entry.container);
		pools.set(entry.renderer.id, pool);
	}

	function hostFor(item: BoardItem, scene: BoardModelScene): Container {
		const clipId = clippingAncestor(scene, item);
		const frame = clipId ? scene.get(clipId) : undefined;
		if (!clipId || !frame) return world;
		let entry = clips.get(clipId);
		if (!entry) {
			entry = syncClipGroup(undefined, frame);
			entry.group.sortableChildren = true;
			clips.set(clipId, entry);
		}
		const parent = hostFor(frame, scene);
		if (entry.group.parent !== parent) parent.addChild(entry.group);
		entry.group.zIndex = (orderById.get(clipId) ?? 0) + 0.5;
		return entry.group;
	}

	function syncClips(scene: BoardModelScene) {
		for (const entry of cards.values()) {
			const host = hostFor(entry.item, scene);
			if (entry.container.parent !== host) host.addChild(entry.container);
		}
		for (const [id, entry] of clips) {
			const frame = scene.get(id);
			if (!frame || !isClippingFrame(frame) || entry.group.children.length <= 1) {
				for (const child of [...entry.group.children]) if (child !== entry.mask) world.addChild(child);
				entry.group.destroy({ children: true });
				clips.delete(id);
				continue;
			}
			syncClipGroup(entry, frame);
		}
	}

	function materialize(
		item: BoardItem,
		context: BoardRenderContext,
		globalSig: string,
		scene: BoardModelScene,
	): CardEntry {
		const renderer = getRenderer(item, context);
		const pooled = takeFromPool(renderer.id);
		const container = pooled ?? renderer.create(item, context);
		container.visible = true;
		if (pooled) renderer.update(container, item, context);
		container.alpha = scene.opacity(item.id);
		hostFor(item, scene).addChild(container);
		if (renderer.animated) animatedIds.add(item.id);
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

	function rebuildFarLayer(input: SceneSyncInput, signature: string) {
		const { context, getItem, pinnedIds } = input;
		const ids = visibleFacts(input).orderedIds;
		const token = ++farBuildToken;
		farSig = signature;
		cancelAnimationFrame(farBuildFrame);
		farLayer.clear();
		let index = 0;
		const step = () => {
			if (token !== farBuildToken) return;
			const end = Math.min(ids.length, index + 240);
			for (; index < end; index += 1) {
				const id = ids[index] as string;
				if (pinnedIds.has(id)) continue;
				const item = getItem(id);
				if (!item) continue;
				getRenderer(item, context).renderFar?.(farLayer, item, context);
			}
			options.onFarLayerFrame?.();
			if (index < ids.length) farBuildFrame = requestAnimationFrame(step);
			else farBuildFrame = 0;
		};
		step();
	}

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
			scene,
			context,
			getItem,
			visibleIds,
			pinnedIds,
			globalSig,
			structureVersion,
			geometryVersion,
			gestureActive,
		} = input;

		const structureChanged = structureVersion !== lastStructureVersion;
		if (structureChanged) {
			lastStructureVersion = structureVersion;
			const liveIds = new Set(items.map((item) => item.id));
			for (const [id, entry] of [...cards]) {
				if (!liveIds.has(id)) recycle(id, entry, context, false);
			}
			orderById = new Map(items.map((item, index) => [item.id, index]));
		}

		const visibleCount = visibleIds === null ? items.length : visibleIds.size;
		const nextFarActive = farActive
			? visibleCount > FAR_LAYER_EXIT
			: visibleCount > FAR_LAYER_ENTER;
		const farModeChanged = nextFarActive !== farActive;
		farActive = nextFarActive;
		farLayer.visible = farActive;

		if (farActive) {
			const nextFarSig = [
				structureVersion,
				geometryVersion,
				globalSig,
				idSetSignature(pinnedIds),
				visibleIds === null ? "all" : visibleFacts(input).signature,
			].join("|");
			if (farSig === null || (nextFarSig !== farSig && !gestureActive)) {
				rebuildFarLayer(input, nextFarSig);
			}
		} else if (farModeChanged) {
			farBuildToken += 1;
			cancelAnimationFrame(farBuildFrame);
			farBuildFrame = 0;
			farLayer.clear();
			farSig = null;
		}

		const wanted = new Set<string>(pinnedIds);
		if (farActive) {
			const { unbatched } = visibleFacts(input);
			for (const id of unbatched) wanted.add(id);
		} else if (visibleIds === null) {
			for (const item of items) wanted.add(item.id);
		} else {
			for (const id of visibleIds) wanted.add(id);
		}

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
				world.removeChild(entry.container);
				entry.renderer.destroy?.(entry.container, context);
				recycle(id, entry, context, true);
				entry = undefined;
			}
			if (!entry) {
				materialize(item, context, globalSig, scene);
				liveSetChanged = true;
				continue;
			}

			const selected = context.selectedIds.has(id);
			const hovered = context.hoveredId === id;
			const resizing = context.resizingIds.has(id);
			const changed =
				item !== entry.item ||
				entry.renderer.animated ||
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
			if (changed) {
				entry.renderer.update(entry.container, item, context);
				entry.container.alpha = scene.opacity(id);
			}
		}
		if (structureChanged || liveSetChanged) syncClips(scene);

		if (structureChanged || farModeChanged || liveSetChanged) applyChildOrder();
	}

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
			arrowDraft,
			bindTarget,
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

		if (bindTarget) traceFrame(overlay, bindTarget).stroke({ color: brand, width: 2 * inv, alpha: 0.9 });
		if (arrowDraft) {
			const { from, to, size, targetFrame } = arrowDraft;
			if (targetFrame) traceFrame(overlay, targetFrame).stroke({ color: brand, width: 2 * inv, alpha: 0.9 });
			overlay
				.moveTo(from.x, from.y)
				.lineTo(to.x, to.y)
				.stroke({
					color: brand,
					width: Math.max(size, 1.5) * inv,
					alpha: 0.85,
					cap: "round",
				});
			overlay.circle(to.x, to.y, 3.5 * inv).fill({ color: brand, alpha: 0.95 });
		}

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
		for (const entry of clips.values()) entry.group.destroy({ children: true });
		clips.clear();
		animatedIds.clear();
		farLayer.clear();
		farSig = null;
		farActive = false;
		farBuildToken += 1;
		cancelAnimationFrame(farBuildFrame);
		farBuildFrame = 0;
		visibleMemo = null;
		lastStructureVersion = -1;
	}

	return {
		sync,
		getNode: (itemId) => {
			const entry = cards.get(itemId);
			return entry ? { item: entry.item, container: entry.container } : null;
		},
		get animated() {
			return animatedIds.size > 0;
		},
		drawOverlay,
		destroy,
	};
}
