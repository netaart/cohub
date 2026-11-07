#!/usr/bin/env node
import { addRootCommandStubs, COMMANDS, registerCommands } from "./command-index.js";
import { formatUnknownCommandError, resolveHelpPath, rootCommandName } from "./help-path.js";
import { createProgram } from "./program.js";
import { buildInfo } from "./version.js";

const program = createProgram();
const argv = process.argv.slice(2);
const name = rootCommandName(program, argv);
const named = COMMANDS.find((command) => name !== undefined && command.names.includes(name));
const versionOnly = name === undefined && argv.some((arg) => arg === "-v" || arg === "--version") && !argv.some((arg) => arg === "-h" || arg === "--help");
const rootCommands = name === undefined && resolveHelpPath(program, argv).kind === "help" ? buildInfo().rootCommands : undefined;
if (rootCommands) addRootCommandStubs(program, rootCommands);
else await registerCommands(program, named ? [named] : name === "run" || versionOnly ? [] : COMMANDS);

const help = resolveHelpPath(program, argv);
if (help.kind === "help") {
  help.command.outputHelp();
} else if (help.kind === "run-help") {
  (await import("./commands/run.js")).printRunHelp();
} else if (help.kind === "unknown") {
  process.stderr.write(formatUnknownCommandError(help));
  process.exit(1);
} else if (name === "run" && await (await import("./commands/run.js")).maybeHandleRunCommand(argv)) {
  process.exit();
} else {
  program.parse();
}
