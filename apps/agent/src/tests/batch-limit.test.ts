import assert from "node:assert/strict";
import { test } from "node:test";
import { limitBatchSize, limitBatchToApprovalMode, resolveBatchContextWindow } from "../runtime/batch-limit.js";

const turn = (size: number) => ({ size });

test("batches are bounded by message count, byte budget and always keep the owner", () => {
  const sizeOf = (item: { size: number }) => item.size;
  assert.deepEqual(limitBatchSize([turn(1), turn(2), turn(3)], sizeOf, { messages: 2, bytes: 100 }), [turn(1), turn(2)]);
  assert.deepEqual(limitBatchSize([turn(4), turn(4), turn(4)], sizeOf, { messages: 10, bytes: 9 }), [turn(4), turn(4)]);
  // A single input larger than the whole budget still runs alone; it cannot be split further.
  assert.deepEqual(limitBatchSize([turn(50), turn(1)], sizeOf, { messages: 10, bytes: 9 }), [turn(50)]);
  assert.deepEqual(limitBatchSize([], sizeOf, { messages: 10, bytes: 9 }), []);
});

test("a change of approval mode ends a batch so the owner's mode never covers earlier inputs", () => {
  const turn = (approvalMode?: string) => ({ meta: approvalMode ? { approvalMode } : {} });
  const same = [turn("read_only"), turn("read_only")];
  assert.deepEqual(limitBatchToApprovalMode(same), same);
  assert.deepEqual(limitBatchToApprovalMode([turn("read_only"), turn("full_access")]), [turn("read_only")]);
  assert.deepEqual(limitBatchToApprovalMode([turn(), turn("auto")]), [turn()]);
  assert.deepEqual(limitBatchToApprovalMode([turn(), turn()]), [turn(), turn()]);
});

test("a context window request on any merged follow-up applies, newest first", () => {
  const turn = (requestedContextWindow?: number) => ({ meta: requestedContextWindow ? { requestedContextWindow } : {} });
  assert.equal(resolveBatchContextWindow([turn(150_000), turn()]), 150_000);
  assert.equal(resolveBatchContextWindow([turn(150_000), turn(90_000)]), 90_000);
  assert.equal(resolveBatchContextWindow([turn(), { meta: null }]), undefined);
});
