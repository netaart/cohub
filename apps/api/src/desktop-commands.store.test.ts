import assert from "node:assert/strict";
import { test } from "node:test";
import { DESKTOP_COMMAND_ACCEPT_TIMEOUT_MS, type DesktopCommandRecord } from "@cohub/protocol/desktop-command";
import { acceptDesktopCommandRecord, type DesktopCommandStoreClient } from "./desktop-commands.store.js";

const createdAt = Date.parse("2026-01-01T00:00:00.000Z");

/** Mirrors the transition script: write only while pending and unaccepted. */
function fakeStore() {
  let raw: string | null = JSON.stringify({
    version: 1,
    commandId: "cmd-1",
    status: "pending",
    command: { type: "desktop.open", target: { kind: "file", path: "a.board" } },
    actorUserId: "user-1",
    targetClientId: "client-1",
    source: null,
    createdAt: new Date(createdAt).toISOString(),
    acceptedAt: null,
    settledAt: null,
  } satisfies DesktopCommandRecord);
  const client: DesktopCommandStoreClient = {
    get: async () => raw,
    eval: async (_script, _keys, _key, next) => {
      const current = JSON.parse(raw ?? "{}") as DesktopCommandRecord;
      if (current.settledAt) return [0, raw];
      if (current.acceptedAt) return [2, raw];
      raw = next ?? null;
      return [1, raw];
    },
  };
  return { client, stored: () => JSON.parse(raw ?? "null") as DesktopCommandRecord };
}

const accept = (client: DesktopCommandStoreClient, now: number, clientId = "client-1") =>
  acceptDesktopCommandRecord(client, { commandId: "cmd-1", actorUserId: "user-1", clientId }, now);

test("accepts a pending command idempotently", async () => {
  const { client, stored } = fakeStore();
  const first = await accept(client, createdAt + 1_000);
  assert.deepEqual(first, { ok: true, accepted: true, record: stored() });
  assert.deepEqual(await accept(client, createdAt + 2_000), first);
});

test("refuses and settles a command past its accept window", async () => {
  const { client, stored } = fakeStore();
  const result = await accept(client, createdAt + DESKTOP_COMMAND_ACCEPT_TIMEOUT_MS);
  assert.equal(result.ok && result.accepted, false);
  assert.equal(stored().status, "no_active_client");
});

test("rejects another tab", async () => {
  const { client } = fakeStore();
  assert.deepEqual(await accept(client, createdAt, "client-2"), { ok: false, reason: "forbidden" });
});
