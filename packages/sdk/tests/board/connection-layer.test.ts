import assert from "node:assert/strict";
import { test } from "node:test";
import { type BoardConnection, createBoardConnection } from "@cohub/protocol/board-connection";
import type { BoardFrame } from "@cohub/protocol/board-document";
import { Container, type Graphics } from "pixi.js";
import { buildFallbackShapeColors } from "../../src/board/core/palette.js";
import {
	type ConnectionRenderInput,
	createConnectionLayer,
} from "../../src/board/render/connection-layer.js";

const colors = buildFallbackShapeColors("dark");

function frame(x: number, y: number): BoardFrame {
	return { x, y, width: 100, height: 60, rotation: 0 };
}

function relation(id: string, source: string, target: string, line: "solid" | "dashed" = "solid") {
	return createBoardConnection({
		id,
		sourceItemId: source,
		targetItemId: target,
		style: { line, size: 1, color: "neutral" },
	});
}

/** `count` dashed relations ~40k units long (~2350 dashes each). */
function longRelations(count: number) {
	const frames: Record<string, BoardFrame> = {};
	const relations: BoardConnection[] = [];
	for (let index = 0; index < count; index += 1) {
		frames[`s${index}`] = frame(0, index * 100);
		frames[`t${index}`] = frame(40_000, index * 100);
		relations.push(relation(`r${index}`, `s${index}`, `t${index}`, "dashed"));
	}
	return { frames, relations };
}

/** A layer that counts how often its base and live Graphics are cleared. */
function createHarness() {
	const layer = createConnectionLayer({ parent: new Container() });
	const rebuilds = { base: 0, live: 0 };
	const graphics = () => layer.children as Graphics[];
	let spied = false;
	return {
		rebuilds,
		base: () => graphics()[0] as Graphics,
		sync(input: ConnectionRenderInput) {
			layer.sync(input);
			if (spied) return;
			spied = true;
			for (const [key, target] of [
				["base", graphics()[0]],
				["live", graphics()[1]],
			] as const) {
				const clear = target.clear.bind(target);
				target.clear = () => {
					rebuilds[key] += 1;
					return clear();
				};
			}
		},
	};
}

function input(
	connections: BoardConnection[],
	frames: Record<string, BoardFrame>,
	overrides: Partial<ConnectionRenderInput> = {},
): ConnectionRenderInput {
	return {
		connections,
		getFrame: (id) => frames[id],
		colors,
		colorScheme: "dark",
		zoom: 1,
		...overrides,
	};
}

function subpaths(graphics: Graphics): number {
	let count = 0;
	for (const instruction of graphics.context.instructions) {
		const path = (instruction.data as { path?: { instructions: { action: string }[] } }).path;
		for (const step of path?.instructions ?? []) if (step.action === "moveTo") count += 1;
	}
	return count;
}

test("only relations touching moving nodes are redrawn", () => {
	const frames = { a: frame(0, 0), b: frame(600, 0), c: frame(0, 400), d: frame(600, 400) };
	const connections = [relation("ab", "a", "b"), relation("cd", "c", "d")];
	const live = new Set(["a"]);
	const harness = createHarness();
	harness.sync(input(connections, frames, { liveNodeIds: live }));
	harness.sync(input(connections, frames, { liveNodeIds: live }));
	harness.sync(input(connections, { ...frames, a: frame(10, 0) }, { liveNodeIds: live }));
	assert.deepEqual(harness.rebuilds, { base: 0, live: 1 });
});

test("past the dash budget every dashed relation is drawn solid", () => {
	const { frames, relations } = longRelations(40);
	const harness = createHarness();
	harness.sync(input(relations, frames));
	// One line plus one arrowhead per relation.
	assert.equal(subpaths(harness.base()), relations.length * 2);
});

test("hovering just under the dash budget neither degrades nor rebuilds", () => {
	const { frames, relations } = longRelations(17);
	const harness = createHarness();
	harness.sync(input(relations, frames));
	const dashed = subpaths(harness.base());
	harness.sync(input(relations, frames, { hoveredId: "r0" }));
	harness.sync(input(relations, frames, { hoveredId: null }));
	assert.equal(harness.rebuilds.base, 0);
	assert.equal(subpaths(harness.base()), dashed);
	assert.ok(dashed > relations.length * 100);
});
