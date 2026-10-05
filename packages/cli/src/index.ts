#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { registerAuth } from "./commands/auth.js";
import { registerBoards } from "./commands/boards.js";
import { registerChannels } from "./commands/channels.js";
import { registerCronJobs } from "./commands/cron-jobs.js";
import { registerGenerations } from "./commands/generations.js";
import { registerMe } from "./commands/me.js";
import { registerModels } from "./commands/models.js";
import { registerProfile } from "./commands/profile.js";
import { registerPrompts } from "./commands/prompts.js";
import { registerPublic } from "./commands/public.js";
import { registerSkills } from "./commands/skills.js";
import { registerSearch } from "./commands/search.js";
import { registerReferences } from "./commands/references.js";
import { registerReferrals } from "./commands/referrals.js";
import { registerPrompt, registerSpaces } from "./commands/spaces.js";
import { maybeHandleRunCommand, printRunHelp } from "./commands/run.js";
import { registerRuntime } from "./commands/runtime.js";
import { registerTasks } from "./commands/tasks.js";
import { registerDesktop, registerLegacyUi } from "./commands/desktop.js";
import { registerApps } from "./commands/apps.js";
import { formatUnknownCommandError, resolveHelpPath } from "./help-path.js";

const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
    return pkg.version as string;
  } catch {
    return "1.0.0";
  }
})();

const program = new Command("cohub");

program
  .name("cohub")
  .summary("Work with Cohub from your terminal")
  .description("Send prompts, manage Space files, and publish public output.")
  .version(VERSION, "-v, --version", "Show version")
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
  cohub run -- git status
  cohub runtime up ./my-project
  cohub runtime logs --follow
  cohub search "release notes"
  cohub -s <space-id> boards inspect <board-id>
  cohub -s <space-id> spaces turns ls --author others
  cohub -s <space-id> spaces sessions turns ls <session-id>
  cohub -s home spaces files ls
  cohub -s <space-id> public upload ./dist demo
  cohub -s <space-id> apps publish demo --file dist/index.html
  cohub desktop open <app-id> --call selection.get
  cohub -s <space-id> spaces commerce products list
  cohub models ls
  cohub models ls --model-type multimodal
  cohub generate "A calm lake at sunrise" --model <model> --output lake.png

Target space:
  -s <space>, then COHUB_SPACE_ID, then the current directory Runtime binding.
  <space> is an ID, a slug you own such as home, or username/slug.
  prompt, completion, generate, apps, and public fall back to your Home Space;
  other Space commands need a target.

Environment:
  COHUB_SPACE_ID         Target Space when -s is omitted
  COHUB_EXECUTION_TOKEN  Use this token instead of the stored Logto session
  ENV=dev                Use the development Cohub environment
  HTTPS_PROXY            Honored for API and uploads (also HTTP_PROXY, NO_PROXY)
  Runtime logs            ~/.local/state/cohub/runtime/<space-id>/diagnostics
`);

registerAuth(program);
registerBoards(program);
registerProfile(program);
registerMe(program);
registerPrompt(program);
registerSpaces(program);
registerRuntime(program);
registerChannels(program);
registerGenerations(program);
registerModels(program);
registerPrompts(program);
registerPublic(program);
registerSkills(program);
registerSearch(program);
registerReferences(program);
registerReferrals(program);
registerTasks(program);
registerCronJobs(program);
registerApps(program);
registerDesktop(program);
registerLegacyUi(program);

const argv = process.argv.slice(2);
const help = resolveHelpPath(program, argv);
if (help.kind === "help") {
  help.command.outputHelp();
} else if (help.kind === "run-help") {
  printRunHelp();
} else if (help.kind === "unknown") {
  process.stderr.write(formatUnknownCommandError(help));
  process.exit(1);
} else if (await maybeHandleRunCommand(argv)) {
  process.exit();
} else {
  program.parse();
}
