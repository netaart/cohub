import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMessageQueueConfig } from "../runtime/message-queue-config.js";

test("message queue config accepts both delivery modes", () => {
  assert.deepEqual(parseMessageQueueConfig("{\"version\":1,\"followupDelivery\":\"together\"}"), { version: 1, followupDelivery: "together" });
  assert.deepEqual(parseMessageQueueConfig("{\"version\":1,\"followupDelivery\":\"one_by_one\"}"), { version: 1, followupDelivery: "one_by_one" });
});

test("message queue config rejects unknown versions, modes and fields", () => {
  assert.throws(() => parseMessageQueueConfig("{\"version\":2,\"followupDelivery\":\"together\"}"), /Unsupported message queue config version/);
  assert.throws(() => parseMessageQueueConfig("{\"version\":1}"), /Unknown followupDelivery/);
  assert.throws(() => parseMessageQueueConfig("{\"version\":1,\"followupDelivery\":\"merge\"}"), /Unknown followupDelivery/);
  assert.throws(() => parseMessageQueueConfig("{\"version\":1,\"followupDelivery\":\"together\",\"extra\":true}"), /Unknown field/);
  assert.throws(() => parseMessageQueueConfig("[]"), /must be a JSON object/);
});
