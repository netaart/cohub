import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { createSandboxRpcNonce, createSandboxRpcToken, resolveSandboxConnectionOptions, SandboxConnectionConfigError } from "../../../packages/sandbox-client/src/auth.js";
import { getSandboxPromptRecoveryReason } from "@cohub/sandbox-controller";

process.env.LOG_LEVEL = "silent";

type SandboxRow = { meta: Record<string, unknown>; status: string; podName: string; provider: string };
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}
let row: SandboxRow | null = null;
let conflict = false;
let createError = false;
let candidateToken = "";
let activePod: { uid: string; token: string } | null = null;
let creates = 0;
let events: string[] = [];
let firstCreatePause: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | null = null;
let publishPause: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | null = null;
let claimPause: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | null = null;
let replacementPublished = gate();
let replacementReady: ReturnType<typeof gate> | null = null;
const redisValues = new Map<string, string>();
const redisExpiry = new Map<string, number>();
const leaseKey = "sandbox:recover:space-a";
let renewals = 0;
const dialect = new PgDialect();
function generationMatches(predicate?: SQL): boolean {
  if (!predicate) return true;
  const query = dialect.sqlToQuery(predicate);
  if (!query.sql.includes("provisioningGeneration")) return true;
  return (row?.meta.provisioningGeneration ?? null) === query.params.at(-1);
}
function redisGet(key: string) {
  if ((redisExpiry.get(key) ?? Infinity) <= Date.now()) redisValues.delete(key);
  return redisValues.get(key) ?? null;
}
const mocks: Array<{ restore(): void }> = [];
function replace(specifier: string, namedExports: Record<string, unknown>) {
  mocks.push(mock.module(specifier, { namedExports }));
}

replace("../src/config.js", { sessionsNamespace: "test-sessions", config: { appEncryptionKey: "test-platform-key", sandboxImage: "test-image", env: "dev" } });
replace("../src/db/index.js", { db: {
  select: (fields?: unknown) => ({ from: () => ({ where: () => ({ limit: async () => fields ? [{ meta: {} }] : row ? [row] : [] }) }) }),
  insert: () => ({ values: (input: SandboxRow) => ({ onConflictDoUpdate: (options: { setWhere?: SQL }) => ({ returning: async () => {
    const pause = claimPause; claimPause = null;
    if (pause) { pause.entered.open(); await pause.release.promise; }
    if (row && !generationMatches(options.setWhere)) return [];
    row = row ? { ...row, meta: { ...row.meta, ...input.meta } } : input;
    events.push("claim"); return [row];
  } }) }) }),
  update: () => ({ set: (input: Partial<SandboxRow>) => ({ where: (predicate: SQL) => ({ returning: async () => {
    const publish = input.meta?.rpcTokenNonce && input.status === "provisioning";
    if (publish && publishPause) {
      const pause = publishPause; publishPause = null;
      pause.entered.open(); await pause.release.promise;
    }
    if (!row || !generationMatches(predicate)) return [];
    row = { ...row, ...input };
    events.push(publish ? "publish" : "update");
    if (publish && creates === 2) replacementPublished.open();
    return [row];
  } }) }) }),
} });
replace("../src/k8s.js", { k8sCoreApi: {
  createNamespacedPod: async (input: { body: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } }) => {
    creates++; events.push("create");
    candidateToken = input.body.spec.containers[0]?.env.find((value) => value.name === "SANDBOX_RPC_TOKEN")?.value ?? "";
    if (conflict) throw { statusCode: 409 };
    activePod = { uid: `pod-${creates}`, token: candidateToken };
    if (creates === 1 && firstCreatePause) {
      firstCreatePause.entered.open(); await firstCreatePause.release.promise;
    }
    if (createError) throw { statusCode: 503 };
  },
  readNamespacedPod: async () => {
    if (!activePod) throw { statusCode: 404 };
    if (creates === 2 && replacementReady) await replacementReady.promise;
    return { metadata: { uid: activePod.uid }, status: { conditions: [{ type: "Ready", status: "True" }] } };
  },
  deleteNamespacedPod: async (input: { body: { preconditions: { uid: string } } }) => {
    assert.equal(input.body.preconditions.uid, activePod?.uid);
    activePod = null;
  },
} });
replace("../src/sandbox-template.js", { renderSandboxPodTemplate: () => ({ spec: { containers: [{}], volumes: [] } }) });
replace("@cohub/billing", { billingOperations: { getState: async () => ({ entitlements: [] }) }, COHUB_BILLING_FEATURES: {} });
replace("@cohub/core/space-mods", { listEnabledSpaceMods: async () => [], getSpaceModMountSignature: () => "none" });
replace("@cohub/sandbox-client", {
  createSandboxRpcNonce, createSandboxRpcToken, resolveSandboxConnectionOptions, SandboxConnectionConfigError,
  SandboxRpcError: class extends Error {}, getSandboxClientConnection: () => null,
  hasPendingSandboxRequests: () => false, disconnectSandboxWsClient: () => {},
  startSandboxWsClient: async () => {}, waitForSandboxConnection: async () => ({ capabilities: { fsRead: true } }),
});
replace("../src/crypto.js", { createSandboxReportToken: () => createSandboxRpcNonce(), hashSandboxReportToken: (token: string) => `hash:${token}` });
replace("../src/redis.js", { redisCommandClient: {
  set: async (key: string, value: string, ...args: Array<string | number>) => {
    if (args.includes("NX") && redisGet(key) !== null) return null;
    redisValues.set(key, value);
    const px = args.indexOf("PX");
    if (px >= 0) redisExpiry.set(key, Date.now() + Number(args[px + 1]));
    return "OK";
  },
  get: async (key: string) => redisGet(key),
  eval: async (script: string, _keys: number, key: string, value: string, ttl?: number) => {
    if (redisGet(key) !== value) return 0;
    if (script.includes("pexpire")) {
      renewals++; redisExpiry.set(key, Date.now() + Number(ttl));
    } else { redisValues.delete(key); redisExpiry.delete(key); }
    return 1;
  },
} });
replace("../src/sandbox-events.js", { publishSandboxLifecycleEvent: async () => {} });
replace("../src/sandbox-idle-scheduler.js", { scheduleSandboxAutoDestroy: async () => ({ scheduled: false }) });
replace("../src/lib/sandbox/recovery.js", { smokeVerifySandboxPod: async () => ({}) });
replace("../src/sandbox-public-network.js", {
  deleteSandboxPublicNetwork: async () => {}, getSandboxPublicEndpoints: () => ({}),
  reconcileSandboxPublicNetwork: () => new Promise<void>(() => {}),
});

const { reconcileSpaceSandbox, recoverSpaceSandbox, updateSpaceSandbox } = await import("../src/space-sandboxes.js");
const { acquireSandboxProvisioningLease } = await import("../src/lib/sandbox/provisioning-lock.js");
const { getSandboxCapabilities, SandboxOfflineError } = await import("../src/space-sandbox-rpc.js");
after(() => { for (const item of mocks.reverse()) item.restore(); });
function reset() {
  row = { meta: { podIp: "10.0.0.1", rpcTokenNonce: createSandboxRpcNonce(), reportTokenHash: "old-report-hash" }, status: "running", podName: "sandbox-space-a", provider: "cloud" };
  conflict = false; createError = false; candidateToken = ""; activePod = null; creates = 0; events = [];
  firstCreatePause = null; publishPause = null; claimPause = null; replacementReady = null;
  replacementPublished = gate(); redisValues.clear(); redisExpiry.clear(); renewals = 0;
}
const input = { spaceId: "space-a", userUuid: "user-a", mode: "ensure", reason: "space_created" } as const;
const recover = () => recoverSpaceSandbox({ spaceId: "space-a", userUuid: "user-a", verify: false, source: "manual" });
function storedToken() { return createSandboxRpcToken("test-platform-key", "space-a", String(row?.meta.rpcTokenNonce)); }

test("ensure conflicts preserve active credentials and status", async () => {
  reset(); conflict = true;
  const original = structuredClone(row);
  const originalConnection = resolveSandboxConnectionOptions({ spaceId: "space-a", sandbox: row, signingKey: "test-platform-key" });
  await reconcileSpaceSandbox(input);
  assert.equal(row?.status, original?.status);
  assert.equal(row?.meta.rpcTokenNonce, original?.meta.rpcTokenNonce);
  assert.equal(row?.meta.reportTokenHash, original?.meta.reportTokenHash);
  assert.deepEqual(resolveSandboxConnectionOptions({ spaceId: "space-a", sandbox: row, signingKey: "test-platform-key" }), originalConnection);
  assert.deepEqual(events, ["claim", "create"]);
});

test("new credentials are published after successful creation; failure retains the prior nonce", async () => {
  reset(); row = null;
  await reconcileSpaceSandbox(input);
  assert.deepEqual(events, ["claim", "create", "publish"]);
  assert.equal(row?.status, "provisioning");
  assert.equal(storedToken(), activePod?.token);
  reset(); createError = true;
  const nonce = row?.meta.rpcTokenNonce;
  await assert.rejects(() => reconcileSpaceSandbox(input));
  assert.equal(row?.meta.rpcTokenNonce, nonce);
});

test("a delayed initial create publishes a placeholder and blocks prompt recovery", async () => {
  reset(); row = null;
  const pause = { entered: gate(), release: gate() }; firstCreatePause = pause;
  const initial = reconcileSpaceSandbox(input);
  try {
    await pause.entered.promise;
    assert.equal(row?.status, "provisioning");
    assert.equal(getSandboxPromptRecoveryReason(row), null);
    assert.equal(row?.meta.rpcTokenNonce, undefined);
    assert.equal((await recover()).recovering, true);
    assert.equal(creates, 1);
  } finally { pause.release.open(); await initial; }
  assert.equal(storedToken(), activePod?.token);
});

test("a lost lease prevents a delayed create result or error from overwriting the replacement", async () => {
  for (const failOldCreate of [false, true]) {
    reset(); row = null;
    const pause = { entered: gate(), release: gate() }; firstCreatePause = pause;
    const initial = reconcileSpaceSandbox(input);
    const rejected = assert.rejects(initial);
    await pause.entered.promise;
    redisValues.delete(leaseKey);
    replacementReady = gate();
    const replacing = recover();
    try {
      await replacementPublished.promise;
      const owner = redisValues.get(leaseKey);
      const replacementNonce = row?.meta.rpcTokenNonce;
      createError = failOldCreate;
      pause.release.open(); await rejected;
      assert.equal(redisValues.get(leaseKey), owner, "old cleanup released the replacement lease");
      assert.equal(row?.meta.rpcTokenNonce, replacementNonce);
      assert.equal(storedToken(), activePod?.token);
    } finally {
      createError = false; pause.release.open(); replacementReady.open(); await replacing;
    }
    assert.equal(row?.status, "running");
  }
});

test("lease loss without a successor marks the unfinished generation recoverable", async () => {
  reset(); row = null;
  const pause = { entered: gate(), release: gate() }; firstCreatePause = pause;
  const initial = reconcileSpaceSandbox(input);
  const rejected = assert.rejects(initial);
  await pause.entered.promise;
  redisValues.delete(leaseKey);
  pause.release.open(); await rejected;
  assert.equal(row?.status, "error");
  assert.equal(row?.meta.rpcTokenNonce, undefined);
  assert.equal(getSandboxPromptRecoveryReason(row), "auto_recover");
});

test("a database write started before lease loss is fenced when a replacement claims the generation", async () => {
  reset(); row = null;
  const pause = { entered: gate(), release: gate() }; publishPause = pause;
  const initial = reconcileSpaceSandbox(input);
  const rejected = assert.rejects(initial);
  await pause.entered.promise;
  redisValues.delete(leaseKey);
  await recover();
  const replacement = structuredClone(row);
  pause.release.open(); await rejected;
  assert.deepEqual(row, replacement);
  assert.equal(storedToken(), activePod?.token);
});

test("a stale report snapshot cannot restore an older provisioning generation", async () => {
  reset(); assert.ok(row);
  const original = structuredClone(row);
  await reconcileSpaceSandbox(input);
  const published = structuredClone(row);
  const updated = await updateSpaceSandbox({
    spaceId: "space-a",
    expectedProvisioningGeneration: null,
    meta: original.meta,
  });
  assert.equal(updated, null);
  assert.deepEqual(row, published);
});

test("endpoint invalidation fences late credential publication", async () => {
  reset(); row = null;
  const pause = { entered: gate(), release: gate() }; publishPause = pause;
  const initial = reconcileSpaceSandbox(input);
  const rejected = assert.rejects(initial);
  await pause.entered.promise;
  assert.ok(row);
  row = { ...row, status: "stopped", meta: { ...row.meta, provisioningGeneration: null, rpcTokenNonce: null } };
  const stopped = structuredClone(row);
  pause.release.open(); await rejected;
  assert.deepEqual(row, stopped);
});

test("a delayed claim cannot reclaim the database generation from a newer operation", async () => {
  reset(); row = null;
  const pause = { entered: gate(), release: gate() }; claimPause = pause;
  const initial = reconcileSpaceSandbox(input);
  const rejected = assert.rejects(initial);
  await pause.entered.promise;
  redisValues.delete(leaseKey);
  await recover();
  const replacement = structuredClone(row);
  pause.release.open(); await rejected;
  assert.deepEqual(row, replacement);
  assert.equal(storedToken(), activePod?.token);
});

test("the provisioning lease renews beyond its original TTL and release compares ownership", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
  reset();
  const lease = await acquireSandboxProvisioningLease("space-a"); assert.ok(lease);
  try {
    for (let i = 0; i < 4; i++) {
      t.mock.timers.tick(60_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await lease.assertOwned();
    assert.ok(renewals >= 4);
    redisValues.set(leaseKey, "replacement-owner");
  } finally { await lease.release(); }
  assert.equal(redisValues.get(leaseKey), "replacement-owner");
});

test("API maps invalid configuration to offline and accepts Pod-IP-only legacy instances", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); reset(); assert.ok(row);
  for (const meta of [{}, { podIp: "10.0.0.1", rpcTokenNonce: "invalid" }, { podIp: "10.0.0.1", wsEndpoint: "ws://10.0.0.2:8788/sandbox" }]) {
    row.meta = meta;
    await assert.rejects(() => getSandboxCapabilities("space-a"), (error: unknown) =>
      error instanceof SandboxOfflineError && error.cause instanceof SandboxConnectionConfigError);
  }
  row.meta = { podIp: "10.0.0.1" };
  assert.deepEqual(await getSandboxCapabilities("space-a"), { fsRead: true });
});
