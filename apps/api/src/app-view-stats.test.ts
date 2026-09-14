import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAppTotalViews, parseCachedTotalViews } from "./app-view-stats.js";

/** Fake Redis that satisfies the narrow client the module depends on. */
function fakeRedis(value: string | null) {
  let setCalls = 0;
  return {
    redis: {
      status: "ready",
      hincrby: async () => 0,
      get: async () => value,
      set: async () => {
        setCalls += 1;
        return "OK";
      },
    },
    get setCalls() {
      return setCalls;
    },
  };
}

describe("parseCachedTotalViews", () => {
  it("accepts non-negative safe integers", () => {
    assert.equal(parseCachedTotalViews("0"), 0);
    assert.equal(parseCachedTotalViews("1234"), 1234);
  });

  it("rejects corrupted entries instead of coercing them to zero", () => {
    for (const value of [null, "", "abc", "-5", "1.5", "1e3", "9007199254740992"]) {
      assert.equal(parseCachedTotalViews(value), null, `expected ${value} to be rejected`);
    }
  });
});

describe("getAppTotalViews", () => {
  it("serves a cached total without querying or writing back", async () => {
    const fake = fakeRedis("1234");
    assert.equal(await getAppTotalViews("app-1", fake.redis), 1234);
    assert.equal(fake.setCalls, 0);
  });
});
