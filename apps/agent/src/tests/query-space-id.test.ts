import assert from "node:assert/strict";
import test from "node:test";
import { Type, validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import { querySpaceIdParameter, resolveQuerySpaceId } from "../runtime/tools/query-space-id.js";

const CURRENT_SPACE_ID = "7017ac35-af78-4274-af06-69e84174427b";
const parameters = Type.Object({ space_id: querySpaceIdParameter });
const tool = { name: "read", description: "Read a file", parameters };

function validateSpaceId(spaceId: string | null | undefined) {
  const args: JsonObject = {};
  if (spaceId !== undefined) args.space_id = spaceId;
  return validateToolArguments(tool, { type: "toolCall", id: "query", name: tool.name, arguments: args }).space_id;
}

test("empty query space IDs pass tool validation and resolve to the current space", () => {
  for (const value of [
    undefined,
    null,
    "",
    "null",
    "undefined",
    "0",
    " \t\n",
    "00000000-0000-0000-0000-000000000000",
    "00000000000000000000000000000000",
    "00000000-0000-4000-8000-000000000000",
    "00000000000040008000000000000000",
    "00000000-0000-7000-a000-000000000000",
    "00000000-0000-8000-B000-000000000000",
    " 00000000-0000-4000-8000-000000000000 \n",
  ]) {
    assert.equal(resolveQuerySpaceId(validateSpaceId(value), CURRENT_SPACE_ID), CURRENT_SPACE_ID);
  }
});

test("a required serialized space ID accepts null as the current space", () => {
  const serialized = JSON.parse(JSON.stringify({ ...tool, parameters: { ...parameters, required: ["space_id"] } }));
  const args = validateToolArguments(serialized, {
    type: "toolCall", id: "query", name: tool.name, arguments: { space_id: null },
  });
  assert.equal(args.space_id, null);
  assert.equal(resolveQuerySpaceId(args.space_id, CURRENT_SPACE_ID), CURRENT_SPACE_ID);
});

test("nonempty UUIDs retain their explicit target, including UUIDs close to zero", () => {
  for (const value of [
    CURRENT_SPACE_ID,
    "70c83ade-1207-4f66-bb4a-08b6fe90e01b",
    "70c83ade12074f66bb4a08b6fe90e01b",
    "00000000-0000-4000-8000-000000000001",
    "00000000000040008000000000000001",
    "10000000-0000-4000-8000-000000000000",
    "00000000-0000-4001-8000-000000000000",
    "00000000-0000-4000-8001-000000000000",
    " 70c83ade-1207-4f66-bb4a-08b6fe90e01b ",
  ]) {
    assert.equal(resolveQuerySpaceId(validateSpaceId(value), CURRENT_SPACE_ID), value.trim());
  }
});

test("invalid nonempty space IDs fail validation and resolution", () => {
  for (const value of ["current", "-".repeat(36), "0".repeat(31), "0".repeat(33), "limit\u200b=30"]) {
    assert.throws(() => validateSpaceId(value), /Validation failed/);
    assert.throws(() => resolveQuerySpaceId(value, CURRENT_SPACE_ID), /Invalid space_id/);
  }
  for (const value of [0, false, [], {}]) {
    assert.throws(() => resolveQuerySpaceId(value, CURRENT_SPACE_ID), /Invalid space_id/);
  }
});
