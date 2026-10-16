import assert from "node:assert/strict";
import test from "node:test";
import { limitApprovalBatch, readTurnApprovalMode } from "../runtime/approval-mode.js";

const turn = (codexApprovalMode?: string, harness = "codex") => ({ meta: { harness, ...(codexApprovalMode === undefined ? {} : { codexApprovalMode }) } });
test("queued inputs stop before an approval mode change", () => {
  const cases = [[turn("inherit"), turn()], [turn("inherit"), turn("auto")], [turn("read_only"), turn("full_access")], [turn(), turn("auto")], [turn("auto"), turn()], [turn("auto"), turn(undefined, "pi")]];
  for (const turns of cases) assert.deepEqual(limitApprovalBatch(turns), turns.slice(0, 1));
  const same = [turn("auto"), turn("auto")];
  assert.deepEqual(limitApprovalBatch(same), same);
  assert.deepEqual(limitApprovalBatch([]), []);
});
test("stored invalid modes fail explicitly, including a resolved non-Codex executor", () => {
  for (const bad of [turn("invalid"), turn("auto", "pi"), { meta: { codexApprovalMode: "auto" } }, { meta: { harness: "codex", codexApprovalMode: null } }]) {
    assert.throws(() => readTurnApprovalMode(bad.meta), /codexApprovalMode/);
  }
  assert.equal(readTurnApprovalMode(turn().meta), undefined);
  assert.equal(readTurnApprovalMode(turn("read_only").meta), "read_only");
  assert.equal(readTurnApprovalMode(turn("inherit").meta), "inherit");
});

test("omitted approval modes preserve legacy batching across harness changes", () => {
  const turns = [turn(undefined, "cohub"), turn(undefined, "pi"), turn(undefined, "codex")];
  assert.deepEqual(limitApprovalBatch(turns), turns);
  assert.deepEqual(limitApprovalBatch([...turns, turn("auto")]), turns);
});
