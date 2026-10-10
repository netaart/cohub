import {
	type Point,
	type Rect,
	rectContainsPoint,
	rectsIntersect,
} from "../model/index.js";

/**
 * An indexed board item: its stable id, z-order (array index, higher = on
 * top), and an axis-aligned bounding box. The AABB already accounts for
 * rotation (see itemBounds), so the tree operates in world space and never
 * reasons about rotation directly — callers refine rotated hits themselves.
 */
export type SpatialEntry = {
	id: string;
	order: number;
	rect: Rect;
};

type QuadNode = {
	bounds: Rect;
	depth: number;
	entries: SpatialEntry[];
	children: QuadNode[] | null;
};

/** Max entries in a leaf before it subdivides. */
const NODE_CAPACITY = 8;
/** Deepest the tree may subdivide (bounds get tiny; stop splitting). */
const MAX_DEPTH = 10;
/** Subdivision stops once a cell is smaller than this (degenerate bounds). */
const MIN_CELL_SIZE = 1;
/**
 * When dirty entries exceed this fraction of the tree (or this absolute count),
 * a full rebuild is cheaper and more compact than many surgical removes.
 */
const REBUILD_DIRTY_RATIO = 0.25;
const REBUILD_DIRTY_MIN = 32;

function rectContainsRect(outer: Rect, inner: Rect): boolean {
	return (
		inner.x >= outer.x &&
		inner.y >= outer.y &&
		inner.x + inner.width <= outer.x + outer.width &&
		inner.y + inner.height <= outer.y + outer.height
	);
}

function quadrantBounds(bounds: Rect): Rect[] {
	const halfW = bounds.width / 2;
	const halfH = bounds.height / 2;
	const { x, y } = bounds;
	return [
		{ x, y, width: halfW, height: halfH },
		{ x: x + halfW, y, width: halfW, height: halfH },
		{ x, y: y + halfH, width: halfW, height: halfH },
		{ x: x + halfW, y: y + halfH, width: halfW, height: halfH },
	];
}

function createNode(bounds: Rect, depth: number): QuadNode {
	return { bounds, depth, entries: [], children: null };
}

function canSubdivide(node: QuadNode): boolean {
	return (
		node.depth < MAX_DEPTH &&
		node.bounds.width > MIN_CELL_SIZE &&
		node.bounds.height > MIN_CELL_SIZE
	);
}

function insertEntry(node: QuadNode, entry: SpatialEntry) {
	if (node.children) {
		// Descend into the single child that fully contains the entry; entries
		// spanning multiple children stay at this node (no duplication, so
		// queries never return the same id twice).
		for (const child of node.children) {
			if (rectContainsRect(child.bounds, entry.rect)) {
				insertEntry(child, entry);
				return;
			}
		}
		node.entries.push(entry);
		return;
	}

	node.entries.push(entry);
	if (node.entries.length <= NODE_CAPACITY || !canSubdivide(node)) return;

	node.children = quadrantBounds(node.bounds).map((bounds) =>
		createNode(bounds, node.depth + 1),
	);
	const kept: SpatialEntry[] = [];
	for (const existing of node.entries) {
		let placed = false;
		for (const child of node.children) {
			if (rectContainsRect(child.bounds, existing.rect)) {
				insertEntry(child, existing);
				placed = true;
				break;
			}
		}
		if (!placed) kept.push(existing);
	}
	node.entries = kept;
}

/** Remove an entry by id. Returns true if found. */
function removeEntry(node: QuadNode, id: string): boolean {
	const index = node.entries.findIndex((entry) => entry.id === id);
	if (index >= 0) {
		node.entries.splice(index, 1);
		return true;
	}
	if (!node.children) return false;
	for (const child of node.children) {
		if (removeEntry(child, id)) return true;
	}
	return false;
}

function queryRect(node: QuadNode, range: Rect, out: SpatialEntry[]) {
	if (!rectsIntersect(node.bounds, range)) return;
	for (const entry of node.entries) {
		if (rectsIntersect(entry.rect, range)) out.push(entry);
	}
	if (!node.children) return;
	for (const child of node.children) queryRect(child, range, out);
}

function queryPoint(node: QuadNode, point: Point, out: SpatialEntry[]) {
	if (!rectContainsPoint(node.bounds, point)) return;
	for (const entry of node.entries) {
		if (rectContainsPoint(entry.rect, point)) out.push(entry);
	}
	if (!node.children) return;
	for (const child of node.children) queryPoint(child, point, out);
}

export type SpatialIndex = {
	/** Rebuild the tree from scratch. */
	rebuild: (entries: SpatialEntry[]) => void;
	/**
	 * Apply a set of dirty entries: remove-then-insert each (or remove if
	 * absent from the map). Falls back to a full rebuild when the dirty set is
	 * large or when new entries fall outside the current root bounds.
	 */
	upsert: (entries: Map<string, SpatialEntry | null>) => void;
	/** Ids whose AABB intersects the range, in no particular order. */
	idsInRect: (range: Rect) => string[];
	/**
	 * Ids whose AABB contains the point, ordered topmost-first (highest
	 * z-order first) so callers can refine with an exact rotated hit test and
	 * take the first match.
	 */
	idsAtPoint: (point: Point) => string[];
	readonly size: number;
};

/**
 * A point quadtree over item bounding boxes. Supports both wholesale rebuild
 * (document load / large batch changes) and dirty-entry upsert (gesture frames)
 * so a drag never pays a full O(n) rebuild every frame.
 */
export function createSpatialIndex(): SpatialIndex {
	let root: QuadNode | null = null;
	/** Authoritative entry map — source of truth for rebuilds. */
	const byId = new Map<string, SpatialEntry>();

	function rebuildFromMap() {
		const entries = [...byId.values()];
		if (entries.length === 0) {
			root = null;
			return;
		}
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const entry of entries) {
			minX = Math.min(minX, entry.rect.x);
			minY = Math.min(minY, entry.rect.y);
			maxX = Math.max(maxX, entry.rect.x + entry.rect.width);
			maxY = Math.max(maxY, entry.rect.y + entry.rect.height);
		}
		const width = Math.max(maxX - minX, MIN_CELL_SIZE);
		const height = Math.max(maxY - minY, MIN_CELL_SIZE);
		// Pad the root slightly so small drifts during a gesture still fit.
		const pad = Math.max(width, height) * 0.05;
		root = createNode(
			{
				x: minX - pad,
				y: minY - pad,
				width: width + pad * 2,
				height: height + pad * 2,
			},
			0,
		);
		for (const entry of entries) insertEntry(root, entry);
	}

	function rebuild(entries: SpatialEntry[]) {
		byId.clear();
		for (const entry of entries) byId.set(entry.id, entry);
		rebuildFromMap();
	}

	function upsert(entries: Map<string, SpatialEntry | null>) {
		if (entries.size === 0) return;

		// Cheap dirty threshold: large batches just rebuild.
		const dirtyCount = entries.size;
		const total = Math.max(byId.size, 1);
		const shouldRebuild =
			dirtyCount >= REBUILD_DIRTY_MIN &&
			dirtyCount / total >= REBUILD_DIRTY_RATIO;

		// Apply to the authoritative map first.
		let expandsRoot = false;
		for (const [id, entry] of entries) {
			if (entry) {
				byId.set(id, entry);
				if (root && !rectContainsRect(root.bounds, entry.rect))
					expandsRoot = true;
			} else {
				byId.delete(id);
			}
		}

		if (!root || shouldRebuild || expandsRoot) {
			rebuildFromMap();
			return;
		}

		// Surgical update: remove old placement, insert new.
		for (const [id, entry] of entries) {
			removeEntry(root, id);
			if (entry) insertEntry(root, entry);
		}
	}

	function idsInRect(range: Rect): string[] {
		if (!root) return [];
		const hits: SpatialEntry[] = [];
		queryRect(root, range, hits);
		return hits.map((entry) => entry.id);
	}

	function idsAtPoint(point: Point): string[] {
		if (!root) return [];
		const hits: SpatialEntry[] = [];
		queryPoint(root, point, hits);
		hits.sort((a, b) => b.order - a.order);
		return hits.map((entry) => entry.id);
	}

	return {
		rebuild,
		upsert,
		idsInRect,
		idsAtPoint,
		get size() {
			return byId.size;
		},
	};
}
