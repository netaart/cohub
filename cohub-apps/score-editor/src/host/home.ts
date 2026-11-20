import type { HomeSong } from "../app/home.ts";
import { homeSongRows, newScorePath } from "../app/home.ts";
import { statusOf } from "./errors.ts";
import type { AuthorizeResult, CohubAppClient, CohubFileClient, FileEntry, PickSpaceResult } from "./host.ts";
import { folderOf } from "./path.ts";
import { saveAsPath } from "./save-as.ts";

export const HOME_SCOPES = ["file.view", "taskrun.view", "file.edit"] as const;
export const HOME_READ_SCOPES = ["file.view", "taskrun.view"] as const;
export const HOME_VIEW_SCOPES = ["file.view"] as const;

export type HomeAccess = AuthorizeResult;

/**
 * The one home prompt: full set first, then read scopes, then view alone. A viewer who holds only
 * view still gets the files section; a viewer who can edit never sees a second prompt per row.
 */
export async function authorizeHome(input: {
  readonly client: CohubFileClient;
  readonly spaceId: string;
  readonly reason: string;
  readonly fallback?: "allow" | "none";
}): Promise<HomeAccess> {
  const ask = async (scopes: readonly string[]): Promise<HomeAccess> => {
    try {
      return await input.client.authorize({
        spaceId: input.spaceId,
        scopes,
        reason: input.reason,
        ...(input.fallback === undefined ? {} : { fallback: input.fallback }),
      });
    } catch {
      return { status: "denied", code: "failed" };
    }
  };
  const full = await ask(HOME_SCOPES);
  if (full.status !== "denied" || full.code !== "scope_not_held") return full;
  const read = await ask(HOME_READ_SCOPES);
  if (read.status !== "denied" || read.code !== "scope_not_held") return read;
  return ask(HOME_VIEW_SCOPES);
}

export type HomeSongPage = {
  readonly rows: readonly HomeSong[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
};

export async function listHomeSongs(input: {
  readonly client: Pick<CohubAppClient, "listTasks">;
  readonly spaceId: string;
  readonly cursor?: string | null;
  readonly limit?: number;
}): Promise<HomeSongPage> {
  const limit = input.limit ?? 20;
  const rows: HomeSong[] = [];
  let cursor = input.cursor ?? null;
  for (;;) {
    const page = await input.client.listTasks({
      spaceId: input.spaceId,
      limit,
      ...(cursor === null ? {} : { cursor }),
    });
    rows.push(...homeSongRows(page.runs));
    const next = page.nextCursor;
    if (rows.length >= limit || !page.hasMore || next === null || next === cursor) {
      return { rows, nextCursor: next, hasMore: page.hasMore };
    }
    cursor = next;
  }
}

function hidden(path: string): boolean {
  return path
    .split("/")
    .some((part) => part === ".cohub" || part === ".git" || part === "node_modules");
}

export type HomeFileFound = {
  readonly entry: FileEntry;
  readonly text: string | null;
};

/** Walks one Space's directories, yielding `.abc` files as their text arrives. */
export async function* walkScoreFiles(input: {
  readonly client: CohubFileClient;
  readonly spaceId: string;
  readonly shouldStop?: () => boolean;
}): AsyncGenerator<HomeFileFound[]> {
  const queue: string[] = [""];
  while (queue.length > 0) {
    if (input.shouldStop?.()) return;
    const dir = queue.shift();
    if (dir === undefined) continue;
    let entries: readonly FileEntry[];
    try {
      entries = await input.client.list({ spaceId: input.spaceId, path: dir });
    } catch (error) {
      if (statusOf(error) === 404) continue;
      throw error;
    }
    const batch: HomeFileFound[] = [];
    const scores: FileEntry[] = [];
    for (const entry of entries) {
      if (input.shouldStop?.()) return;
      if (hidden(entry.path)) continue;
      if (entry.type === "dir") {
        queue.push(entry.path);
        continue;
      }
      if (entry.type === "file" && entry.name.toLowerCase().endsWith(".abc")) {
        scores.push(entry);
      }
    }
    for (let start = 0; start < scores.length; start += 4) {
      if (input.shouldStop?.()) return;
      const found = await Promise.all(
        scores.slice(start, start + 4).map(async (entry): Promise<HomeFileFound> => {
          try {
            return {
              entry,
              text: (await input.client.read({ spaceId: input.spaceId, path: entry.path })).text,
            };
          } catch {
            return { entry, text: null };
          }
        }),
      );
      batch.push(...found);
    }
    if (batch.length > 0) yield batch;
  }
}

export type CopyScoreResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: "failed" };

/** Save as, into another Space: the same free name, never the same path. */
export async function copyScoreToSpace(input: {
  readonly client: CohubFileClient;
  readonly spaceId: string;
  readonly sourceFile: string | null;
  readonly taskRunId: string;
  readonly name: string | null;
  readonly text: string;
}): Promise<CopyScoreResult> {
  const folder = input.sourceFile === null ? "scores" : folderOf(input.sourceFile);
  let taken: Set<string>;
  try {
    taken = new Set(
      (await input.client.list({ spaceId: input.spaceId, path: folder }))
        .filter((entry) => entry.type === "file")
        .map((entry) => entry.name),
    );
  } catch (error) {
    if (statusOf(error) !== 404) return { ok: false, reason: "failed" };
    taken = new Set();
  }
  const path = saveAsPath(
    { sourceFile: input.sourceFile, taskRunId: input.taskRunId, name: input.name },
    taken,
  );
  try {
    await input.client.write({ spaceId: input.spaceId, path, text: input.text, expected: null });
    return { ok: true, path };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

export async function createNewScore(input: {
  readonly client: CohubFileClient;
  readonly spaceId: string;
  readonly text: string;
}): Promise<CopyScoreResult> {
  let taken: Set<string>;
  try {
    taken = new Set(
      (await input.client.list({ spaceId: input.spaceId, path: "scores" }))
        .filter((entry) => entry.type === "file")
        .map((entry) => entry.name),
    );
  } catch (error) {
    if (statusOf(error) !== 404) return { ok: false, reason: "failed" };
    taken = new Set();
  }
  const path = newScorePath(taken);
  try {
    await input.client.write({ spaceId: input.spaceId, path, text: input.text, expected: null });
    return { ok: true, path };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

export function pickWorkingSpace(input: {
  readonly client: Pick<CohubAppClient, "pickSpace">;
  readonly reason: string;
  readonly scopes?: readonly string[];
}): Promise<PickSpaceResult> {
  return input.client.pickSpace({
    scopes: input.scopes ?? HOME_SCOPES,
    reason: input.reason,
  });
}
