import { ask, delegate, editFile, fetchUrl, listFiles, mcpTool, plan, readFile, search, shell, todos, webSearch, writeFile } from "./kit.js";
import type { HarnessTools } from "./view.js";

const task = delegate({ title: "description", agent: "subagent_type", prompt: "prompt" });

export const claude: HarnessTools = {
  tools: {
    Bash: shell({ command: "command", timeout: "timeout", timeoutUnit: "ms", description: "description" }),
    Read: readFile({ path: "file_path", offset: "offset", limit: "limit" }),
    Write: writeFile({ path: "file_path", content: "content" }),
    Edit: editFile({ path: "file_path", old: "old_string", new: "new_string" }),
    MultiEdit: editFile({ path: "file_path", edits: "edits", old: "old_string", new: "new_string" }),
    NotebookEdit: writeFile({ path: "notebook_path", content: "new_source" }),
    Glob: search({ pattern: "pattern", path: "path" }),
    Grep: search({ pattern: "pattern", path: "path" }),
    LS: listFiles({ path: "path" }),
    WebFetch: fetchUrl({ url: "url", prompt: "prompt" }),
    WebSearch: webSearch({ query: "query" }),
    Task: task,
    Agent: task,
    TodoWrite: todos({ list: "todos", text: "content", status: "status", active: "activeForm" }),
    ExitPlanMode: plan({ text: "plan" }),
    AskUserQuestion: ask({ questions: "questions", question: "question", header: "header", options: "options" }),
  },
  labels: { AskUserQuestion: "Ask" },
  other: mcpTool,
};
