import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseSpaceConfig,
  withNewChatBackground,
} from "./src/space-config.js";

test("a Space .board path is a Board background with its launch hash", () => {
  const config = parseSpaceConfig(
    JSON.stringify({ ui: { newChat: { background: { url: "./home.board#focus=cover" } } } }),
  );
  assert.deepEqual(config?.ui?.newChat?.background?.source, {
    kind: "space",
    path: "home.board",
    launch: "focus=cover",
  });
});

test("setting the background keeps other fields and never replaces a non-object", () => {
  const document = { ui: { workspace: { a: 1 }, newChat: { note: 1, background: { url: "x" } } }, b: 2 };
  assert.deepEqual(withNewChatBackground(document, { url: "y.board" }), {
    ui: { workspace: { a: 1 }, newChat: { note: 1, background: { url: "y.board" } } },
    b: 2,
  });
  assert.throws(() => withNewChatBackground({ ui: "dark" }, null));
});
