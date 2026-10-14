import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Codex records explicit display names here; the rollout and SQLite title may retain the prompt. */
export const codexTitleIndex = () => join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "session_index.jsonl");

export async function readCodexTitles(): Promise<Map<string, string>> {
  let source: string;
  try { source = await readFile(codexTitleIndex(), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map(); throw error; }
  const titles = new Map<string, string>();
  for (const [index, line] of source.split("\n").entries()) {
    if (!line.trim()) continue;
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !value.id
      || !("thread_name" in value) || typeof value.thread_name !== "string") {
      throw new Error(`Invalid Codex title index entry at line ${index + 1}`);
    }
    // Last entry wins, including a cleared name. No inferred titles are sent to Cohub.
    titles.set(value.id, value.thread_name.trim());
  }
  return titles;
}
