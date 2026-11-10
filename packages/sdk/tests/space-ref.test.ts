import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSpaceRef } from "../src/space-ref.js";
const ID = "f7000115-55d8-4d97-a0e4-d2a55b6ffa41";
test("Space refs accept Cohub Space URLs", () => {
  assert.deepEqual(parseSpaceRef(`https://cohub.live/alice/notes/sessions/${ID}?turn=2`), { kind: "public", username: "alice", slug: "notes" });
  assert.deepEqual(parseSpaceRef(`https://cohub.live/spaces/${ID}/settings`), { kind: "id", id: ID });
  assert.deepEqual(parseSpaceRef(`cohub://spaces/${ID}/sessions/${ID}`), { kind: "id", id: ID });
  assert.equal(parseSpaceRef("https://cohub.live/docs/cli"), null);
  assert.deepEqual(parseSpaceRef("alice/notes"), { kind: "public", username: "alice", slug: "notes" });
});
