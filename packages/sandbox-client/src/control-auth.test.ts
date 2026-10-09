import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { jwtVerify } from "jose";
import { createSandboxConnectionHeaders, getSandboxControlPublicKey } from "./control-auth.js";

test("cloud control credentials bind caller, space, audience and lifetime", async () => {
  const previous = process.env.SANDBOX_CONTROL_PRIVATE_KEY;
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  process.env.SANDBOX_CONTROL_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  try {
    assert.equal(getSandboxControlPublicKey(), publicKey.export({ type: "spki", format: "pem" }).toString());
    const headers = await createSandboxConnectionHeaders({ wsUrl: "ws://127.0.0.1:8788/sandbox", spaceId: "space-a", identity: "agent-a" });
    assert.ok(headers.Authorization);
    const { payload, protectedHeader } = await jwtVerify(headers.Authorization.slice(7), createPublicKey(getSandboxControlPublicKey()), {
      algorithms: ["EdDSA"], issuer: "cohub-platform", audience: "cohub-sandbox-control",
    });
    assert.equal(protectedHeader.alg, "EdDSA");
    assert.equal(payload.spaceId, "space-a");
    assert.equal(payload.sub, "agent-a");
    assert.ok(payload.exp && payload.iat);
    assert.equal(payload.exp - payload.iat, 60);
    await assert.rejects(jwtVerify(headers.Authorization.slice(7), publicKey, { currentDate: new Date(payload.exp * 1000) }));
    await assert.rejects(createSandboxConnectionHeaders({ wsUrl: "ws://127.0.0.1/sandbox", spaceId: "", identity: "agent-a" }));
    delete process.env.SANDBOX_CONTROL_PRIVATE_KEY;
    await assert.rejects(createSandboxConnectionHeaders({ wsUrl: "ws://127.0.0.1/sandbox", spaceId: "space-a", identity: "agent-a" }), /SANDBOX_CONTROL_PRIVATE_KEY/);
    assert.deepEqual(await createSandboxConnectionHeaders({ wsUrl: "ws://127.0.0.1/internal/sandbox-relay/space-a", spaceId: "space-a", identity: "agent-a", workerSecret: "relay-secret" }), { "x-worker-secret": "relay-secret" });
    await assert.rejects(createSandboxConnectionHeaders({ wsUrl: "ws://127.0.0.1/internal/sandbox-relay/space-a", spaceId: "space-a", identity: "agent-a" }), /WORKER_SECRET/);
  } finally {
    if (previous === undefined) delete process.env.SANDBOX_CONTROL_PRIVATE_KEY;
    else process.env.SANDBOX_CONTROL_PRIVATE_KEY = previous;
  }
});
