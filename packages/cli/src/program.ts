import { Command } from "commander";
import { registerEndpointOptions } from "./endpoint-options.js";
import { CLI_VERSION } from "./version.js";

export function createProgram(): Command {
  return registerEndpointOptions(new Command("cohub"))
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
  prompt, completion, decision, generate, upload, apps, and public fall back to your Home Space;
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
}
