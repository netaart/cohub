import { delegate, editFile, fetchUrl, listFiles, readFile, search, shell, webSearch, writeFile } from "./kit.js";
import type { HarnessTools } from "./view.js";

const read = readFile({ path: ["AbsolutePath", "Path", "File", "TargetFile"], offset: "StartLine", end: "EndLine" });

export const antigravity: HarnessTools = {
  tools: {
    run_command: shell({ command: "CommandLine", cwd: "Cwd" }),
    read_file: read,
    view_file: read,
    write_to_file: writeFile({ path: "TargetFile", content: "CodeContent" }),
    replace_file_content: editFile({ path: "TargetFile", old: "TargetContent", new: "ReplacementContent" }),
    multi_replace_file_content: editFile({ path: "TargetFile", edits: "ReplacementChunks", old: "TargetContent", new: "ReplacementContent" }),
    list_dir: listFiles({ path: ["DirectoryPath", "Path"] }),
    find_by_name: search({ pattern: "Pattern", path: "SearchDirectory" }),
    grep_search: search({ pattern: "Query", path: "SearchPath" }),
    read_url_content: fetchUrl({ url: "Url" }),
    search_web: webSearch({ query: ["query", "Query"] }),
    browser_subagent: delegate({ title: "TaskName", prompt: "Task" }),
  },
  labels: { replace_file_content: "replace", multi_replace_file_content: "replace" },
};
