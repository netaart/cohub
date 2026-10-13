import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { createSandboxRpcNonce, createSandboxRpcToken, resolveSandboxConnectionOptions, SandboxConnectionConfigError } from "../../../packages/sandbox-client/src/auth.js";

process.env.LOG_LEVEL = "silent";

type SandboxRow = { meta: Record<string, unknown>; status: string; podName: string; provider: string };
let row: SandboxRow = { meta: {}, status: "running", podName: "sandbox-space-a", provider: "cloud" };
let conflict = false;
let createError = false;
let candidateToken = "";
let events: string[] = [];
let writes = 0;
const mocks: Array<{ restore(): void }> = [];
function replace(specifier: string, namedExports: Record<string, unknown>) {
  mocks.push(mock.module(specifier, { namedExports }));
}

replace("../src/config.js", { sessionsNamespace: "test-sessions", config: { appEncryptionKey: "test-platform-key", sandboxImage: "test-image", env: "dev" } });
replace("../src/db/index.js", { db: {
  select: (fields?: unknown) => ({ from: () => ({ where: () => ({ limit: async () => fields ? [{ meta: {} }] : [row] }) }) }),
  insert: () => ({ values: (input: SandboxRow) => ({ onConflictDoUpdate: () => ({ returning: async () => {
    writes++; events.push("publish"); row = input; return [row];
  } }) }) }),
} });
replace("../src/k8s.js", { k8sCoreApi: {
  createNamespacedPod: async (input: { body: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } }) => {
    events.push("create");
    candidateToken = input.body.spec.containers[0]?.env.find((value) => value.name === "SANDBOX_RPC_TOKEN")?.value ?? "";
    if (createError) throw { statusCode: 503 };
    if (conflict) throw { statusCode: 409 };
  },
} });
replace("../src/sandbox-template.js", { renderSandboxPodTemplate: () => ({ spec: { containers: [{}], volumes: [] } }) });
replace("@cohub/billing", { billingOperations: { getState: async () => ({ entitlements: [] }) }, COHUB_BILLING_FEATURES: {} });
replace("@cohub/core/space-mods", { listEnabledSpaceMods: async () => [], getSpaceModMountSignature: () => "none" });
replace("@cohub/sandbox-client", {
  createSandboxRpcNonce, createSandboxRpcToken, resolveSandboxConnectionOptions, SandboxConnectionConfigError,
  SandboxRpcError: class extends Error {},
  getSandboxClientConnection: () => null,
  hasPendingSandboxRequests: () => false,
  disconnectSandboxWsClient: () => {},
  startSandboxWsClient: async () => {},
  waitForSandboxConnection: async () => ({ capabilities: { fsRead: true } }),
});
replace("../src/crypto.js", { createSandboxReportToken: () => "new-report-token", hashSandboxReportToken: () => "new-report-hash" });
replace("../src/redis.js", { redisCommandClient: {} });
replace("../src/sandbox-events.js", { publishSandboxLifecycleEvent: async () => {} });
replace("../src/sandbox-idle-scheduler.js", { scheduleSandboxAutoDestroy: async () => {} });
replace("../src/lib/sandbox/recovery.js", { smokeVerifySandboxPod: async () => {} });
replace("../src/sandbox-public-network.js", {
  deleteSandboxPublicNetwork: async () => {}, getSandboxPublicEndpoints: () => ({}),
  reconcileSandboxPublicNetwork: () => new Promise<void>(() => {}),
});

const { reconcileSpaceSandbox } = await import("../src/space-sandboxes.js");
const { getSandboxCapabilities, SandboxOfflineError } = await import("../src/space-sandbox-rpc.js");
after(() => { for (const item of mocks.reverse()) item.restore(); });

function reset() {
  row = { meta: { podIp: "10.0.0.1", rpcTokenNonce: createSandboxRpcNonce(), reportTokenHash: "old-report-hash" }, status: "running", podName: "sandbox-space-a", provider: "cloud" };
  conflict = false; createError = false; candidateToken = ""; events = []; writes = 0;
}
const input = { spaceId: "space-a", userUuid: "user-a", mode: "ensure", reason: "space_created" } as const;

test("ensure creation conflicts preserve existing credentials and status", async () => {
  reset(); conflict = true;
  const original = structuredClone(row);
  const originalConnection = resolveSandboxConnectionOptions({ spaceId: "space-a", sandbox: row, signingKey: "test-platform-key" });
  await reconcileSpaceSandbox(input);
  assert.deepEqual(row, original);
  assert.deepEqual(resolveSandboxConnectionOptions({ spaceId: "space-a", sandbox: row, signingKey: "test-platform-key" }), originalConnection);
  assert.equal(writes, 0);
  assert.deepEqual(events, ["create"]);
});

test("new credentials are published only after successful Pod creation", async () => {
  reset();
  await reconcileSpaceSandbox(input);
  assert.deepEqual(events, ["create", "publish"]);
  assert.equal(writes, 1);
  assert.equal(row.status, "provisioning");
  assert.equal(candidateToken, createSandboxRpcToken("test-platform-key", "space-a", String(row.meta.rpcTokenNonce)));
  assert.equal(row.meta.reportTokenHash, "new-report-hash");
});

test("failed Pod creation does not publish a new instance nonce", async () => {
  reset(); createError = true;
  const original = structuredClone(row);
  await assert.rejects(() => reconcileSpaceSandbox(input));
  assert.deepEqual(row, original);
  assert.equal(writes, 0);
});

test("API classifies invalid connection configuration as offline and accepts Pod-IP-only legacy instances", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  reset();
  for (const meta of [{}, { podIp: "10.0.0.1", rpcTokenNonce: "invalid" }, { podIp: "10.0.0.1", wsEndpoint: "ws://10.0.0.2:8788/sandbox" }]) {
    row.meta = meta;
    await assert.rejects(() => getSandboxCapabilities("space-a"), (error: unknown) =>
      error instanceof SandboxOfflineError && error.cause instanceof SandboxConnectionConfigError);
  }
  row.meta = { podIp: "10.0.0.1" };
  assert.deepEqual(await getSandboxCapabilities("space-a"), { fsRead: true });
});
