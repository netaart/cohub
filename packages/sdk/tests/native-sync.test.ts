import assert from "node:assert/strict";
import { test } from "node:test";
import { CohubHttpClient } from "../src/http.js";
import type { Fetch } from "../src/transport.js";

test("native Turn transport stays internal to the Runtime Daemon", () => {
  const fetch: Fetch = async () => new Response("{}", { status: 404 });
  const space = new CohubHttpClient({ baseUrl: "https://api.example.test", fetch }).space("space");
  assert.equal("startNativeTurn" in space, false);
  assert.equal("updateNativeTurn" in space, false);
  assert.equal("completeNativeTurn" in space, false);
  assert.equal("heartbeatNativeTurn" in space, false);
});
