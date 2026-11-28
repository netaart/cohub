import { delegate, deleteFile, editFile, fetchUrl, listFiles, readFile, search, shell, todos, webSearch, writeFile } from "./kit.js";
import type { HarnessTools } from "./view.js";

const PATH = ["path", "target_file", "file_path"];
const run = shell({ command: "command", cwd: ["workingDirectory", "working_directory"], timeout: "timeout", timeoutUnit: "ms" });
const read = readFile({ path: PATH, offset: "offset", limit: "limit" });
const write = writeFile({ path: PATH, content: ["fileText", "contents", "content"] });
const edit = editFile({ path: PATH, old: ["oldText", "old_string"], new: ["newText", "new_string"] });
const remove = deleteFile({ path: PATH });
const glob = search({ pattern: ["globPattern", "glob_pattern", "pattern"], path: ["targetDirectory", "target_directory", "path"] });
const grep = search({ pattern: "pattern", path: "path" });
const ls = listFiles({ path: ["path", "targetDirectory", "target_directory"] });
const todo = todos({ list: "todos", text: "content", status: "status" });

export const cursor: HarnessTools = {
  tools: {
    shell: run, Shell: run,
    read, Read: read,
    write, Write: write,
    edit, StrReplace: edit,
    delete: remove, Delete: remove,
    glob, Glob: glob,
    grep, Grep: grep,
    ls, LS: ls,
    updateTodos: todo, TodoWrite: todo,
    webSearch: webSearch({ query: ["searchTerm", "search_term", "query"] }),
    WebSearch: webSearch({ query: ["search_term", "query"] }),
    WebFetch: fetchUrl({ url: "url" }),
    Task: delegate({ title: "description", agent: "subagent_type", prompt: "prompt" }),
  },
};
