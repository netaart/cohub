import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApprovalDecision, RuntimeTurnInput } from "@neta-art/cohub";
import { answerClaudeApproval, claudeApprovalMode, claudeApprovalModes, claudeApprovalRequest, SessionGrants } from "../src/runtime/harnesses/claude-approval.js";
import type { ApprovalBroker } from "../src/runtime/native/approvals.js";

test("modes follow the permission modes the CLI lists", () => {
  // Claude Code 2.1.316 wraps its choices; 2.0 had no `auto`.
  const current = `  --permission-mode <mode>   Permission mode to use for the session
                             (choices: "acceptEdits", "auto",
                             "bypassPermissions", "manual",
                             "dontAsk", "plan")
  --permission-prompts <target>  (choices: "host", "none")`;
  assert.deepEqual(claudeApprovalModes(current), ["inherit", "auto", "full_access", "read_only"]);
  assert.deepEqual(claudeApprovalModes(`  --permission-mode <mode>  Permission mode (choices: "acceptEdits", "bypassPermissions", "default", "dontAsk", "plan")\n  --plugin-dir`), ["inherit", "full_access", "read_only"]);

  const input = (patch: Partial<RuntimeTurnInput>) => ({ accessMode: "full_access", ...patch }) as RuntimeTurnInput;
  assert.equal(claudeApprovalMode(input({}), []), null);
  assert.equal(claudeApprovalMode(input({}), ["inherit", "full_access"]), "inherit");
  assert.equal(claudeApprovalMode(input({ accessMode: "read_only" }), []), "read_only");
  assert.throws(() => claudeApprovalMode(input({ accessMode: "read_only", approvalMode: "auto" }), ["auto"]), /conflicts/);
  assert.throws(() => claudeApprovalMode(input({ approvalMode: "auto" }), ["inherit"]), /update Claude Code/);
});

test("Bash and file edits become cards; Allow for this chat holds for the Cohub Session only", async () => {
  assert.deepEqual(claudeApprovalRequest({ tool_name: "NotebookEdit", input: { notebook_path: "/w/a.ipynb" }, decision_reason: "Path is outside allowed working directories" }), {
    grants: ["file:/w/a.ipynb"],
    card: { kind: "file_change", decisions: ["accept", "accept_for_session", "decline"], paths: ["/w/a.ipynb"], reason: "Path is outside allowed working directories" },
  });
  assert.equal(claudeApprovalRequest({ tool_name: "WebFetch", input: { url: "https://example.com" } }), null);
  assert.equal(claudeApprovalRequest({ tool_name: "Bash", input: { command: "x".repeat(16_385) } }), null, "a card shows the whole command or none");

  const answers: ApprovalDecision[] = ["accept_for_session", "decline"];
  let asked = 0;
  const broker = { available: true, request: async () => { asked++; return answers.shift() ?? "decline"; } } as unknown as ApprovalBroker;
  const grants = new SessionGrants();
  const request = { tool_name: "Bash", input: { command: "make clean" } };
  const turn = (sessionId: string, accessMode: RuntimeTurnInput["accessMode"] = "full_access") => ({ sessionId, turnId: "t", accessMode }) as RuntimeTurnInput;
  const answer = (input: RuntimeTurnInput, approvals = broker) => answerClaudeApproval(request, input, approvals, grants, new AbortController().signal);

  assert.deepEqual(await answer(turn("a")), { behavior: "allow", updatedInput: request.input });
  assert.equal((await answer(turn("a"))).behavior, "allow");
  assert.equal(asked, 1, "a later Turn of the same chat is allowed without a card");
  assert.equal((await answer(turn("b"))).behavior, "deny");
  assert.equal((await answer(turn("a", "read_only"))).behavior, "deny");
  assert.equal((await answer(turn("c"), { available: false } as ApprovalBroker)).behavior, "deny");
  assert.equal(asked, 2);

  // An answer that arrives after the Turn ended grants nothing.
  const ended = new AbortController();
  const late = { available: true, request: async () => { ended.abort(); return "accept_for_session"; } } as unknown as ApprovalBroker;
  assert.equal((await answerClaudeApproval(request, turn("d"), late, grants, ended.signal)).behavior, "deny");
  assert.equal(grants.covers("d", ["command:make clean"]), false);
});
