import { constants, type Stats } from "node:fs";
import { copyFile, lstat, lutimes, mkdir, open, readdir, readlink, rm, symlink, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import { isSpaceFsStagingName, type SpaceGitignoreFilter } from "@cohub/core/space-fs";
import type { SpaceFsCopyError, SpaceFsCopyOptions, SpaceFsCopyStats } from "@cohub/protocol/fs";

export type CopyRoot = {
  spaceId: string;
  root: string;
  filter: SpaceGitignoreFilter | null;
};

export type CopyNodeType = "file" | "dir" | "symlink";

export type CopyOp = {
  kind: "create" | "replace";
  source: CopyRoot;
  sourcePath: string;
  sourceType: CopyNodeType;
  targetPath: string;
  expected?: { size: number; mtimeMs: number };
};

export type CopyPlan = {
  ops: CopyOp[];
  paths: string[];
  skipped: number;
  errors: SpaceFsCopyError[];
};

export class CopyRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "CopyRequestError";
  }
}

export class CopyPathChangedError extends Error {
  readonly code = "ECHANGED";

  constructor(path: string) {
    super(`path changed while copying: ${path}`);
    this.name = "CopyPathChangedError";
  }
}

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

function createLimiter(concurrency: number): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (task) => {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

export type CopyLimits = { io: Limiter; pins: Limiter };

export const createCopyLimits = (concurrency: number): CopyLimits => ({
  io: createLimiter(concurrency),
  pins: createLimiter(concurrency),
});

export const emptyCopyStats = (): SpaceFsCopyStats => ({ files: 0, dirs: 0, symlinks: 0, bytes: 0 });

export const joinPath = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);

export const parentPath = (path: string) => {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
};

const display = (path: string) => path || ".";

const absolutePath = (root: string, path: string) => (path ? join(root, path) : root);

const isInside = (path: string, parent: string) => parent === "" || path === parent || path.startsWith(`${parent}/`);

function nodeType(stats: Stats): CopyNodeType | null {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "dir";
  if (stats.isFile()) return "file";
  return null;
}

export function describeFsError(error: unknown) {
  switch (errorCode(error)) {
    case "ENOENT": return "No such file or directory";
    case "EACCES":
    case "EPERM": return "Permission denied";
    case "ENOSPC": return "No space left on device";
    case "EDQUOT": return "Disk quota exceeded";
    case "ENAMETOOLONG": return "File name too long";
    case "ECHANGED": return "Path changed while copying";
    default: return "Input/output error";
  }
}

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException | null)?.code;
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return null;
    throw error;
  }
}

// The worker mounts every Space: directories are opened without following symlinks,
// checked against their exact real path, and entries are resolved through the descriptor.
const FD_ROOT = "/proc/self/fd";

type PinnedDir = {
  handle: FileHandle;
  entry: (name: string) => string;
};

async function openPinnedDir(path: string): Promise<PinnedDir> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ELOOP" || (errorCode(error) === "ENOTDIR" && (await lstatOrNull(path))?.isSymbolicLink())) {
      throw new CopyPathChangedError(path);
    }
    throw error;
  }
  const resolved = await readlink(`${FD_ROOT}/${handle.fd}`).catch(async (error: unknown) => {
    await handle.close();
    if (errorCode(error) === "ENOENT") throw new Error("Space copies require /proc/self/fd (Linux)");
    throw error;
  });
  if (resolved !== path) {
    await handle.close();
    throw new CopyPathChangedError(path);
  }
  const base = `${FD_ROOT}/${handle.fd}`;
  return { handle, entry: (name) => (name ? `${base}/${name}` : base) };
}

async function withPinnedDirs<T>(paths: string[], limits: CopyLimits, task: (dirs: PinnedDir[]) => Promise<T>): Promise<T> {
  return limits.pins(async () => {
    const dirs: PinnedDir[] = [];
    try {
      for (const path of paths) dirs.push(await limits.io(() => openPinnedDir(path)));
      return await task(dirs);
    } finally {
      await Promise.all(dirs.map((dir) => dir.handle.close()));
    }
  });
}

async function lstatIn(dir: string, name: string, limits: CopyLimits) {
  try {
    return await withPinnedDirs([dir], limits, ([pinned]) => limits.io(() => lstatOrNull((pinned as PinnedDir).entry(name))));
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return null;
    throw error;
  }
}

const isHidden = (root: CopyRoot, path: string, stats: Stats) =>
  root.filter?.isIgnored(path, { isDirectory: stats.isDirectory() }) === true;

type Child = { name: string; path: string; stats: Stats; type: CopyNodeType };

async function listChildren(root: CopyRoot, path: string, dir: PinnedDir, limits: CopyLimits) {
  const names = await limits.io(() => readdir(dir.entry("")));
  const children: Child[] = [];
  let special = 0;
  await Promise.all(names.map(async (name) => {
    if (isSpaceFsStagingName(name)) return;
    const childPath = joinPath(path, name);
    const stats = await limits.io(() => lstatOrNull(dir.entry(name)));
    if (!stats || isHidden(root, childPath, stats)) return;
    const type = nodeType(stats);
    if (type) children.push({ name, path: childPath, stats, type });
    else special += 1;
  }));
  return { children, special };
}

export async function planCopy(input: {
  target: CopyRoot;
  sources: Array<{ root: CopyRoot; path: string }>;
  destination: string;
  options: SpaceFsCopyOptions;
  limits: CopyLimits;
}): Promise<CopyPlan> {
  const { target, destination, options, limits } = input;
  const plan: CopyPlan = { ops: [], paths: [], skipped: 0, errors: [] };
  const fail = (path: string, code: string, message: string) => plan.errors.push({ path, code, message });
  const lstatOperand = (root: string, path: string) =>
    path ? lstatIn(absolutePath(root, parentPath(path)), basename(path), limits) : limits.io(() => lstat(root));

  const resolveOperand = async (root: string, path: string) => {
    try {
      return { stats: await lstatOperand(root, path) };
    } catch (error) {
      if (error instanceof CopyPathChangedError) return { crossesSymlink: true as const };
      throw error;
    }
  };

  const destinationOperand = await resolveOperand(target.root, destination);
  if ("crossesSymlink" in destinationOperand) {
    throw new CopyRequestError(400, "symlink_in_path", `cannot access '${destination}': the path goes through a symlink`);
  }
  const destinationStats = destinationOperand.stats;
  const intoDirectory = destinationStats?.isDirectory() === true;
  if (input.sources.length > 1 && !intoDirectory) {
    throw new CopyRequestError(400, "not_a_directory", `target '${display(destination)}' is not a directory`);
  }
  if (!destinationStats) {
    const parent = await resolveOperand(target.root, parentPath(destination));
    if (!("stats" in parent) || !parent.stats?.isDirectory()) {
      throw new CopyRequestError(404, "path_not_found", `cannot create '${destination}': No such file or directory`);
    }
  }

  const planNode = async (source: CopyRoot, sourcePath: string, type: CopyNodeType, targetPath: string, targetStats: Stats | null): Promise<boolean> => {
    if (!targetStats) {
      plan.ops.push({ kind: "create", source, sourcePath, sourceType: type, targetPath });
      return true;
    }
    if (type === "dir") {
      if (!targetStats.isDirectory()) {
        fail(targetPath, "not_a_directory", `cannot overwrite non-directory '${targetPath}' with directory '${display(sourcePath)}'`);
        return false;
      }
      let children: Array<{ child: Child; targetStats: Stats | null }>;
      try {
        children = await withPinnedDirs(
          [absolutePath(source.root, sourcePath), absolutePath(target.root, targetPath)],
          limits,
          async ([sourceDir, targetDir]) => {
            const listed = await listChildren(source, sourcePath, sourceDir as PinnedDir, limits);
            plan.skipped += listed.special;
            return Promise.all(listed.children.map(async (child) => ({
              child,
              targetStats: await limits.io(() => lstatOrNull((targetDir as PinnedDir).entry(child.name))),
            })));
          },
        );
      } catch (error) {
        fail(targetPath, "copy_failed", `cannot copy '${display(sourcePath)}': ${describeFsError(error)}`);
        return false;
      }
      await Promise.all(children.map(({ child, targetStats: childTargetStats }) =>
        planNode(source, child.path, child.type, joinPath(targetPath, child.name), childTargetStats)));
      return true;
    }
    if (targetStats.isDirectory()) {
      fail(targetPath, "is_a_directory", `cannot overwrite directory '${targetPath}' with non-directory '${display(sourcePath)}'`);
      return false;
    }
    if (options.noClobber) {
      plan.skipped += 1;
      return true;
    }
    if (type === "symlink" || targetStats.isSymbolicLink()) {
      fail(targetPath, "symlink_not_replaced", `cannot overwrite '${targetPath}': replacing symlinks is not supported`);
      return false;
    }
    plan.ops.push({
      kind: "replace",
      source,
      sourcePath,
      sourceType: type,
      targetPath,
      expected: { size: targetStats.size, mtimeMs: Math.trunc(targetStats.mtimeMs) },
    });
    return true;
  };

  const claimed: string[] = [];
  for (const { root, path } of input.sources) {
    const operand = await resolveOperand(root.root, path);
    if ("crossesSymlink" in operand) {
      fail(path, "symlink_in_path", `cannot access '${path}': the path goes through a symlink`);
      continue;
    }
    const { stats } = operand;
    const type = stats ? nodeType(stats) : null;
    if (!stats || isHidden(root, path, stats) || (path && isSpaceFsStagingName(basename(path)))) {
      fail(path, "path_not_found", `cannot stat '${display(path)}': No such file or directory`);
      continue;
    }
    if (!type) {
      fail(path, "unsupported_type", `cannot copy special file '${display(path)}'`);
      continue;
    }
    if (type === "dir" && !options.recursive) {
      fail(path, "is_a_directory", `-r not specified; omitting directory '${display(path)}'`);
      continue;
    }
    const name = basename(path);
    const targetPath = intoDirectory && name ? joinPath(destination, name) : destination;
    if (root.spaceId === target.spaceId) {
      if (targetPath === path) {
        fail(path, "same_file", `'${display(path)}' and '${display(targetPath)}' are the same file`);
        continue;
      }
      if (type === "dir" && isInside(targetPath, path)) {
        fail(path, "copy_into_itself", `cannot copy a directory, '${display(path)}', into itself, '${display(targetPath)}'`);
        continue;
      }
    }
    if (claimed.some((other) => isInside(targetPath, other) || isInside(other, targetPath))) {
      fail(path, "target_claimed", `will not overwrite just-created '${display(targetPath)}' with '${display(path)}'`);
      continue;
    }
    claimed.push(targetPath);
    const targetStats = targetPath === destination ? destinationStats : await lstatOperand(target.root, targetPath);
    if (await planNode(root, path, type, targetPath, targetStats)) plan.paths.push(targetPath);
  }

  plan.ops.sort((a, b) => a.targetPath.localeCompare(b.targetPath));
  plan.errors.sort((a, b) => a.path.localeCompare(b.path));
  return plan;
}

export async function stageCopyOp(input: {
  op: CopyOp;
  stagingPath: string;
  targetRoot: string;
  options: SpaceFsCopyOptions;
  limits: CopyLimits;
  progress: SpaceFsCopyStats;
}): Promise<{ stats: SpaceFsCopyStats; skipped: number }> {
  const { op, options, limits, progress } = input;
  const { io } = limits;
  const stats = emptyCopyStats();
  let skipped = 0;
  const count = (key: keyof SpaceFsCopyStats, value = 1) => {
    stats[key] += value;
    progress[key] += value;
  };

  const copyLeaf = async (from: string, to: string, source: Stats, type: "file" | "symlink") => {
    if (type === "symlink") {
      const link = await io(() => readlink(from));
      await io(() => symlink(link, to));
      count("symlinks");
    } else {
      await io(async () => {
        // O_NONBLOCK keeps a swapped-in FIFO from blocking the thread pool.
        const file = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          if (!(await file.stat()).isFile()) throw new CopyPathChangedError(from);
          await copyFile(`${FD_ROOT}/${file.fd}`, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
        } finally {
          await file.close();
        }
      });
      count("files");
      count("bytes", source.size);
    }
    if (options.preserveTimestamps) await io(() => lutimes(to, source.atime, source.mtime));
  };

  const finishDir = async (path: string, source: Stats) => {
    const mode = source.mode & 0o7777;
    if ((mode & 0o700) === 0o700 && !options.preserveTimestamps) return;
    await withPinnedDirs([path], limits, async ([dir]) => {
      const { handle } = dir as PinnedDir;
      if ((mode & 0o700) !== 0o700) await io(() => handle.chmod(mode));
      if (options.preserveTimestamps) await io(() => handle.utimes(source.atime, source.mtime));
    });
  };

  const copyDirContents = async (sourceAbs: string, sourcePath: string, targetAbs: string): Promise<void> => {
    const subdirs = await withPinnedDirs([sourceAbs, targetAbs], limits, async ([sourceDir, targetDir]) => {
      const from = sourceDir as PinnedDir;
      const to = targetDir as PinnedDir;
      const listed = await listChildren(op.source, sourcePath, from, limits);
      skipped += listed.special;
      const dirs: Child[] = [];
      await Promise.all(listed.children.map(async (child) => {
        if (child.type !== "dir") return copyLeaf(from.entry(child.name), to.entry(child.name), child.stats, child.type);
        await io(() => mkdir(to.entry(child.name), { mode: (child.stats.mode & 0o7777) | 0o700 }));
        count("dirs");
        dirs.push(child);
      }));
      return dirs;
    });
    await Promise.all(subdirs.map(async (child) => {
      const childTarget = join(targetAbs, child.name);
      await copyDirContents(join(sourceAbs, child.name), child.path, childTarget);
      await finishDir(childTarget, child.stats);
    }));
  };

  const sourceAbs = absolutePath(op.source.root, op.sourcePath);
  const sourceName = basename(op.sourcePath);
  const stagingParent = absolutePath(input.targetRoot, parentPath(input.stagingPath));
  const stagingName = basename(input.stagingPath);
  const parents = op.sourcePath ? [absolutePath(op.source.root, parentPath(op.sourcePath)), stagingParent] : [stagingParent];
  try {
    const sourceStats = await withPinnedDirs(parents, limits, async (dirs) => {
      const staging = (dirs.at(-1) as PinnedDir).entry(stagingName);
      const from = op.sourcePath ? (dirs[0] as PinnedDir).entry(sourceName) : op.source.root;
      const current = await io(() => lstatOrNull(from));
      if (!current || nodeType(current) !== op.sourceType) throw new CopyPathChangedError(sourceAbs);
      if (op.sourceType === "dir") {
        await io(() => mkdir(staging, { mode: (current.mode & 0o7777) | 0o700 }));
        count("dirs");
      } else {
        await copyLeaf(from, staging, current, op.sourceType);
      }
      return current;
    });
    if (op.sourceType === "dir") {
      const stagingAbs = join(stagingParent, stagingName);
      await copyDirContents(sourceAbs, op.sourcePath, stagingAbs);
      await finishDir(stagingAbs, sourceStats);
    }
    return { stats, skipped };
  } catch (error) {
    await removeStaging(input.targetRoot, input.stagingPath, limits);
    for (const key of Object.keys(stats) as Array<keyof SpaceFsCopyStats>) progress[key] -= stats[key];
    throw error;
  }
}

export async function removeStaging(targetRoot: string, stagingPath: string, limits: CopyLimits) {
  const name = basename(stagingPath);
  if (!isSpaceFsStagingName(name)) throw new Error(`Refusing to remove non-staging path: ${stagingPath}`);
  try {
    await withPinnedDirs([absolutePath(targetRoot, parentPath(stagingPath))], limits, ([dir]) =>
      limits.io(() => rm((dir as PinnedDir).entry(name), { recursive: true, force: true })));
  } catch (error) {
    if (error instanceof CopyPathChangedError || errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return;
    throw error;
  }
}
