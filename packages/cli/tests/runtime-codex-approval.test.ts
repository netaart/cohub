import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RuntimeTurnInput } from "@neta-art/cohub";
import { executeTurn } from "../src/runtime/native/execution.js";
import { discoverHarnesses } from "../src/runtime/harness.js";
import { fixture, testNativeRuntime } from "./fixtures/runtime-native.js";

const makeInput = (spaceId: string, sessionId: string, previousTurnId: string | null, selection: object): RuntimeTurnInput => {
  const turnId = randomUUID();
  return { spaceId, sessionId, turnId, userMessageId: turnId, harness: "codex", accessMode: "full_access", ...selection,
    messages: [{ turnId, userMessageId: turnId, userId: "author", content: [{ type: "text", text: "continue" }] }],
    context: { revision: turnId, throughTurnId: previousTurnId, messages: [] } };
};
const permissions = (request: Record<string, unknown>) => Object.fromEntries(["sandbox", "sandboxPolicy", "approvalPolicy", "approvalsReviewer"].filter((key) => key in request).map((key) => [key, request[key]]));

test("Codex approval selections override every Turn including downgrades on an existing thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-codex-approval-"));
  const spaceId = randomUUID(), sessionId = randomUUID();
  const runtime = await testNativeRuntime({ spaceId, root, harnesses: ["codex"] });
  try {
    await writeFile(join(root, "codex-sticky-resume"), "");
    let previousTurnId: string | null = null, nativeSessionId: string | null = null;
    for (const selection of [{ codexApprovalMode: "full_access" }, { codexApprovalMode: "read_only" }, { codexApprovalMode: "auto" }, { codexApprovalMode: "full_access", accessMode: "read_only" }, {}]) {
      const input = makeInput(spaceId, sessionId, previousTurnId, selection);
      const result = await executeTurn(runtime.native.executor, input, () => {}, new AbortController().signal, input.turnId);
      assert.equal(result.event.message.stopReason, "stop");
      if (nativeSessionId) assert.equal(result.session.nativeSessionId, nativeSessionId);
      nativeSessionId = result.session.nativeSessionId;
      await runtime.native.executor.results.record(result.session, input, input.turnId, [result.event]);
      await runtime.native.executor.results.acknowledge(sessionId, input.turnId);
      previousTurnId = input.turnId;
    }
    const requests = (await readFile(join(root, "codex-requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const expected = [
      { sandbox: "danger-full-access", approvalPolicy: "never", approvalsReviewer: "user" },
      { sandbox: "read-only", approvalPolicy: "never", approvalsReviewer: "user" },
      { sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "auto_review" },
      { sandbox: "read-only", approvalPolicy: "never", approvalsReviewer: "user" }, {},
    ];
    assert.deepEqual(requests.filter((r) => ["thread/start", "thread/resume", "thread/fork"].includes(r.method) && r.params.cwd).map((r) => permissions(r.params)), expected);
    const sandboxes = [{ type: "dangerFullAccess" }, { type: "readOnly", networkAccess: false }, { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, { type: "readOnly", networkAccess: false }];
    assert.deepEqual(requests.filter((r) => r.method === "turn/start").map((r) => permissions(r.params)), expected.map(({ sandbox, ...rest }, i) => sandbox ? { ...rest, sandboxPolicy: sandboxes[i] } : {}));
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("Codex modes reject unsupported servers, malformed modes, non-Codex harnesses and unavailable human approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-codex-approval-"));
  const spaceId = randomUUID();
  const runtime = await testNativeRuntime({ spaceId, root, harnesses: ["codex"] });
  try {
    for (const selection of [{ codexApprovalMode: "invalid" }, { codexApprovalMode: "auto", harness: "pi" }, { codexApprovalMode: "ask" }]) {
      await assert.rejects(executeTurn(runtime.native.executor, makeInput(spaceId, randomUUID(), null, selection), () => {}, new AbortController().signal, null), /Codex|approval/i);
    }
    await writeFile(join(root, "codex-user-agent.txt"), "codex_cli_rs/0.156.0");
    await assert.rejects(executeTurn(runtime.native.executor, makeInput(spaceId, randomUUID(), null, { codexApprovalMode: "auto" }), () => {}, new AbortController().signal, null), /0\.162\.1/);
    const legacy = await executeTurn(runtime.native.executor, makeInput(spaceId, randomUUID(), null, {}), () => {}, new AbortController().signal, null);
    assert.equal(legacy.event.message.stopReason, "stop");
    const readOnly = await executeTurn(runtime.native.executor, makeInput(spaceId, randomUUID(), null, { accessMode: "read_only" }), () => {}, new AbortController().signal, null);
    assert.equal(readOnly.event.message.stopReason, "stop");
    const requests = (await readFile(join(root, "codex-requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(permissions(requests.filter((r) => r.method === "thread/start").at(-1).params), { sandbox: "read-only" });
    assert.deepEqual(permissions(requests.filter((r) => r.method === "turn/start").at(-1).params), { sandboxPolicy: { type: "readOnly", networkAccess: false } });
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("Runtime advertises only approval modes supported by the connected Codex version", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-codex-approval-"));
  try {
    const current = await discoverHarnesses(["codex"], { codex: fixture("codex") }, root);
    assert.deepEqual(current.codexApprovalModes, ["inherit", "read_only", "auto", "full_access"]);
    await writeFile(join(root, "codex-user-agent.txt"), "codex_cli_rs/0.156.0");
    const old = await discoverHarnesses(["codex"], { codex: fixture("codex") }, root);
    assert.equal(old.codexApprovalModes, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("Codex refuses to start work if the server does not confirm the selected approval settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-codex-approval-"));
  const spaceId = randomUUID();
  const runtime = await testNativeRuntime({ spaceId, root, harnesses: ["codex"] });
  try {
    const confirmed = { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }, activePermissionProfile: null };
    for (const response of [{}, { ...confirmed, approvalPolicy: "never" }, { ...confirmed, approvalsReviewer: "user" }, { ...confirmed, sandbox: { type: "dangerFullAccess" } }]) {
      await writeFile(join(root, "codex-approval-response.json"), JSON.stringify(response));
      await assert.rejects(executeTurn(runtime.native.executor, makeInput(spaceId, randomUUID(), null, { codexApprovalMode: "auto" }), () => {}, new AbortController().signal, null), /did not confirm/);
    }
    const requests = (await readFile(join(root, "codex-requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(requests.filter((r) => r.method === "turn/start").length, 0);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("Codex rejects broadened or incomplete sandbox confirmations before starting work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cohub-codex-approval-"));
  const spaceId = randomUUID();
  const runtime = await testNativeRuntime({ spaceId, root, harnesses: ["codex"] });
  try {
    const workspace = { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    const confirmed = { approvalPolicy: "on-request", approvalsReviewer: "auto_review", sandbox: workspace, activePermissionProfile: null };
    for (const [name, response] of Object.entries({
      "network access": { ...confirmed, sandbox: { ...workspace, networkAccess: true } },
      "extra writable root": { ...confirmed, sandbox: { ...workspace, writableRoots: ["/"] } },
      "missing policy details": { ...confirmed, sandbox: { type: "workspaceWrite" } },
      "residual permission profile": { ...confirmed, activePermissionProfile: { id: "broad-profile" } },
    })) {
      await t.test(name, async () => {
        await writeFile(join(root, "codex-approval-response.json"), JSON.stringify(response));
        await assert.rejects(executeTurn(runtime.native.executor, makeInput(spaceId, randomUUID(), null, { codexApprovalMode: "auto" }), () => {}, new AbortController().signal, null), /did not confirm/);
      });
    }
    const requests = (await readFile(join(root, "codex-requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(requests.filter((r) => r.method === "turn/start").length, 0);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});


test("Codex inherit restores the machine's resolved permissions after a full-access Turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-codex-approval-"));
  const spaceId = randomUUID(), sessionId = randomUUID();
  const runtime = await testNativeRuntime({ spaceId, root, harnesses: ["codex"] });
  try {
    const defaults = { approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false }, activePermissionProfile: { id: "company-read-only", extends: null } };
    await writeFile(join(root, "codex-default-approval.json"), JSON.stringify(defaults));
    const first = makeInput(spaceId, sessionId, null, { codexApprovalMode: "full_access" });
    const before = await executeTurn(runtime.native.executor, first, () => {}, new AbortController().signal, first.turnId);
    await runtime.native.executor.results.record(before.session, first, first.turnId, [before.event]);
    await runtime.native.executor.results.acknowledge(sessionId, first.turnId);
    const input = makeInput(spaceId, sessionId, first.turnId, { codexApprovalMode: "inherit" });
    const result = await executeTurn(runtime.native.executor, input, () => {}, new AbortController().signal, input.turnId);
    assert.equal(result.event.message.stopReason, "stop");
    assert.equal(result.session.nativeSessionId, before.session.nativeSessionId);
    const requests = (await readFile(join(root, "codex-requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const probes = requests.filter((r) => r.method === "thread/start" && r.params.ephemeral);
    assert.equal(probes.length, 1);
    assert.deepEqual(probes[0].params.config, { "features.hooks": false });
    assert.equal(requests.filter((r) => r.method === "thread/unsubscribe").length, 1);
    assert.equal(requests.filter((r) => r.method === "turn/start").length, 2);
    const turn = requests.filter((r) => r.method === "turn/start").at(-1).params;
    assert.equal(turn.permissions, "company-read-only");
    assert.equal(turn.approvalPolicy, "never");
    assert.equal(turn.approvalsReviewer, "user");
    assert.equal(turn.sandboxPolicy, undefined);
    assert.equal(requests.find((r) => r.method === "thread/resume").params.permissions, "company-read-only");
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});


test("Codex inherit preserves resolved sandbox details and rejects incomplete local settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-codex-approval-"));
  const spaceId = randomUUID();
  const runtime = await testNativeRuntime({ spaceId, root, harnesses: ["codex"] });
  try {
    const defaults = { approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: true }, activePermissionProfile: null };
    await writeFile(join(root, "codex-default-approval.json"), JSON.stringify(defaults));
    const result = await executeTurn(runtime.native.executor, makeInput(spaceId, randomUUID(), null, { codexApprovalMode: "inherit" }), () => {}, new AbortController().signal, null);
    assert.equal(result.event.message.stopReason, "stop");
    for (const invalid of [{ ...defaults, approvalPolicy: null }, { ...defaults, approvalsReviewer: "unknown" }, { ...defaults, sandbox: { type: "readOnly" } }, { ...defaults, activePermissionProfile: {} }]) {
      await writeFile(join(root, "codex-default-approval.json"), JSON.stringify(invalid));
      await assert.rejects(executeTurn(runtime.native.executor, makeInput(spaceId, randomUUID(), null, { codexApprovalMode: "inherit" }), () => {}, new AbortController().signal, null), /Codex returned|valid local permissions profile/);
    }
    const requests = (await readFile(join(root, "codex-requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const turns = requests.filter((r) => r.method === "turn/start");
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0].params.sandboxPolicy, defaults.sandbox);
    assert.equal(turns[0].params.permissions, undefined);
    assert.equal(requests.filter((r) => r.method === "thread/unsubscribe").length, 5);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});


test("Codex inherit retains external sandbox policy and granular approvals", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-codex-approval-"));
  const spaceId = randomUUID(), sessionId = randomUUID();
  const runtime = await testNativeRuntime({ spaceId, root, harnesses: ["codex"] });
  try {
    const first = makeInput(spaceId, sessionId, null, { codexApprovalMode: "full_access" });
    const before = await executeTurn(runtime.native.executor, first, () => {}, new AbortController().signal, first.turnId);
    await runtime.native.executor.results.record(before.session, first, first.turnId, [before.event]);
    await runtime.native.executor.results.acknowledge(sessionId, first.turnId);
    const defaults = { approvalPolicy: { granular: { sandbox_approval: false, rules: true, skill_approval: true, request_permissions: false, mcp_elicitations: true } }, approvalsReviewer: "user", sandbox: { type: "externalSandbox", networkAccess: "restricted" }, activePermissionProfile: null };
    await writeFile(join(root, "codex-default-approval.json"), JSON.stringify(defaults));
    const result = await executeTurn(runtime.native.executor, makeInput(spaceId, sessionId, first.turnId, { codexApprovalMode: "inherit" }), () => {}, new AbortController().signal, null);
    assert.equal(result.event.message.stopReason, "stop");
    const requests = (await readFile(join(root, "codex-requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const turn = requests.filter((r) => r.method === "turn/start").at(-1).params;
    assert.deepEqual(turn.sandboxPolicy, defaults.sandbox);
    assert.deepEqual(turn.approvalPolicy, defaults.approvalPolicy);
    const update = requests.find((r) => r.method === "thread/settings/update");
    assert.deepEqual(update.params.sandboxPolicy, defaults.sandbox);
    // A brand-new thread has no rollout to resume: it must inherit externalSandbox at thread/start.
    defaults.sandbox.networkAccess = "enabled";
    await writeFile(join(root, "codex-default-approval.json"), JSON.stringify(defaults));
    const fresh = await executeTurn(runtime.native.executor, makeInput(spaceId, randomUUID(), null, { codexApprovalMode: "inherit" }), () => {}, new AbortController().signal, null);
    assert.equal(fresh.event.message.stopReason, "stop");
    const after = (await readFile(join(root, "codex-requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const latestStart = after.filter((r) => r.method === "thread/start" && !r.params.ephemeral).at(-1).params;
    assert.equal(latestStart.sandbox, undefined);
    assert.deepEqual(after.filter((r) => r.method === "turn/start").at(-1).params.sandboxPolicy, defaults.sandbox);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});


test("Codex does not start a Turn when updating a loaded thread's permissions fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-codex-approval-"));
  const spaceId = randomUUID(), sessionId = randomUUID();
  const runtime = await testNativeRuntime({ spaceId, root, harnesses: ["codex"] });
  try {
    const first = makeInput(spaceId, sessionId, null, { codexApprovalMode: "full_access" });
    const before = await executeTurn(runtime.native.executor, first, () => {}, new AbortController().signal, first.turnId);
    await runtime.native.executor.results.record(before.session, first, first.turnId, [before.event]);
    await runtime.native.executor.results.acknowledge(sessionId, first.turnId);
    await writeFile(join(root, "codex-settings-error.txt"), "Machine policy rejected this permission change");
    await assert.rejects(executeTurn(runtime.native.executor, makeInput(spaceId, sessionId, first.turnId, { codexApprovalMode: "auto" }), () => {}, new AbortController().signal, null), /Machine policy rejected this permission change/);
    const requests = (await readFile(join(root, "codex-requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(requests.filter((r) => r.method === "thread/settings/update").length, 1);
    assert.equal(requests.filter((r) => r.method === "turn/start").length, 1);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("Codex rejects an unconfirmed downgrade on a loaded thread before sending more work", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohub-codex-approval-"));
  const spaceId = randomUUID(), sessionId = randomUUID();
  const runtime = await testNativeRuntime({ spaceId, root, harnesses: ["codex"] });
  try {
    const first = makeInput(spaceId, sessionId, null, { codexApprovalMode: "full_access" });
    const before = await executeTurn(runtime.native.executor, first, () => {}, new AbortController().signal, first.turnId);
    await runtime.native.executor.results.record(before.session, first, first.turnId, [before.event]);
    await runtime.native.executor.results.acknowledge(sessionId, first.turnId);
    await writeFile(join(root, "codex-sticky-resume"), "");
    await writeFile(join(root, "codex-approval-response.json"), JSON.stringify({ approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: true }, activePermissionProfile: null }));
    await assert.rejects(executeTurn(runtime.native.executor, makeInput(spaceId, sessionId, first.turnId, { codexApprovalMode: "read_only" }), () => {}, new AbortController().signal, null), /did not confirm/);
    const requests = (await readFile(join(root, "codex-requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(requests.filter((r) => r.method === "thread/settings/update").length, 1);
    assert.equal(requests.filter((r) => r.method === "turn/start").length, 1);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
