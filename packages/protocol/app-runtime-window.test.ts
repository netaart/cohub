import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APP_RUNTIME_PROTOCOL,
  APP_RUNTIME_VERSION,
  buildAppRuntimeDrag,
  buildAppRuntimeDropConfig,
  buildAppRuntimeKey,
  buildAppRuntimeWindowState,
  parseAppRuntimeDrag,
  parseAppRuntimeDropConfig,
  parseAppRuntimeKey,
  parseAppRuntimeWindowState,
} from "./src/app-runtime.js";

const raw = (type: string, fields: Record<string, unknown>) => ({
  protocol: APP_RUNTIME_PROTOCOL,
  version: APP_RUNTIME_VERSION,
  type,
  ...fields,
});

test("window.state round-trips and bounds hostile input", () => {
  const state = { title: "Roadmap.board", status: "saving" as const, dirty: true };
  assert.deepEqual(parseAppRuntimeWindowState(buildAppRuntimeWindowState(state)), buildAppRuntimeWindowState(state));

  const hostile = parseAppRuntimeWindowState(raw("window.state", { title: `  ${"x".repeat(500)}\n`, status: "exploded", dirty: "yes" }));
  assert.equal(hostile?.title?.length, 120);
  assert.equal(hostile?.status, "idle");
  assert.equal(hostile?.dirty, false);
  assert.equal(parseAppRuntimeWindowState(raw("window.state", { title: "   " }))?.title, null);
  assert.equal(parseAppRuntimeWindowState({ type: "window.state" }), null);
});

test("key only crosses the frame for Ctrl or Meta chords", () => {
  const chord = { key: "k", code: "KeyK", altKey: false, ctrlKey: false, metaKey: true, shiftKey: false };
  assert.deepEqual(parseAppRuntimeKey(buildAppRuntimeKey(chord)), buildAppRuntimeKey(chord));
  assert.equal(parseAppRuntimeKey(raw("key", { ...chord, metaKey: false })), null);
  assert.equal(parseAppRuntimeKey(raw("key", { ...chord, key: "" })), null);
  assert.equal(parseAppRuntimeKey(raw("key", { ...chord, key: "V" })), null);
});

test("drop.config keeps known resource types only", () => {
  assert.deepEqual(parseAppRuntimeDropConfig(buildAppRuntimeDropConfig(["file", "task"]))?.accept, ["file", "task"]);
  assert.deepEqual(parseAppRuntimeDropConfig(raw("drop.config", { accept: ["file", "secret", "file"] }))?.accept, ["file"]);
  assert.deepEqual(parseAppRuntimeDropConfig(raw("drop.config", {}))?.accept, []);
});

test("drag hands resources over on drop only", () => {
  const resource = { type: "file" as const, ref: "boards/a.png", path: "boards/a.png", mimeType: "image/png", size: 12 };
  const over = buildAppRuntimeDrag({ phase: "over", x: 1, y: 2, types: ["file"], resources: [resource] });
  assert.equal("resources" in over, false);
  assert.equal(parseAppRuntimeDrag(raw("drag", { phase: "over", x: 1, y: 2, types: ["file"], resources: [resource] }))?.resources, undefined);

  const drop = parseAppRuntimeDrag(buildAppRuntimeDrag({ phase: "drop", x: 1, y: 2, types: ["file"], resources: [resource] }));
  assert.deepEqual(drop?.resources, [resource]);

  const hostile = parseAppRuntimeDrag(raw("drag", {
    phase: "drop",
    x: 0,
    y: 0,
    types: ["file"],
    resources: [{ type: "file", ref: "" }, { type: "unknown", ref: "x" }, { type: "task", ref: "t1", size: -1, snapshot: "no" }],
  }));
  assert.deepEqual(hostile?.resources, [{ type: "task", ref: "t1" }]);
  assert.equal(parseAppRuntimeDrag(raw("drag", { phase: "hover", x: 0, y: 0 })), null);
  assert.equal(parseAppRuntimeDrag(raw("drag", { phase: "over", x: Number.NaN, y: 0 })), null);
});
