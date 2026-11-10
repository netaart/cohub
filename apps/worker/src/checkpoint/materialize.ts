import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, readlink, rename, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { runGitWithOutput } from "./git.js";
import { mapLimit } from "./limit.js";
import { CHECKPOINT_ASSET_MANIFEST_PATH, CHECKPOINT_META_PATH } from "./paths.js";
import type { ScannedFile } from "./scan.js";

/** NFS copies and stats are latency-bound; keep enough in flight without queueing the whole tree. */
const COPY_CONCURRENCY = Number(process.env.CHECKPOINT_COPY_CONCURRENCY ?? 64);

const metaDir = dirname(CHECKPOINT_META_PATH);

function keepPathWithParents(keep: Set<string>, path: string) {
  const parts = path.split("/").filter(Boolean);
  for (let index = 1; index <= parts.length; index += 1) keep.add(parts.slice(0, index).join("/"));
}

async function removePath(path: string) {
  await rm(path, { recursive: true, force: true });
}

const isErrno = (error: unknown, ...codes: string[]) => codes.includes((error as NodeJS.ErrnoException)?.code ?? "");

/** Remove a non-directory (including a symlink, which mkdir would follow) left where `path` needs a parent directory. */
async function clearFileAncestors(latestDir: string, path: string) {
  const parts = path.split("/").slice(0, -1);
  for (let index = 1; index <= parts.length; index += 1) {
    const ancestor = join(latestDir, ...parts.slice(0, index));
    const st = await lstat(ancestor).catch(() => null);
    if (!st) return;
    if (!st.isDirectory()) return removePath(ancestor);
  }
}

export async function copyEntryToLatest(file: Pick<ScannedFile, "path" | "absPath" | "type">, latestDir: string) {
  const target = join(latestDir, file.path);
  await clearFileAncestors(latestDir, file.path);
  await mkdir(dirname(target), { recursive: true, mode: 0o775 });
  await removePath(target);
  try {
    if (file.type === "symlink") {
      await symlink(await readlink(file.absPath), target);
      return;
    }
    await copyFile(file.absPath, target, constants.COPYFILE_FICLONE);
  } catch (error) {
    // Deleted since the scan; the next save records the deletion.
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

async function collectExisting(root: string, dir = root): Promise<string[]> {
  const names = await readdir(dir).catch(() => []);
  const nested = await mapLimit(names, COPY_CONCURRENCY, async (name) => {
    const absPath = join(dir, name);
    const rel = relative(root, absPath);
    const st = await lstat(absPath).catch(() => null);
    if (!st) return [];
    if (st.isDirectory() && !st.isSymbolicLink()) return [rel, ...await collectExisting(root, absPath)];
    return [rel];
  });
  return nested.flat();
}

async function writeLatestMetaFile(latestDir: string, meta: Record<string, unknown>) {
  await mkdir(join(latestDir, metaDir), { recursive: true, mode: 0o775 });
  const metaTarget = join(latestDir, CHECKPOINT_META_PATH);
  const tmpMeta = `${metaTarget}.tmp-${crypto.randomUUID()}`;
  await writeFile(tmpMeta, `${JSON.stringify(meta, null, 2)}\n`);
  await rename(tmpMeta, metaTarget).finally(() => unlink(tmpMeta).catch(() => undefined));
}

export async function readLatestCommit(latestDir: string) {
  const raw = await readFile(join(latestDir, CHECKPOINT_META_PATH), "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const meta = JSON.parse(raw) as { commitHash?: unknown; incomplete?: unknown };
    return typeof meta.commitHash === "string" && !meta.incomplete ? meta.commitHash : null;
  } catch {
    return null;
  }
}

async function removeWithEmptyParents(latestDir: string, path: string) {
  await removePath(join(latestDir, path));
  const parts = path.split("/").slice(0, -1);
  while (parts.length > 0) {
    if (await rmdir(join(latestDir, ...parts)).then(() => false, () => true)) return;
    parts.pop();
  }
}

async function copyPathToLatest(workspaceDir: string, latestDir: string, path: string) {
  const absPath = join(workspaceDir, path);
  const st = await lstat(absPath).catch(() => null);
  if (!st || !(st.isFile() || st.isSymbolicLink())) return removeWithEmptyParents(latestDir, path);
  await copyEntryToLatest({ path, absPath, type: st.isSymbolicLink() ? "symlink" : "file" }, latestDir);
}

/** Workspace paths that differ between two commits, from git in `repoDir`. */
export async function diffCommitPaths(repoDir: string, from: string, to: string) {
  const { stdout } = await runGitWithOutput(["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to], repoDir);
  const fields = stdout.split("\0");
  const upserts: string[] = [];
  const deletes: string[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const path = fields[index + 1] as string;
    if (path.startsWith(".cohub/system/")) continue;
    (fields[index] === "D" ? deletes : upserts).push(path);
  }
  return { upserts, deletes };
}

/**
 * Point latest at a new commit. When latest holds the commit the change list
 * was taken against, only those paths are copied or removed; otherwise it is
 * rebuilt from a scan. The meta is cleared first, so an interrupted update
 * makes the next refresh rebuild in full.
 */
export async function refreshLatest(input: {
  latestDir: string;
  workspaceDir: string;
  checkpointMeta: Record<string, unknown> & { commitHash: string };
  changes: { from: string | null; upserts: string[]; deletes: string[] } | null;
  /** Paths that differ between latest's commit and the new one, when the change list does not apply. */
  diffFrom: (from: string) => Promise<{ upserts: string[]; deletes: string[] } | null>;
  scanFiles: () => Promise<ScannedFile[]>;
}) {
  const current = await readLatestCommit(input.latestDir);
  if (current === input.checkpointMeta.commitHash) return { mode: "current" as const, copied: 0, deleted: 0 };
  let changes: { upserts: string[]; deletes: string[] } | null = input.changes && current !== null && current === input.changes.from ? input.changes : null;
  if (!changes && current !== null) {
    changes = await input.diffFrom(current).catch((error: unknown) => {
      console.warn(`[checkpoint] incremental latest update failed, rebuilding: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
  }
  if (changes) {
    await writeLatestMetaFile(input.latestDir, { incomplete: true });
    for (const path of changes.deletes) await removeWithEmptyParents(input.latestDir, path);
    await mapLimit(changes.upserts, COPY_CONCURRENCY, (path) => copyPathToLatest(input.workspaceDir, input.latestDir, path));
    await writeLatestMetaFile(input.latestDir, input.checkpointMeta);
    return { mode: "diff" as const, copied: changes.upserts.length, deleted: changes.deletes.length };
  }
  const files = await input.scanFiles();
  await materializeLatest({ latestDir: input.latestDir, files, checkpointMeta: input.checkpointMeta });
  return { mode: "full" as const, copied: files.length, deleted: 0 };
}

export async function materializeLatest(input: {
  latestDir: string;
  files: ScannedFile[];
  checkpointMeta: Record<string, unknown>;
}) {
  await mkdir(input.latestDir, { recursive: true, mode: 0o775 });
  const keep = new Set<string>();
  for (const file of input.files) keepPathWithParents(keep, file.path);
  keepPathWithParents(keep, CHECKPOINT_META_PATH);

  await writeLatestMetaFile(input.latestDir, { incomplete: true });
  await mapLimit(input.files, COPY_CONCURRENCY, (file) => copyEntryToLatest(file, input.latestDir));

  const existing = (await collectExisting(input.latestDir)).sort((a, b) => b.length - a.length);
  for (const rel of existing) {
    if (rel === ".cohub" || rel === metaDir || rel === CHECKPOINT_META_PATH) continue;
    if (rel === CHECKPOINT_ASSET_MANIFEST_PATH || !keep.has(rel)) {
      await removePath(join(input.latestDir, rel));
    }
  }
  await writeLatestMetaFile(input.latestDir, input.checkpointMeta);
}
