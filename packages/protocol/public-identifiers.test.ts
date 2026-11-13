import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isReservedPublicIdentifier,
  parseSpaceSlug,
  parseUsername,
  validatePublicIdentifierAssignment,
} from "./src/public-identifiers.js";

describe("public identifier parsing", () => {
  it("keeps reserved historical usernames readable", () => {
    assert.equal(parseUsername(" Changelog "), "changelog");
    assert.equal(parseUsername("alice"), "alice");
    assert.equal(parseUsername("bad--name"), null);
  });

  it("enforces username hyphen and length boundaries", () => {
    for (const valid of ["a", "0", "a-b", "a-b-c", "a".repeat(39), `a${"-b".repeat(19)}`]) {
      assert.equal(parseUsername(valid), valid);
    }
    for (const invalid of ["", "-", "-a", "a-", "-a-", "a--b", "a".repeat(40), `a${"-b".repeat(19)}c`]) {
      assert.equal(parseUsername(invalid), null);
    }
  });

  it("parses canonical space slugs without changing case", () => {
    assert.equal(parseSpaceSlug("home_space"), "home_space");
    assert.equal(parseSpaceSlug("Home"), null);
  });
});

describe("public identifier assignment", () => {
  it("blocks platform paths for usernames and space slugs", () => {
    assert.deepEqual(validatePublicIdentifierAssignment("username", "docs"), {
      value: null,
      reason: "reserved",
    });
    assert.deepEqual(validatePublicIdentifierAssignment("spaceSlug", "settings"), {
      value: null,
      reason: "reserved",
    });
  });

  it("reserves nested public route discriminators only for space slugs", () => {
    assert.equal(isReservedPublicIdentifier("spaceSlug", "join"), true);
    assert.equal(isReservedPublicIdentifier("spaceSlug", "w"), true);
    assert.equal(isReservedPublicIdentifier("username", "join"), false);
    assert.equal(isReservedPublicIdentifier("username", "w"), false);
  });

  it("accepts ordinary public identifiers", () => {
    assert.deepEqual(validatePublicIdentifierAssignment("username", "alice-2"), {
      value: "alice-2",
      reason: null,
    });
    assert.deepEqual(validatePublicIdentifierAssignment("spaceSlug", "home"), {
      value: "home",
      reason: null,
    });
  });
});
