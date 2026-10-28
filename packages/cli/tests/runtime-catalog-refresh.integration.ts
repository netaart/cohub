import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { runtimeHelloCapabilities, type RuntimeCapabilities, type RuntimeRegistration } from "@cohub/protocol";
import { createRuntimeRelay, type RuntimeRelayDependencies } from "../../../apps/gateway/src/relay/runtime-relay.js";
import { serveRuntime } from "../src/runtime/connection.js";
import { refreshHarnesses } from "../src/runtime/harnesses/index.js";
import { idleExecutor } from "./fixtures/runtime-native.js";
import { scratch } from "./fixtures/scratch.js";

const initial: RuntimeCapabilities = { harnesses: ["codex"], models: [{ harness: "codex", provider: "openai", id: "old", name: "Old" }] };
const updated: RuntimeCapabilities = { harnesses: ["codex"], models: [...initial.models, { harness: "codex", provider: "openai", id: "new", name: "New", reasoning: true, thinkingLevelMap: { ultra: "ultra" } }] };

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await delay(25);
  assert(condition());
}

for (const gateway of ["current", "legacy"] as const) test(`a changed catalog reaches the ${gateway} Gateway registration`, { timeout: 15_000 }, async () => {
  let registration: RuntimeRegistration | null = null;
  const deps: RuntimeRelayDependencies = {
    secret: "secret", endpoint: () => "ws://127.0.0.1:1/peer", authorize: async () => ({ ok: true, userId: "owner" }),
    claim: async (_space, record) => { registration = record; return true; },
    renew: async (_space, record) => registration === record,
    release: async (_space, record) => { if (registration === record) registration = null; },
    ...(gateway === "current" ? { update: async (_space: string, previous: RuntimeRegistration, next: RuntimeRegistration) => {
      if (registration !== previous) return false;
      registration = next;
      return true;
    } } : {}),
  };
  const relay = createRuntimeRelay(deps);
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const hellos: string[] = [];
  server.on("connection", (socket) => {
    socket.on("message", (raw) => { if (String(raw).includes('"runtime.hello"')) hellos.push(String(raw)); });
    relay.control(socket);
  });
  await once(server, "listening");
  const address = server.address(); assert(address && typeof address !== "string");
  const controller = new AbortController();
  const spaceId = crypto.randomUUID();
  let ready = 0;
  let catalog = initial;
  const running = serveRuntime({
    spaceId, cwd: scratch, url: `ws://127.0.0.1:${address.port}`, capabilities: initial,
    refreshCapabilities: async () => structuredClone(catalog), capabilitiesRefreshMs: 50,
    token: async () => "token", signal: controller.signal, executor: idleExecutor(spaceId), onReady: () => { ready++; },
  });
  try {
    await until(() => ready === 1);
    await delay(150);
    assert.deepEqual(registration?.capabilities, initial);
    catalog = updated;
    await until(() => registration?.capabilities.models.length === 2);
    // A Gateway without the update frame gets a fresh hello, which carries only the levels every Gateway reads.
    assert.deepEqual(registration?.capabilities, gateway === "current" ? updated : runtimeHelloCapabilities(updated));
    assert(hellos.every((hello) => !hello.includes("ultra")));
    await delay(150);
    assert.equal(ready, gateway === "current" ? 1 : 2);
  } finally {
    controller.abort();
    await running;
    await relay.closeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a harness whose discovery fails keeps its previous models", async () => {
  const current: RuntimeCapabilities = { harnesses: ["workbuddy"], models: [{ harness: "workbuddy", provider: "codebuddy", id: "kept", name: "Kept" }] };
  const failures: string[] = [];
  const next = await refreshHarnesses(current, { workbuddy: `${scratch}/missing-codebuddy` }, scratch, (harness) => failures.push(harness));
  assert.deepEqual(next, current);
  assert.deepEqual(failures, ["workbuddy"]);
});
