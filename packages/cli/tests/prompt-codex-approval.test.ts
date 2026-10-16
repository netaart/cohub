import assert from "node:assert/strict";
import { test } from "node:test";
import { Command } from "commander";
import { registerPrompt, registerSpaces } from "../src/commands/spaces.js";
import { parseCodexApprovalMode } from "../src/runtime/native/codex-approval.js";

test("Both prompt commands expose an optional Codex approval-mode flag", () => {
  const program = new Command();
  registerPrompt(program);
  registerSpaces(program);
  const commands = [program.commands.find((c) => c.name() === "prompt"), program.commands.find((c) => c.name() === "spaces")?.commands.find((c) => c.name() === "prompt")];
  for (const command of commands) {
    assert.ok(command);
    assert.equal(command.opts().codexApprovalMode, undefined);
    assert.ok(command.options.find((o) => o.long === "--codex-approval-mode"));
    command.parseOptions(["--harness", "codex", "--codex-approval-mode", "auto"]);
    assert.equal(command.opts().codexApprovalMode, "auto");
  }
});

test("Prompt approval selection validates harness, omission, and supported modes", () => {
  assert.equal(parseCodexApprovalMode(undefined, "pi"), undefined);
  for (const mode of ["inherit", "read_only", "auto", "full_access"]) assert.equal(parseCodexApprovalMode(mode, "codex"), mode);
  for (const mode of [null, "", "typo", "ask"]) assert.throws(() => parseCodexApprovalMode(mode, "codex"));
  for (const harness of [undefined, "pi", "cohub"]) assert.throws(() => parseCodexApprovalMode("full_access", harness), /requires the Codex harness/);
});
