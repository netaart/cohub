import assert from "node:assert/strict";
import { test } from "node:test";
import { COHUB_APP_ORIGINS } from "@neta-art/cohub";
import { embedderOrigin, hasComposer, hostHasComposer, hostOriginsFor } from "../src/host/origins.ts";

const STUDIO_ORIGINS = {
  dev: "https://dev-studio.neta.art",
  prod: "https://neta.art",
} as const;

for (const env of ["dev", "prod"] as const) {
  test(`${env}: every Cohub origin plus that environment's Studio origin`, () => {
    const origins = hostOriginsFor(env);
    for (const origin of COHUB_APP_ORIGINS) {
      assert.ok(origins.includes(origin), `${env} misses ${origin}`);
    }
    assert.ok(origins.includes(STUDIO_ORIGINS[env]), `${env} misses its Studio origin`);
    const other = env === "dev" ? "prod" : "dev";
    assert.ok(!origins.includes(STUDIO_ORIGINS[other]), `${env} allows the other Studio origin`);
    assert.equal(new Set(origins).size, origins.length, "origins repeat");
  });
}

test("every Cohub App origin has a composer", () => {
  for (const origin of COHUB_APP_ORIGINS) assert.equal(hasComposer(origin), true, origin);
});

test("Studio and an unknown origin have no composer", () => {
  assert.equal(hasComposer("https://neta.art"), false);
  assert.equal(hasComposer("https://dev-studio.neta.art"), false);
  assert.equal(hasComposer("https://example.com"), false);
});

test("an empty or unreadable embedder origin has no composer", () => {
  assert.equal(hasComposer(""), false);
  assert.equal(hasComposer(null), false);
  assert.equal(hasComposer(undefined), false);
  assert.equal(embedderOrigin({ ancestorOrigins: [""], referrer: "not a url" }), null);
  assert.equal(embedderOrigin({ referrer: "" }), null);
  assert.equal(hasComposer(embedderOrigin({ ancestorOrigins: [""], referrer: "not a url" })), false);
});

test("the embedder origin is the nearest ancestor, with the referrer as fallback", () => {
  assert.equal(
    embedderOrigin({ ancestorOrigins: ["https://cohub.live"], referrer: "https://neta.art/some/page" }),
    "https://cohub.live",
  );
  assert.equal(
    embedderOrigin({ ancestorOrigins: ["", "https://neta.art"], referrer: "https://cohub.live/x" }),
    "https://cohub.live",
  );
  assert.equal(
    embedderOrigin({ referrer: "https://neta.art/spaces/one?x=1" }),
    "https://neta.art",
  );
});

test("the page's composer flag combines the embedder origin with the composer test", () => {
  assert.equal(hostHasComposer({ ancestorOrigins: ["https://cohub.live"] }, { referrer: "" }), true);
  assert.equal(
    hostHasComposer({ ancestorOrigins: ["https://neta.art"] }, { referrer: "https://cohub.live/spaces/one" }),
    false,
  );
  assert.equal(hostHasComposer({ ancestorOrigins: [] }, { referrer: "https://cohub.live/spaces/one" }), true);
  assert.equal(hostHasComposer({ ancestorOrigins: [] }, { referrer: "" }), false);
});
