import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeNativeProgress, nativeProgressSnapshot } from "./native-progress-snapshot.js";

const identity = { spaceId: "space", sessionId: "session", turnId: "turn", userMessageId: "user" };
const message = (text: string) => ({ content: [{ type: "text" as const, text }] });

test("native progress carries only the changed tail; earlier messages stay from the snapshot", () => {
  const first = nativeProgressSnapshot(identity, { revision: 1, messages: [message("a"), message("b")] });
  const merged = mergeNativeProgress(first, identity, { revision: 2, from: 1, messages: [message("b2"), message("c")] });
  assert(merged);
  assert.deepEqual([...merged.snapshot.intermediateMessages, merged.snapshot.current].map((entry) => [entry.messageOrdinal, (entry.content[0] as { text: string }).text]), [[0, "a"], [1, "b2"], [2, "c"]]);
  assert.deepEqual(merged.changed.map((entry) => entry.messageOrdinal), [1, 2], "only changed messages are published");
  assert.equal(merged.snapshot.seq, 2);
});

test("native progress that builds on messages the snapshot lacks asks for a full resend", () => {
  const placeholder = nativeProgressSnapshot(identity, { revision: 1, messages: [] });
  assert.equal(mergeNativeProgress(placeholder, identity, { revision: 2, from: 1, messages: [message("b")] }), null);
  assert.equal(mergeNativeProgress(null, identity, { revision: 2, from: 1, messages: [message("b")] }), null);
  const other = nativeProgressSnapshot({ ...identity, turnId: "other" }, { revision: 1, messages: [message("a"), message("b")] });
  assert.equal(mergeNativeProgress(other, identity, { revision: 2, from: 1, messages: [message("b")] }), null, "another Turn's snapshot is never merged into");
  assert(mergeNativeProgress(null, identity, { revision: 2, messages: [message("a")] }), "a full send needs no snapshot");
});
