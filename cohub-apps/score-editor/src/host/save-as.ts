import { statusOf } from "./errors.ts";
import type { CohubFileClient } from "./host.ts";
import { fileNameOf, folderOf } from "./path.ts";

export type SaveAsInput = {
  /** The source score file, when the generation was opened with one. */
  readonly sourceFile: string | null;
  readonly taskRunId: string;
  /** The generation's title; the task id is the fallback when it makes no name. */
  readonly name?: string | null;
};

export type SaveAsOutcome =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: "failed" };

function join(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

/** A title as one file name: no path separators or control characters; empty falls back. */
function fileBase(title: string | null | undefined, fallback: string): string {
  const cleaned = (title ?? "")
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.abc$/i, "")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .trim();
  return cleaned || fallback;
}

/** `name-2.abc`, `name-3.abc`, … until one is free. */
function freeName(base: string, first: string, taken: ReadonlySet<string>): string {
  if (!taken.has(first)) return first;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}.abc`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Where Save as puts a generated score: beside its source file as `<name>-copy.abc`, otherwise
 * in `scores/` as `<title>.abc` (the task id when there is no title). A taken name gets the next
 * free `-N` suffix.
 */
export function saveAsPath(input: SaveAsInput, taken: ReadonlySet<string>): string {
  if (input.sourceFile !== null) {
    const folder = folderOf(input.sourceFile);
    const base = fileNameOf(input.sourceFile).replace(/\.abc$/i, "");
    return join(folder, freeName(`${base}-copy`, `${base}-copy.abc`, taken));
  }
  const base = fileBase(input.name, input.taskRunId);
  return join("scores", freeName(base, `${base}.abc`, taken));
}

/** Writes the score at a free path; the caller opens the file it answers. */
export async function saveGeneratedScore(options: {
  readonly client: CohubFileClient;
  readonly spaceId: string;
  readonly sourceFile: string | null;
  readonly taskRunId: string;
  readonly name?: string | null;
  readonly text: string;
}): Promise<SaveAsOutcome> {
  const { client, spaceId, sourceFile, taskRunId, name, text } = options;
  const folder = sourceFile === null ? "scores" : folderOf(sourceFile);
  let taken: Set<string>;
  try {
    const entries = await client.list({ spaceId, path: folder });
    taken = new Set(entries.filter((entry) => entry.type === "file").map((entry) => entry.name));
  } catch (error) {
    if (statusOf(error) !== 404) return { ok: false, reason: "failed" };
    taken = new Set();
  }
  const path = saveAsPath({ sourceFile, taskRunId, name }, taken);
  try {
    await client.write({ spaceId, path, text, expected: null });
    return { ok: true, path };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
