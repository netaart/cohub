import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyBoardPatchToDocument,
	createDocumentLayout,
	diffBoardDocuments,
	emptyBoardDocument,
	layoutBoardText,
	listBoardProperties,
	parseBoardDocument,
	resolveBoardProperty,
	upgradeBoardSnapshotV2,
	type BoardDocument,
	type BoardPatch,
} from "./src/index.js";

function apply(document: BoardDocument, patch: BoardPatch, options?: { cascade?: boolean }) {
	const result = applyBoardPatchToDocument(document, patch, options);
	if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.path}: ${d.message}`).join("\n"));
	return result;
}

test("items fill defaults, stack on top and round-trip whole", () => {
	const { document } = apply(emptyBoardDocument(), {
		items: {
			a: { type: "shape", position: { x: 10, y: 20 } },
			b: { type: "text", props: { text: "Hi" } },
		},
	});
	assert.equal(document.items.a?.type, "shape");
	assert.deepEqual(document.items.a && "size" in document.items.a ? document.items.a.size : null, { width: 240, height: 160 });
	assert.equal(document.items.a?.z, 1);
	assert.equal(document.items.b?.z, 2);
	// A written value carries its defaults, so parsing it back is the identity.
	const stored = { board: document.board, items: { ...document.items }, animations: { ...document.animations } };
	const reparsed = parseBoardDocument(stored);
	assert.ok(reparsed.ok);
	assert.deepEqual(reparsed.ok && reparsed.document, document);
});

test("patches merge fields, delete with null and report unknown properties", () => {
	const { document } = apply(emptyBoardDocument(), { items: { t: { type: "text", props: { text: "a", fontSize: 30 } } } });
	const { document: next, before, after } = apply(document, { items: { t: { props: { text: "b" } } } });
	assert.equal(next.items.t?.type === "text" && next.items.t.props.fontSize, 30);
	assert.equal(next.items.t?.type === "text" && next.items.t.props.text, "b");
	assert.ok(before.items?.t && after.items?.t);
	const invalid = applyBoardPatchToDocument(next, { items: { t: { props: { fontSze: 3 } } } });
	assert.ok(!invalid.ok);
	assert.equal(!invalid.ok && invalid.diagnostics[0]?.path, "items.t.props");
	assert.match(!invalid.ok ? invalid.diagnostics[0]?.message ?? "" : "", /unknown property fontSze/);
	const deleted = apply(next, { items: { t: null } });
	assert.equal(deleted.document.items.t, undefined);
	assert.equal(deleted.before.items?.t?.type, "text");
});

test("colors accept tokens and CSS but reject typos", () => {
	assert.ok(applyBoardPatchToDocument(emptyBoardDocument(), { items: { a: { type: "shape", style: { fill: "#ff0000", stroke: { light: "black", dark: "white" } } } } }).ok);
	assert.ok(!applyBoardPatchToDocument(emptyBoardDocument(), { items: { a: { type: "shape", style: { fill: "blu" } } } }).ok);
});

test("parents must be frames, cannot cycle and block deletes without cascade", () => {
	const { document } = apply(emptyBoardDocument(), {
		items: {
			f: { type: "frame" },
			g: { type: "frame", parent: "f" },
			s: { type: "shape", parent: "g" },
		},
	});
	assert.ok(!applyBoardPatchToDocument(document, { items: { x: { type: "shape", parent: "s" } } }).ok);
	assert.ok(!applyBoardPatchToDocument(document, { items: { f: { parent: "g" } } }).ok);
	assert.ok(!applyBoardPatchToDocument(document, { items: { f: null } }).ok);
	const cascaded = apply(document, { items: { f: null } }, { cascade: true });
	assert.deepEqual(Object.keys(cascaded.document.items), []);
});

test("children inherit parent transforms", () => {
	const { document } = apply(emptyBoardDocument(), {
		items: {
			f: { type: "frame", position: { x: 100, y: 100 }, size: { width: 200, height: 100 }, rotation: 90 },
			s: { type: "shape", parent: "f", position: { x: 0, y: 0 }, size: { width: 20, height: 10 } },
		},
	});
	const layout = createDocumentLayout(document.items);
	const bounds = layout.bounds("s");
	// The frame rotates 90° about its center (200, 150); the child's top-left corner lands at (250, 50).
	assert.ok(Math.abs(bounds.x - 240) < 1e-6 && Math.abs(bounds.y - 50) < 1e-6, JSON.stringify(bounds));
	assert.ok(Math.abs(layout.frame("s").rotation - 90) < 1e-6);
});

test("arrows bind to items and fall back to a point when the item goes", () => {
	const { document } = apply(emptyBoardDocument(), {
		items: {
			a: { type: "shape", position: { x: 0, y: 0 }, size: { width: 100, height: 100 } },
			b: { type: "shape", position: { x: 300, y: 0 }, size: { width: 100, height: 100 } },
			l: { type: "arrow", props: { start: { item: "a" }, end: { item: "b" } } },
		},
	});
	const layout = createDocumentLayout(document.items);
	assert.deepEqual(layout.arrowEnd("l", "start"), { x: 100, y: 50 });
	assert.deepEqual(layout.arrowEnd("l", "end"), { x: 300, y: 50 });
	const { document: next } = apply(document, { items: { b: null } });
	const arrow = next.items.l;
	assert.ok(arrow?.type === "arrow");
	assert.deepEqual(arrow.type === "arrow" && arrow.props.end, { x: 300, y: 50 });
	assert.ok(!applyBoardPatchToDocument(document, { items: { l: { props: { end: { item: "missing" } } } } }).ok);
});

test("media time and text caret are animatable properties", () => {
	assert.equal(resolveBoardProperty("audio", "props.time").ok, true);
	assert.ok(listBoardProperties("video").some((entry) => entry.property === "props.time"));
	const parsed = parseBoardDocument({ items: { text: { type: "text", props: { text: "hello", caret: true } }, audio: { type: "audio", props: { src: "music.mp3", time: 1200 } } } });
	assert.ok(parsed.ok);
	assert.equal(parsed.ok && parsed.document.items.text?.type === "text" && parsed.document.items.text.props.caret, true);
	assert.equal(parsed.ok && parsed.document.items.audio?.type === "audio" && parsed.document.items.audio.props.time, 1200);
});

test("tracks drive schema properties and nest animations without cycles", () => {
	const base = apply(emptyBoardDocument(), { items: { t: { type: "text", props: { text: "x" } } } }).document;
	const { document } = apply(base, {
		animations: {
			intro: {
				duration: 1000,
				tracks: {
					fade: { target: "t", property: "opacity", keyframes: [{ at: 0, value: 0 }, { at: 500, value: 1, ease: "ease-out" }] },
					color: { target: "t", property: "style.fill", keyframes: [{ at: 0, value: "blue" }, { at: 500, value: "#f00" }] },
				},
			},
			show: { duration: 5000, tracks: { play: { target: "intro", property: "time", keyframes: [{ at: 0, value: 0 }, { at: 1000, value: 1000 }] } } },
		},
	});
	assert.equal(Object.keys(document.animations.intro?.tracks ?? {}).length, 2);
	assert.ok(!applyBoardPatchToDocument(document, { animations: { intro: { tracks: { loop: { target: "show", property: "time", keyframes: [{ at: 0, value: 0 }] } } } } }).ok);
	assert.ok(!applyBoardPatchToDocument(document, { animations: { intro: { tracks: { bad: { target: "t", property: "props.fontSze", keyframes: [{ at: 0, value: 1 }] } } } } }).ok);
	assert.ok(!applyBoardPatchToDocument(document, { animations: { intro: { tracks: { bad: { target: "t", property: "opacity", keyframes: [{ at: 0, value: 3 }] } } } } }).ok);
	assert.ok(!applyBoardPatchToDocument(document, { items: { t: null } }).ok);
	assert.ok(applyBoardPatchToDocument(document, { items: { t: null } }, { cascade: true }).ok);
	const fill = resolveBoardProperty("text", "style.fill");
	assert.equal(fill.ok && fill.spec.kind, "color");
	assert.equal(resolveBoardProperty("shape", "scale").ok && (resolveBoardProperty("shape", "scale") as { spec: { kind: string } }).spec.kind, "scale");
	assert.ok(listBoardProperties("text").some((entry) => entry.property === "props.reveal" && entry.kind === "number"));
});

test("diffs are minimal merge patches", () => {
	const before = apply(emptyBoardDocument(), { items: { a: { type: "shape" }, b: { type: "text", props: { text: "x" } } } }).document;
	const after = apply(before, { items: { a: { position: { x: 5 } }, b: null, c: { type: "frame" } } }).document;
	const patch = diffBoardDocuments(before, after);
	// A changed item carries only what moved; a new one is written whole.
	assert.deepEqual(patch.items?.a, { position: { x: 5 } });
	assert.equal(patch.items?.b, null);
	assert.deepEqual(patch.items?.c, { ...after.items.c, z: 3 });
});

test("text size follows fontSize and wraps at width", () => {
	const single = layoutBoardText({ text: "hello world", fontSize: 20, fontWeight: 500, font: "sans", lineHeight: 1.5 });
	assert.equal(single.lines.length, 1);
	assert.equal(single.height, 30);
	const wrapped = layoutBoardText({ text: "hello world hello world", fontSize: 20, fontWeight: 500, font: "sans", lineHeight: 1.5, width: 80 });
	assert.ok(wrapped.lines.length > 1);
	assert.equal(wrapped.width >= 80, true);
	const cjk = layoutBoardText({ text: "相对论讲解", fontSize: 20, fontWeight: 500, font: "sans", lineHeight: 1.5, width: 45 });
	assert.ok(cjk.lines.length >= 2);
});

test("v2 snapshots upgrade to v3 documents", () => {
	const patch = upgradeBoardSnapshotV2({
		board: { title: "T", metadata: { appearance: { background: { kind: "dots" } }, playback: { compositionId: "intro", delayMs: 300 } } },
		items: [
			{ id: "t", type: "text", position: { x: 1, y: 2 }, props: { text: "Hi", fontSize: 30 }, style: { color: "blue" } },
			{ id: "g", type: "geo", position: { x: 0, y: 0 }, size: { width: 10, height: 10 }, props: { shape: "ellipse", text: "" }, style: { color: "green", fillOpacity: 0.2 } },
			{ id: "i", type: "image", position: { x: 0, y: 0 }, size: { width: 10, height: 10 }, props: {}, source: { kind: "space-file", path: "a.png" } },
		],
		connections: [{ id: "c", source: { itemId: "t", anchor: { kind: "auto" } }, target: { itemId: "g", anchor: { kind: "side", side: "left", offset: 0.5 } }, relation: "related", direction: "forward", label: "", routing: { kind: "curve", bend: 0, waypoints: [] }, style: { color: "brand", size: 2.5, line: "dashed" } }],
		compositions: [{
			id: "intro",
			name: "Intro",
			timeline: {
				duration: 1000,
				tracks: [{ id: "r", target: { type: "item", itemId: "g" }, channel: "transform.rotation", keyframes: [{ time: 0, value: 0 }, { time: 1000, value: Math.PI, easing: "ease-out-cubic" }] }],
				clips: [{ id: "rev", kind: "text.reveal", target: { type: "item", itemId: "t" }, start: 0, duration: 500 }],
				markers: [],
			},
			playback: { endBehavior: "hold" },
		}],
	});
	const parsed = parseBoardDocument(patch);
	assert.ok(parsed.ok, JSON.stringify(parsed));
	if (!parsed.ok) return;
	assert.equal(parsed.document.items.g?.type, "shape");
	assert.equal(parsed.document.items.c?.type, "arrow");
	assert.equal(parsed.document.animations.intro?.play, "auto");
	assert.equal(parsed.document.animations.intro?.delay, 300);
	const rotation = parsed.document.animations.intro?.tracks.r;
	assert.equal(rotation?.composite, "add");
	assert.ok(Math.abs(Number(rotation?.keyframes[1]?.value) - 180) < 1e-9);
	assert.equal(parsed.document.animations.intro?.tracks.rev?.property, "props.reveal");
});

test("an overlapping camera tour upgrades to ordered keyframes", () => {
	const node = (id: string) => ({ id, type: "geo", position: { x: 0, y: 0 }, size: { width: 10, height: 10 }, props: {}, style: {} });
	// The second clip starts before the first ends, so the hold lands early.
	const patch = upgradeBoardSnapshotV2({
		board: { title: "T", metadata: {} },
		items: [node("a"), node("b")],
		compositions: [{
			id: "tour",
			name: "Tour",
			timeline: {
				duration: 2000,
				tracks: [],
				clips: [
					{ id: "f1", kind: "camera.focus", start: 0, duration: 1000, params: { focus: { type: "item", itemId: "a" } } },
					{ id: "f2", kind: "camera.focus", start: 500, duration: 1500, params: { focus: { type: "item", itemId: "b" } } },
				],
				markers: [],
			},
			playback: { endBehavior: "hold" },
		}],
	});
	const parsed = parseBoardDocument(patch);
	assert.ok(parsed.ok, JSON.stringify(parsed.ok ? [] : parsed.diagnostics));
	if (!parsed.ok) return;
	const keyframes = parsed.document.animations.tour?.tracks["camera-focus"]?.keyframes ?? [];
	// `b` takes the camera at 500 while `a` is still travelling, so the camera keeps
	// showing `a` until `a` arrives at 1000; `b` arrives at 2000.
	assert.deepEqual(keyframes.map((keyframe) => [keyframe.at, keyframe.value]), [[0, "a"], [1000, "a"], [2000, "b"]]);
});

test("a new animation without duration lasts until its last keyframe", () => {
	const document = emptyBoardDocument();
	const result = applyBoardPatchToDocument(document, {
		items: { a: { type: "shape" } },
		animations: { intro: { tracks: { fade: { target: "a", property: "opacity", keyframes: [{ at: 0, value: 0 }, { at: 1200, value: 1 }] } } } },
	});
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.document.animations.intro?.duration, 1200);
	const empty = applyBoardPatchToDocument(document, { animations: { intro: {} } });
	assert.equal(empty.ok, false);
});
