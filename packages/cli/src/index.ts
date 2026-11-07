#!/usr/bin/env node
import { Command } from "commander";
import { registerEndpointOptions } from "./endpoint-options.js";
import { formatUnknownCommandError, resolveHelpPath, rootCommandName } from "./help-path.js";
import { CLI_VERSION } from "./version.js";

type Register = (program: Command) => unknown;

const COMMANDS: ReadonlyArray<{ names: readonly string[]; load: () => Promise<Register> }> = [
  { names: ["auth"], load: async () => (await import("./commands/auth.js")).registerAuth },
  { names: ["boards"], load: async () => (await import("./commands/boards.js")).registerBoards },
  { names: ["profile"], load: async () => (await import("./commands/profile.js")).registerProfile },
  { names: ["me"], load: async () => (await import("./commands/me.js")).registerMe },
  { names: ["prompt", "completion", "decision"], load: async () => (await import("./commands/spaces.js")).registerPrompt },
  { names: ["spaces", "labels"], load: async () => (await import("./commands/spaces.js")).registerSpaces },
  { names: ["runtime"], load: async () => (await import("./commands/runtime.js")).registerRuntime },
  { names: ["channels"], load: async () => (await import("./commands/channels.js")).registerChannels },
  { names: ["generate"], load: async () => (await import("./commands/generations.js")).registerGenerations },
  { names: ["models"], load: async () => (await import("./commands/models.js")).registerModels },
  { names: ["prompts"], load: async () => (await import("./commands/prompts.js")).registerPrompts },
  { names: ["public"], load: async () => (await import("./commands/public.js")).registerPublic },
  { names: ["skills"], load: async () => (await import("./commands/skills.js")).registerSkills },
  { names: ["search"], load: async () => (await import("./commands/search.js")).registerSearch },
  { names: ["references"], load: async () => (await import("./commands/references.js")).registerReferences },
  { names: ["referrals"], load: async () => (await import("./commands/referrals.js")).registerReferrals },
  { names: ["tasks"], load: async () => (await import("./commands/tasks.js")).registerTasks },
  { names: ["cron-jobs"], load: async () => (await import("./commands/cron-jobs.js")).registerCronJobs },
  { names: ["apps", "works"], load: async () => (await import("./commands/apps.js")).registerApps },
  { names: ["rooms"], load: async () => (await import("./commands/rooms.js")).registerRooms },
  { names: ["feedback"], load: async () => (await import("./commands/feedback.js")).registerFeedback },
  { names: ["desktop"], load: async () => (await import("./commands/desktop.js")).registerDesktop },
  { names: ["ui"], load: async () => (await import("./commands/desktop.js")).registerLegacyUi },
  { names: ["host"], load: async () => (await import("./commands/host.js")).registerHost },
  { names: ["version"], load: async () => (await import("./commands/version.js")).registerVersion },
];

const program = registerEndpointOptions(new Command("cohub"));

program
  .name("cohub")
  .summary("Work with Cohub from your terminal")
  .description("Send prompts, manage Space files, and publish public output.")
  .version(CLI_VERSION, "-v, --version", "Show version")
  .option("-s, --space <space>", "Target Space: ID, slug, or username/slug")
  .option("--json", "Print machine-readable JSON when supported")
  .helpOption("-h, --help", "Show help")
  .addHelpText("after", `

Help:
  cohub apps publish --help
  cohub help apps publish

Common commands:
  cohub auth login
  cohub profile avatar ./avatar.png
  cohub spaces ls
  cohub prompt "Fix the failing tests"
  cohub completion "Summarize AGENTS.md" --system-prompt AGENTS.md --stream
  cohub decision "I was charged twice" -q questions.json
  cohub run -- git status
  cohub runtime up ./my-project
  cohub runtime logs --follow
  cohub search "release notes"
  cohub -s <space-id> boards get <board-id>
  cohub -s <space-id> spaces turns ls --author others
  cohub -s <space-id> spaces sessions turns ls <session-id>
  cohub -s home spaces files ls
  cohub -s <space-id> public upload ./dist demo
  cohub -s <space-id> apps publish demo --file dist/index.html
  cohub desktop open <app-id> --call selection.get
  cohub rooms join <invite>
  cohub -s <space-id> spaces commerce products list
  cohub models ls
  cohub models ls --model-type multimodal
  cohub generate "A calm lake at sunrise" --model <model> --output lake.png
  cohub feedback "Describe the problem" -f screenshot.png

Target space:
  -s <space>, then COHUB_SPACE_ID, then the current directory Runtime binding.
  <space> is an ID, a slug you own such as home, or username/slug.
  prompt, completion, decision, generate, apps, and public fall back to your Home Space;
  other Space commands need a target.

Environment:
  COHUB_SPACE_ID         Target Space when -s is omitted
  COHUB_EXECUTION_TOKEN  Use this token instead of the stored Logto session
  COHUB_BASE_URL         Override the API base URL
  COHUB_WS_URL           Override the realtime WebSocket URL
  COHUB_WEB_URL          Override the web URL used in links
  COHUB_NO_DIRECT=1      Send files and screens through the API even when this machine serves the Space
  ENV=dev                Use the development Cohub environment
  HTTPS_PROXY            Honored for API and uploads (also HTTP_PROXY, NO_PROXY)
  Runtime logs            ~/.local/state/cohub/runtime/<space-id>/diagnostics
`);

const argv = process.argv.slice(2);
const name = rootCommandName(program, argv);
const named = COMMANDS.find((command) => name !== undefined && command.names.includes(name));
const versionOnly = name === undefined && argv.some((arg) => arg === "-v" || arg === "--version") && !argv.some((arg) => arg === "-h" || arg === "--help");
const loading = named ? [named] : name === "run" || versionOnly ? [] : COMMANDS;
for (const register of await Promise.all(loading.map((command) => command.load()))) register(program);

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
