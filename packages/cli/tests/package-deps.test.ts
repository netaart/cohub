import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("CLI package", () => {
  it("installs the SDK that App Actions import from the global CLI", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(pkg.dependencies["@neta-art/cohub"], "workspace:*");
  });
});
