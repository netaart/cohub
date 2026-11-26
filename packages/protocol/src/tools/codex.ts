import { applyPatch, fileChanges, mcpTool, readFile, shell, todos, webSearch } from "./kit.js";
import type { HarnessTools, ToolAdapter } from "./view.js";

const command = shell({ command: "command", cwd: "workdir", timeout: "timeout_ms", timeoutUnit: "ms", description: "justification" });
const changes = fileChanges({ changes: "changes" });
const patch = applyPatch({ patch: ["input", "patch"] });

export const codex: HarnessTools = {
  tools: {
    bash: shell({ command: "command", cwd: "cwd" }),
    shell: command,
    shell_command: command,
    exec_command: shell({ command: "cmd", cwd: "workdir", description: "justification" }),
    apply_patch: ((input, context) => (input.changes === undefined ? patch : changes)(input, context)) satisfies ToolAdapter,
    update_plan: todos({ list: "plan", text: "step", status: "status" }),
    view_image: readFile({ path: "path" }),
    web_search: webSearch({ query: "query" }),
  },
  other: mcpTool,
};
