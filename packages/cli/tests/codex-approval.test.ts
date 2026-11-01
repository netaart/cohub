import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeTurnInput } from "@neta-art/cohub";
import { applyCodexApproval, codexApprovalMode, resolveCodexApproval } from "../src/runtime/harnesses/codex-approval.js";
import type { CodexChannel, CodexEvent } from "../src/runtime/native/codex-link.js";
import { userAgentVersion } from "../src/runtime/native/codex-link.js";

const input = (patch: Partial<RuntimeTurnInput>) => ({ accessMode: "full_access", ...patch }) as RuntimeTurnInput;
const current = userAgentVersion("cohub-runtime/0.166.0 (Mac OS 15.0; arm64) iTerm (cohub-runtime; 1)");
const old = userAgentVersion("cohub-runtime/0.163.0");

test("Codex approval mode follows the platform limit, defaults to local settings and degrades on old servers", { skip: process.platform === "win32" }, () => {
  assert.deepEqual(current, [0, 166, 0]);
  assert.equal(codexApprovalMode(input({}), current), null);
  assert.equal(codexApprovalMode(input({ approvalMode: "full_access" }), current), "full_access");
  assert.equal(codexApprovalMode(input({ accessMode: "read_only" }), current), "read_only");
  assert.throws(() => codexApprovalMode(input({ accessMode: "read_only", approvalMode: "full_access" }), current), /conflicts/);
  assert.equal(codexApprovalMode(input({ accessMode: "read_only" }), old), null);
  assert.throws(() => codexApprovalMode(input({ approvalMode: "read_only" }), old), /0\.164\.0/);
  assert.throws(() => codexApprovalMode(input({ approvalMode: "auto" }), null), /0\.164\.0/);
});

const readOnly = { approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false }, activePermissionProfile: { id: "cohub-read-only" } };

function fakeCodex(onUpdate: (params: Record<string, unknown>) => Record<string, unknown> | Error) {
  const listeners = new Set<(event: CodexEvent) => void>();
  const updates: unknown[] = [];
  const channel = {
    request: async (method: string, params: Record<string, unknown> = {}) => {
      if (method !== "thread/settings/update") return {};
      updates.push(params);
      const result = onUpdate(params);
      if (result instanceof Error) throw result;
      queueMicrotask(() => { for (const listener of listeners) listener({ method: "thread/settings/updated", params: { threadId: params.threadId, threadSettings: result } }); });
      return {};
    },
    onEvent: (listener: (event: CodexEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  } as unknown as CodexChannel;
  return { channel, updates };
}

test("an approval mode is confirmed before anything is sent, reopening a thread that lacks Cohub's profile", async () => {
  const approval = await resolveCodexApproval("read_only", fakeCodex(() => ({})).channel, "/");
  const confirmed = fakeCodex(() => new Error("unexpected"));
  await applyCodexApproval(approval, confirmed.channel, "t", readOnly, async () => { throw new Error("unexpected"); });
  assert.equal(confirmed.updates.length, 0, "an already confirmed thread is left alone");

  const updated = fakeCodex(() => ({ ...readOnly, sandboxPolicy: readOnly.sandbox, sandbox: undefined }));
  await applyCodexApproval(approval, updated.channel, "t", { ...readOnly, sandbox: { type: "dangerFullAccess" } }, async () => { throw new Error("unexpected"); });
  assert.equal(updated.updates.length, 1);

  let reopened = 0;
  const missing = fakeCodex(() => new Error("default_permissions requires a `[permissions]` table"));
  await applyCodexApproval(approval, missing.channel, "t", {}, async () => { reopened += 1; return readOnly; });
  assert.equal(reopened, 1);

  const wrong = fakeCodex(() => ({ ...readOnly, sandbox: undefined, sandboxPolicy: { type: "readOnly", networkAccess: true } }));
  await assert.rejects(applyCodexApproval(approval, wrong.channel, "t", {}, async () => ({})), /did not confirm/);
  const full = await resolveCodexApproval("full_access", fakeCodex(() => ({})).channel, "/");
  await assert.rejects(applyCodexApproval(full, fakeCodex(() => new Error("denied by requirements")).channel, "t", {}, async () => readOnly), /refused the selected approval mode: denied/);
});
