import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { mimeTypeForPath } from "@neta-art/cohub";
import { isBoardPath } from "@neta-art/cohub/board";
import type { ResolvedFile } from "@neta-art/cohub/media";
import { createClient } from "./client.js";
import { WORKSPACE_ROOT } from "./space-files/operands.js";

/** A Space `.board` file only names its Board; a local one holds the document itself. */
export const isSpaceBoardManifest = (value: unknown) =>
  Boolean(value) && typeof value === "object" && typeof (value as { boardId?: unknown }).boardId === "string";

/**
 * Whether `target` is a local Board, decided by the file and never by the caller:
 * an existing `.board` file by its content, a missing one by whether this CLI
 * targets a Space here (`create` makes it there).
 */
export async function isLocalBoard(target: string, targetsSpace: () => Promise<boolean>): Promise<boolean> {
  if (!isBoardPath(target)) return false;
  const text = await readFile(target, "utf8").catch(() => null);
  if (text === null) return !(await targetsSpace());
  try {
    return !isSpaceBoardManifest(JSON.parse(text));
  } catch {
    return true;
  }
}

/** Where the files a Board names by relative path (media, script modules) come from. */
export type BoardFiles = {
  read(path: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }>;
  /** A hosted URL with media facts; null when the files have no host. */
  resolve(path: string, signal?: AbortSignal): Promise<ResolvedFile | null>;
  local(path: string): string | null;
};

const within = (root: string, path: string) => {
  const file = resolve(root, path);
  return file.startsWith(`${root}${sep}`) ? file : null;
};

export function spaceBoardFiles(spaceId: string): BoardFiles {
  const client = createClient();
  const local = process.env.COHUB_SPACE_ID === spaceId;
  return {
    async read(path) {
      const { blob, mimeType } = await client.space(spaceId).files.download(path);
      return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType };
    },
    resolve: (path, signal) => client.space(spaceId).files.resolve(path, { purpose: "playback", signal }).catch(() => null),
    local: (path) => (local ? within(WORKSPACE_ROOT, path) : null),
  };
}

/** Files beside a local Board file; a symlink may not lead outside its folder. */
export function localBoardFiles(dir: string): BoardFiles {
  const root = resolve(dir);
  const contained = async (path: string) => {
    const file = within(root, path);
    if (!file) throw new Error(`${path} is outside ${root}.`);
    const [real, top] = await Promise.all([realpath(file), realpath(root)]);
    if (!real.startsWith(`${top}${sep}`)) throw new Error(`${path} leads outside ${root}.`);
    return real;
  };
  return {
    async read(path, signal) {
      const bytes = new Uint8Array(await readFile(await contained(path), { signal }));
      return { bytes, mimeType: mimeTypeForPath(path) ?? "application/octet-stream" };
    },
    resolve: async () => null,
    local: (path) => within(root, path),
  };
}
