import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { type CampEvent, EVENTS } from "./protocol.ts";
import { hasCampHistory, restoreCamp } from "./restore.ts";
import { decodeSnapshot, emptyCamp, encodeSnapshot, foldCamp, rebase } from "./state.ts";

const at = 1_700_000_000_000;
const ana = { name: "Ana", color: "#f4a261" };
const ben = { name: "Ben", color: "#8ecae6" };
const evening: CampEvent[] = [
  { type: EVENTS.card, data: { id: "card_one", text: "Lantern", x: 300, y: 200, by: ana }, sequence: 1, at },
  { type: EVENTS.card, data: { id: "card_two", text: "Fox", x: -400, y: 180, by: ben }, sequence: 2, at },
  { type: EVENTS.burn, data: { id: "card_two" }, sequence: 3, at },
  { type: EVENTS.wood, data: { name: "Ana", x: 0, y: 200 }, sequence: 4, at },
];

const snapshotOf = async (state: ReturnType<typeof emptyCamp>, key: string, startAt: number) => {
  const parts = await encodeSnapshot(state);
  return parts.map((data, part) => ({
    type: EVENTS.snapshot,
    data: { v: 1, key, upTo: state.sequence, part, parts: parts.length, data },
    sequence: startAt + part,
    at,
  }));
};

test("restores the newest snapshot and replays only the events after it", async () => {
  const snapshot = await snapshotOf(foldCamp(emptyCamp(), evening.slice(0, 2)), "snap_one", 10);
  const tail = evening.slice(2).map((event, index) => ({ ...event, sequence: 20 + index }));
  const restored = await restoreCamp([...snapshot, ...tail]);
  assert.equal(restored.from, "snapshot");
  assert.deepEqual([...restored.state.cards.keys()], ["card_one"]);
  assert.deepEqual([...restored.state.stars.keys()], ["card_two"]);
  assert.equal(restored.state.sequence, 21);
});

test("parts of racing snapshots are never mixed", async () => {
  const state = foldCamp(emptyCamp(), evening);
  const good = await encodeSnapshot(state);
  const other = await encodeSnapshot(emptyCamp());
  const part = (key: string, data: string, index: number, parts: number, sequence: number) => ({
    type: EVENTS.snapshot,
    data: { v: 1, key, upTo: state.sequence, part: index, parts, data },
    sequence,
    at,
  });
  const racing = [part("snap_good", good[0] as string, 0, good.length, 10), part("snap_other", other[0] as string, 0, other.length, 11)];
  for (const [index, data] of good.slice(1).entries()) racing.push(part("snap_good", data, index + 1, good.length, 12 + index));
  const restored = await restoreCamp(racing);
  assert.deepEqual([...restored.state.stars.keys()], [...state.stars.keys()]);
});

test("a camp carried into a fresh room restores without counting as history", async () => {
  const state = foldCamp(emptyCamp(), evening);
  const carried = (await snapshotOf(rebase(state), "snap_carry", 1)).map((event) => ({ ...event, data: { ...event.data as object, upTo: 0 } }));
  assert.equal(hasCampHistory(carried), false);
  const restored = await restoreCamp(carried);
  assert.deepEqual([...restored.state.cards.keys()], [...state.cards.keys()]);
  assert.deepEqual([...restored.state.stars.keys()], [...state.stars.keys()]);
});

test("incomplete or truncated history never restores as an empty camp", async () => {
  const [first] = await snapshotOf(foldCamp(emptyCamp(), evening), "snap_half", 9);
  const partial = first ? [{ ...first, data: { ...(first.data as object), upTo: 0, parts: 2 } }] : [];
  await assert.rejects(restoreCamp(partial), /incomplete/);
  await assert.rejects(restoreCamp(Object.assign([...evening], { truncated: true })), /incomplete/);
});

test("snapshot decompression stops at its size bound", async () => {
  const bomb = gzipSync(Buffer.alloc(3 * 1024 * 1024, 32)).toString("base64");
  assert.equal(await decodeSnapshot([bomb]), null);
});
