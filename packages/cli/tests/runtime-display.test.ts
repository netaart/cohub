import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRuntimeDisplay } from "../src/runtime/launch.js";

test("screen sharing defaults to available desktops and respects opt-out", () => {
  assert.equal(parseRuntimeDisplay(undefined, "darwin", {}), "auto");
  assert.equal(parseRuntimeDisplay(undefined, "linux", { DISPLAY: ":0" }), "auto");
  assert.equal(parseRuntimeDisplay(undefined, "linux", {}), undefined);
  assert.equal(parseRuntimeDisplay(false, "darwin", {}), undefined);
  assert.equal(parseRuntimeDisplay("xvfb:1280x720", "linux", {}), "xvfb:1280x720");
  assert.throws(() => parseRuntimeDisplay(true, "linux", {}), /No X11 session/);
});
