import assert from "node:assert/strict";
import { test } from "node:test";
import type { CohubClient } from "@neta-art/cohub";
import { CampSession, type SessionHandlers } from "./session.ts";

const handlers = (): SessionHandlers => ({
  onEvent() {}, onResync: async () => {}, onMembers() {}, onPose() {}, onDrag() {},
  onStroke() {}, onWave() {}, onTracks() {}, onTransport() {}, onNotice() {},
});

test("leaving while admission is pending releases the eventual seat", async () => {
  let admit!: (room: unknown) => void;
  let leaves = 0;
  const client = { app: { realtime: { joinRoom: () => new Promise((resolve) => { admit = resolve; }) } } } as unknown as CohubClient;
  const session = new CampSession(client, "CAMP-TEST", { name: "A", color: "#ffffff", mic: false, x: 0, y: 0 }, handlers());
  const joining = session.join();
  await session.leave();
  admit({ leave: async () => { leaves++; } });
  await assert.rejects(joining, /cancelled/);
  assert.equal(leaves, 1);
});

test("a failed resync retries and releases buffered durable events", async () => {
  let deliver!: (event: unknown) => void;
  let reads = 0;
  let restored = 0;
  let delivered = 0;
  const noop = () => () => {};
  const room = {
    participantId: "self", members: [], setPresence: async () => {},
    subscribeAll: (callback: typeof deliver) => { deliver = callback; return () => {}; },
    onMembersChanged: noop, onStateChange: noop, onOutOfSync: noop,
    history: async () => {
      reads++;
      if (reads === 2) throw new Error("Transient failure");
      return { events: [], cursor: 0, truncated: false };
    },
    leave: async () => {}, rtc: async () => { throw new Error("No RTC"); },
  };
  const callbacks = handlers();
  callbacks.onResync = async () => { restored++; };
  callbacks.onEvent = () => { delivered++; };
  const session = new CampSession({ app: { realtime: { joinRoom: async () => room } } } as unknown as CohubClient,
    "CAMP-TEST", { name: "A", color: "#ffffff", mic: false, x: 0, y: 0 }, callbacks);
  try {
    await session.join();
    session.resume();
    await assert.rejects(session.refresh(), /Transient/);
    deliver({ type: "camp.card", data: {}, sequence: 1, timestamp: 1, sender: { participantId: "other" }, self: false });
    assert.equal(delivered, 0);
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(restored, 1);
    assert.equal(delivered, 1);
  } finally {
    await session.leave();
  }
});

test("history truncation survives transport into the restore callback", async () => {
  const noop = () => () => {};
  const room = {
    participantId: "self", members: [], setPresence: async () => {},
    subscribeAll: noop, onMembersChanged: noop, onStateChange: noop, onOutOfSync: noop,
    history: async () => ({ events: [], cursor: 5, truncated: true }),
    leave: async () => {}, rtc: async () => { throw new Error("No RTC"); },
  };
  const client = { app: { realtime: { joinRoom: async () => room } } } as unknown as CohubClient;
  const session = new CampSession(client, "CAMP-TEST", { name: "A", color: "#ffffff", mic: false, x: 0, y: 0 }, handlers());
  try {
    const history = await session.join();
    assert.equal((history as { truncated?: boolean }).truncated, true);
  } finally {
    await session.leave();
  }
});
