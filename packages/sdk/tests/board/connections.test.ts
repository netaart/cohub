import assert from "node:assert/strict";
import { test } from "node:test";
import { createBoardConnection } from "@cohub/protocol/board-connection";
import type { BoardFrame } from "@cohub/protocol/board-document";
import { worldPoint } from "../../src/board/geometry.js";
import {
	autoConnectionSide,
	connectionArrowheads,
	connectionBounds,
	connectionHitTest,
	createConnectionGeometryCache,
	createConnectionIndex,
	distanceToConnection,
	resolveConnection,
} from "../../src/board/core/connections.js";

/**
 * Connection geometry is the whole feature: a relation stores no coordinates, so
 * everything a user sees is produced here. These pin the properties that would be
 * visible as bugs — a line leaving the wrong edge, a connection that stops
 * tracking a moved node, a self-relation that collapses to a point.
 */

function frame(x: number, y: number, width = 100, height = 80, rotation = 0): BoardFrame {
	return { x, y, width, height, rotation };
}

function lookup(frames: Record<string, BoardFrame>) {
	return (id: string) => frames[id];
}

const connection = createBoardConnection({
	id: "c1",
	sourceItemId: "a",
	targetItemId: "b",
});

test("auto anchors pick the facing sides of both nodes", () => {
	const frames = { a: frame(0, 0), b: frame(400, 0) };
	const resolved = resolveConnection(connection, lookup(frames));
	assert.ok(resolved);
	assert.equal(resolved.source.side, "right");
	assert.equal(resolved.target.side, "left");
});

test("auto anchors follow a node to the other side when it moves past", () => {
	// The stored connection is unchanged; only the geometry moved. This is the
	// property that makes `auto` worth storing instead of a resolved side.
	const before = resolveConnection(connection, lookup({ a: frame(0, 0), b: frame(400, 0) }));
	const after = resolveConnection(connection, lookup({ a: frame(0, 0), b: frame(-400, 0) }));
	assert.equal(before?.source.side, "right");
	assert.equal(after?.source.side, "left");
});

test("a wide node prefers its long edge over the raw dominant axis", () => {
	// dx is smaller than dy here, but the source is wide and short, so the ray
	// still exits through the top. Comparing raw deltas would pick "right" and
	// draw the line out of a corner.
	const wide = frame(0, 0, 400, 40);
	const above = frame(60, -300, 100, 80);
	assert.equal(autoConnectionSide(wide, above), "top");
});

test("endpoints sit outside the node, not on its border", () => {
	const frames = { a: frame(0, 0), b: frame(400, 0) };
	const resolved = resolveConnection(connection, lookup(frames));
	assert.ok(resolved);
	// Source's right edge is x=100; the endpoint is pushed clear of it.
	assert.ok(resolved.source.point.x > 100, `expected a gap, got ${resolved.source.point.x}`);
	assert.ok(resolved.target.point.x < 400, `expected a gap, got ${resolved.target.point.x}`);
});

test("a missing endpoint resolves to null rather than a guess", () => {
	assert.equal(resolveConnection(connection, lookup({ a: frame(0, 0) })), null);
	assert.equal(resolveConnection(connection, lookup({})), null);
});

test("a self relation resolves to a real loop, not a degenerate point", () => {
	const self = createBoardConnection({ id: "s", sourceItemId: "a", targetItemId: "a" });
	const resolved = resolveConnection(self, lookup({ a: frame(0, 0) }));
	assert.ok(resolved);
	assert.ok(resolved.path.length >= 3);
	const bounds = connectionBounds(resolved, 2);
	assert.ok(bounds.width > 10 && bounds.height > 10);
});

test("a pinned side is honoured over the geometric choice", () => {
	const pinned = createBoardConnection({
		id: "c2",
		sourceItemId: "a",
		targetItemId: "b",
		sourceAnchor: { kind: "side", side: "bottom", offset: 0.5 },
	});
	const resolved = resolveConnection(pinned, lookup({ a: frame(0, 0), b: frame(400, 0) }));
	assert.equal(resolved?.source.side, "bottom");
});

test("waypoints are used verbatim as the path", () => {
	const routed = createBoardConnection({
		id: "c3",
		sourceItemId: "a",
		targetItemId: "b",
		routing: { kind: "straight", bend: 0, waypoints: [{ x: 200, y: -180 }] },
	});
	const resolved = resolveConnection(routed, lookup({ a: frame(0, 0), b: frame(400, 0) }));
	assert.ok(resolved);
	assert.equal(resolved.path.length, 3);
	assert.deepEqual(
		{ x: resolved.path[1]?.x, y: resolved.path[1]?.y },
		{ x: 200, y: -180 },
	);
});

test("orthogonal routing turns instead of cutting diagonally", () => {
	const elbow = createBoardConnection({
		id: "c4",
		sourceItemId: "a",
		targetItemId: "b",
		routing: { kind: "orthogonal", bend: 0, waypoints: [] },
	});
	const resolved = resolveConnection(elbow, lookup({ a: frame(0, 0), b: frame(400, 300) }));
	assert.ok(resolved);
	// Every segment is axis-aligned.
	for (let index = 0; index < resolved.path.length - 1; index += 1) {
		const from = resolved.path[index];
		const to = resolved.path[index + 1];
		assert.ok(from && to);
		const axisAligned =
			Math.abs(from.x - to.x) < 1e-6 || Math.abs(from.y - to.y) < 1e-6;
		assert.ok(axisAligned, `segment ${index} is diagonal`);
	}
});

test("hit testing tracks the line, not its bounding box", () => {
	const frames = { a: frame(0, 0), b: frame(400, 0) };
	const resolved = resolveConnection(connection, lookup(frames));
	assert.ok(resolved);
	const onLine = resolved.path[Math.floor(resolved.path.length / 2)];
	assert.ok(onLine);
	assert.ok(connectionHitTest(resolved, worldPoint(onLine.x, onLine.y), 2));
	assert.ok(distanceToConnection(resolved, worldPoint(onLine.x, onLine.y + 400)) > 100);
});

test("direction decides which ends carry a head", () => {
	const of = (direction: Parameters<typeof createBoardConnection>[0]["direction"]) =>
		connectionArrowheads(
			createBoardConnection({ id: "d", sourceItemId: "a", targetItemId: "b", direction }),
		);
	assert.deepEqual(of("forward"), { atSource: false, atTarget: true });
	assert.deepEqual(of("backward"), { atSource: true, atTarget: false });
	assert.deepEqual(of("both"), { atSource: true, atTarget: true });
	assert.deepEqual(of("none"), { atSource: false, atTarget: false });
});

test("the index finds a node's relations in both directions", () => {
	const index = createConnectionIndex([
		createBoardConnection({ id: "c1", sourceItemId: "a", targetItemId: "b" }),
		createBoardConnection({ id: "c2", sourceItemId: "c", targetItemId: "a" }),
		createBoardConnection({ id: "c3", sourceItemId: "b", targetItemId: "c" }),
	]);
	assert.deepEqual([...index.byNode("a")].sort(), ["c1", "c2"]);
	assert.deepEqual([...index.byNode("b")].sort(), ["c1", "c3"]);
	assert.deepEqual(index.byNode("missing"), []);
	assert.equal(index.get("c2")?.source.itemId, "c");
});

test("a self relation is indexed once, not twice", () => {
	const index = createConnectionIndex([
		createBoardConnection({ id: "s", sourceItemId: "a", targetItemId: "a" }),
	]);
	assert.deepEqual(index.byNode("a"), ["s"]);
});

test("a rotated node's connection leaves along the rotated edge", () => {
	// The anchor is on the source's right edge; rotating the node 90° should send
	// the outgoing normal downward rather than keeping it pointing right.
	const upright = resolveConnection(connection, lookup({ a: frame(0, 0), b: frame(400, 0) }));
	const rotated = resolveConnection(
		connection,
		lookup({ a: frame(0, 0, 100, 80, 90), b: frame(400, 0) }),
	);
	assert.ok(upright && rotated);
	assert.ok(Math.abs(upright.source.normal.x - 1) < 1e-6);
	assert.ok(Math.abs(rotated.source.normal.y - 1) < 1e-6);
});

test("the geometry cache reuses a resolve until the relation or an endpoint changes", () => {
	const cache = createConnectionGeometryCache();
	const frames = { a: frame(0, 0), b: frame(400, 0) };
	const first = cache.get(connection, lookup(frames));
	assert.ok(first);
	// Same records, same object: renderers detect "nothing moved" by identity.
	assert.equal(cache.get(connection, lookup(frames)), first);

	const moved = { ...frames, b: frame(400, 300) };
	const afterMove = cache.get(connection, lookup(moved));
	assert.ok(afterMove && afterMove !== first);
	assert.ok((afterMove.resolved.target.point.y ?? 0) > 0);

	const restyled = { ...connection, style: { ...connection.style, size: 4 } };
	assert.notEqual(cache.get(restyled, lookup(moved)), afterMove);
});
