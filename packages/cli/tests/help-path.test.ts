import assert from "node:assert/strict";
import { test } from "node:test";
import { Command } from "commander";
import { registerApps } from "../src/commands/apps.js";
import { formatUnknownCommandError, resolveHelpPath } from "../src/help-path.js";

function createProgram(): Command {
  const program = new Command("cohub")
    .option("-s, --space <id>", "Target Space ID")
    .helpOption("-h, --help", "Show help");
  const files = program.command("spaces").command("files");
  files.command("cat <path>");
  files.command("write <path>").option("-c, --content <text>", "File content");
  registerApps(program);
  return program;
}

function kind(argv: string[]) {
  return resolveHelpPath(createProgram(), argv).kind;
}

function helpName(argv: string[]) {
  const result = resolveHelpPath(createProgram(), argv);
  return result.kind === "help" ? result.command.name() : undefined;
}

test("nested help resolves the command path", () => {
  assert.equal(helpName(["apps", "publish", "--help"]), "publish");
  assert.equal(helpName(["help", "apps", "publish"]), "publish");
  assert.equal(kind(["apps", "publish", "demo"]), "passthrough");
  assert.equal(kind(["spaces", "files", "cat", "help"]), "passthrough");
});

test("unknown prefixes error instead of dumping root help", () => {
  const typo = resolveHelpPath(createProgram(), ["apss", "--help"]);
  assert.equal(typo.kind, "unknown");
  if (typo.kind === "unknown") {
    assert.equal(typo.token, "apss");
    assert.match(formatUnknownCommandError(typo), /Did you mean apps/);
  }

  const cli = resolveHelpPath(createProgram(), ["cli", "apps", "publish", "--help"]);
  assert.deepEqual(cli, { kind: "unknown", token: "cli", tryCommand: "apps publish --help" });
});

test("run help follows run's own parsing rules", () => {
  assert.equal(kind(["run", "--help"]), "run-help");
  assert.equal(kind(["run", "-s", "atou/project", "--help"]), "run-help");
  assert.equal(kind(["run", "--space=atou/project", "--help"]), "run-help");
  assert.equal(kind(["run", "npm", "--help"]), "passthrough");
  assert.equal(kind(["run", "-s", "atou/project", "npm", "--help"]), "passthrough");
  assert.equal(kind(["run", "--async", "npm", "--help"]), "passthrough");
  assert.equal(kind(["run", "--command", "--help"]), "passthrough");
});

test("required option values may start with dashes", () => {
  assert.equal(kind(["spaces", "files", "write", "x", "--content", "--help"]), "passthrough");
  assert.equal(helpName(["spaces", "files", "write", "x", "--help"]), "write");
});
