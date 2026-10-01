import assert from "node:assert/strict";
import { test } from "node:test";
import { BoardError } from "@cohub/core/board";
import { boardErrorBody, boardErrorResponse, boardInputDiagnostics } from "./board-error.js";

test("Board errors keep their status, code and diagnostics", () => {
  const diagnostic = { severity: "error" as const, code: "INVALID_ITEM", path: "items.t.props", message: "unknown property fontSze" };
  const response = boardErrorResponse(new BoardError(400, "INVALID_ITEM", "items.t.props: unknown property fontSze", [diagnostic]));
  assert.equal(response.status, 400);
  assert.deepEqual(boardErrorBody(response), {
    code: "INVALID_ITEM",
    message: "items.t.props: unknown property fontSze",
    diagnostics: [diagnostic],
  });
});

test("input diagnostics carry full paths", () => {
  assert.deepEqual(boardInputDiagnostics({ issues: [{ path: ["patch", "items"], message: "Expected object" }] }), [
    { severity: "error", code: "INVALID_BOARD_INPUT", message: "Expected object", path: "input.patch.items" },
  ]);
});
