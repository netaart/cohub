import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeTurnInput } from "@neta-art/cohub";
import { codexApprovalMode, resolveCodexApproval } from "../src/runtime/harnesses/codex-approval.js";
import type { CodexChannel } from "../src/runtime/native/codex-link.js";
import { userAgentVersion } from "../src/runtime/native/codex-link.js";

const input = (patch: Partial<RuntimeTurnInput>) => ({ accessMode: "full_access", ...patch }) as RuntimeTurnInput;
const current = userAgentVersion("cohub-runtime/0.166.0 (Mac OS 15.0; arm64) iTerm (cohub-runtime; 1)");
const old = userAgentVersion("cohub-runtime/0.156.1");

test("Codex approval mode follows the platform limit and degrades on old servers", () => {
  assert.deepEqual(current, [0, 166, 0]);
  assert.equal(codexApprovalMode(input({}), current), null);
  assert.equal(codexApprovalMode(input({ approvalMode: "full_access" }), current), "full_access");
  assert.equal(codexApprovalMode(input({ accessMode: "read_only" }), current), "read_only");
  assert.throws(() => codexApprovalMode(input({ accessMode: "read_only", approvalMode: "full_access" }), current), /conflicts/);
  assert.equal(codexApprovalMode(input({ accessMode: "read_only" }), old), null);
  assert.throws(() => codexApprovalMode(input({ approvalMode: "read_only" }), old), /0\.162\.1/);
});

test("modes map to Codex's own settings; inherit restores the machine's on an existing thread", async () => {
  const requests: Array<[string, unknown]> = [];
  const local = { approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite", writableRoots: [] }, activePermissionProfile: { id: ":workspace" } };
  let probe: Record<string, unknown> = local;
  const codex = { request: async (method: string, params: unknown) => {
    requests.push([method, params]);
    return method === "thread/start" ? { thread: { id: "probe" }, ...probe } : {};
  } } as unknown as CodexChannel;

  assert.deepEqual(await resolveCodexApproval("read_only", codex, "/", true), {
    thread: { sandbox: "read-only", approvalPolicy: "on-request", approvalsReviewer: "user" },
    turn: { sandboxPolicy: { type: "readOnly", networkAccess: false }, approvalPolicy: "on-request", approvalsReviewer: "user" },
  });
  assert.deepEqual((await resolveCodexApproval("full_access", codex, "/", true)).turn, { sandboxPolicy: { type: "dangerFullAccess" }, approvalPolicy: "never", approvalsReviewer: "user" });
  assert.equal((await resolveCodexApproval("auto", codex, "/", true)).turn.approvalsReviewer, "auto_review");
  assert.deepEqual(await resolveCodexApproval("inherit", codex, "/", false), { thread: {}, turn: {} });
  assert.equal(requests.length, 0, "only inherit on an existing thread asks Codex");

  assert.deepEqual(await resolveCodexApproval("inherit", codex, "/", true), { thread: {}, turn: { approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: local.sandbox } });
  assert.deepEqual(requests.map(([method]) => method), ["thread/start", "thread/unsubscribe"]);
  probe = { ...local, activePermissionProfile: { id: "company" } };
  assert.equal((await resolveCodexApproval("inherit", codex, "/", true)).turn.permissions, "company");
  probe = { thread: { id: "probe" } };
  await assert.rejects(resolveCodexApproval("inherit", codex, "/", true), /local approval settings/);
});
