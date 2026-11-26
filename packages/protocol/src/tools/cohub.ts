import { editFile, listFiles, readFile, search, shell, writeFile } from "./kit.js";
import type { HarnessTools } from "./view.js";

const WORKSPACE = "/workspace/";

const tools = {
  bash: shell({ command: "command", timeout: "timeout" }),
  read: readFile({ path: "path", offset: "offset", limit: "limit" }),
  write: writeFile({ path: "path", content: "content" }),
  edit: editFile({ path: "path", edits: "edits", old: "oldText", new: "newText" }),
  ls: listFiles({ path: "path" }),
  find: search({ pattern: "pattern", path: "path" }),
  grep: search({ pattern: "pattern", path: "path" }),
};

export const cohub: HarnessTools = { tools, path: (path) => path.startsWith(WORKSPACE) ? path.slice(WORKSPACE.length) : path };
export const pi: HarnessTools = { tools };
