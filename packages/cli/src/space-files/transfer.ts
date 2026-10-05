import { randomUUID } from "node:crypto";
import { createWriteStream, type Stats } from "node:fs";
import { cp, lstat, mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { UPLOAD_MAX_FILE_BYTES, type SpaceFsCopyResult, type SpaceFsCopyStats, type SpaceFsTreeResponse } from "@neta-art/cohub";
import { createLimiter } from "./limit.js";
import { uploadLocalFiles, type LocalUploadEntry, type SpaceFiles } from "./upload.js";

export type CopyOptions = {
  recursive: boolean;
  noClobber: boolean;
  preserveTimestamps: boolean;
};

export class CopyAbortError extends Error {
  override name = "CopyAbortError";
}

export const emptyCopyResult = (): SpaceFsCopyResult => ({
  files: 0, dirs: 0, symlinks: 0, bytes: 0, paths: [], overwritten: 0, skipped: 0, errors: [],
});

export function mergeCopyResults(results: SpaceFsCopyResult[]): SpaceFsCopyResult {
  const merged = emptyCopyResult();
  for (const result of results) {
    for (const key of ["files", "dirs", "symlinks", "bytes", "overwritten", "skipped"] as const) merged[key] += result[key];
    merged.paths.push(...result.paths);
    merged.errors.push(...result.errors);
  }
  return merged;
}

const display = (path: string) => path || ".";

const targetOf = (source: string, destination: string, intoDirectory: boolean, join: (a: string, b: string) => string) => {
  const name = posix.basename(source);
  return intoDirectory && name ? join(destination, name) : destination;
};

const joinSpacePath = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);

const lstatOrNull = (path: string) => lstat(path).catch(() => null);

type SpaceNode = { type: "dir"; tree: SpaceFsTreeResponse } | { type: "file" } | null;

export async function statSpacePath(files: SpaceFiles, path: string): Promise<SpaceNode> {
  try {
    return { type: "dir", tree: await files.list(path) };
  } catch (error) {
    const { status, code } = error as { status?: number; code?: string | null };
    if (status === 404) return null;
    if (code === "not_a_directory") return { type: "file" };
    throw error;
  }
}

export async function checkDestination(input: {
  sourceCount: number;
  display: string;
  stat: (path: string) => Promise<"dir" | "file" | null>;
  path: string;
  parent: string;
}) {
  const node = await input.stat(input.path);
  if (input.sourceCount > 1 && node !== "dir") throw new CopyAbortError(`target '${input.display}' is not a directory`);
  if (!node && input.parent !== input.path && (await input.stat(input.parent)) !== "dir") {
    throw new CopyAbortError(`cannot create '${input.display}': No such file or directory`);
  }
  return node === "dir";
}

export const spaceNodeType = async (files: SpaceFiles, path: string) => (await statSpacePath(files, path))?.type ?? null;

export const localNodeType = async (path: string) => {
  const stats = await lstatOrNull(path);
  return stats ? (stats.isDirectory() ? "dir" : "file") : null;
};

const isUploadableName = (name: string) =>
  name.length > 0 && name.length <= 255 && name !== "." && name !== ".." && name.trim() === name &&
  !/[<>:"/\\|?*]/.test(name) && ![...name].some((char) => char.charCodeAt(0) <= 0x1f);

export async function uploadToSpace(input: {
  files: SpaceFiles;
  sources: string[];
  destination: string;
  intoDirectory: boolean;
  options: CopyOptions;
  onProgress: (stats: SpaceFsCopyStats) => void;
}): Promise<SpaceFsCopyResult> {
  const { files, options } = input;
  const result = emptyCopyResult();
  const fail = (path: string, code: string, message: string) => {
    result.errors.push({ path, code, message });
  };
  const entries: LocalUploadEntry[] = [];

  const walk = async (localPath: string, target: string, stats: Stats): Promise<void> => {
    if (stats.isFile()) {
      entries.push({ localPath, relativePath: target, size: stats.size });
      return;
    }
    if (!stats.isDirectory()) {
      result.skipped += 1;
      return;
    }
    const names = await readdir(localPath);
    await Promise.all(names.map(async (name) => {
      const child = join(localPath, name);
      const childStats = await stat(child).catch(() => null);
      if (childStats) await walk(child, joinSpacePath(target, name), childStats);
    }));
  };

  for (const source of input.sources) {
    const stats = await stat(source).catch(() => null);
    if (!stats) {
      fail(source, "path_not_found", `cannot stat '${source}': No such file or directory`);
      continue;
    }
    if (stats.isDirectory() && !options.recursive) {
      fail(source, "is_a_directory", `-r not specified; omitting directory '${source}'`);
      continue;
    }
    const target = targetOf(source, input.destination, input.intoDirectory, joinSpacePath);
    await walk(source, target, stats);
    result.paths.push(target);
  }

  const parents = [...new Set(entries.map((entry) => posix.dirname(entry.relativePath)).map((dir) => (dir === "." ? "" : dir)))];
  const limit = createLimiter(8);
  const existing = new Map<string, "dir" | "file" | "symlink">();
  await Promise.all(parents.map((dir) => limit(async () => {
    const node = await statSpacePath(files, dir);
    if (node?.type === "dir") for (const entry of node.tree.entries) existing.set(entry.path, entry.type);
  })));

  const upload = entries.filter((entry) => {
    const current = existing.get(entry.relativePath);
    if (current === "dir") {
      fail(entry.relativePath, "is_a_directory", `cannot overwrite directory '${entry.relativePath}' with non-directory`);
      return false;
    }
    if (current && options.noClobber) {
      result.skipped += 1;
      return false;
    }
    if (!entry.relativePath.split("/").every(isUploadableName)) {
      fail(entry.relativePath, "name_invalid", `cannot upload '${entry.localPath}': unsupported file name`);
      return false;
    }
    if (entry.size > UPLOAD_MAX_FILE_BYTES) {
      fail(entry.relativePath, "file_too_large", `cannot upload '${entry.localPath}': file exceeds the upload size limit`);
      return false;
    }
    if (current) result.overwritten += 1;
    return true;
  });

  const progress = { files: 0, dirs: 0, symlinks: 0, bytes: 0 };
  await uploadLocalFiles(files, upload, {
    onUploaded: (entry) => {
      progress.files += 1;
      progress.bytes += entry.size;
      input.onProgress(progress);
    },
  });
  return { ...result, ...progress };
}

export async function downloadFromSpace(input: {
  sources: Array<{ files: SpaceFiles; path: string }>;
  destination: string;
  intoDirectory: boolean;
  options: CopyOptions;
  onProgress: (stats: SpaceFsCopyStats) => void;
}): Promise<SpaceFsCopyResult> {
  const { options } = input;
  const result = emptyCopyResult();
  const fail = (path: string, code: string, message: string) => {
    result.errors.push({ path, code, message });
  };
  const limit = createLimiter(6);
  const report = () => input.onProgress(result);

  const downloadFile = async (files: SpaceFiles, path: string, target: string, mtimeMs?: number) => {
    const current = await lstatOrNull(target);
    if (current?.isDirectory()) return fail(target, "is_a_directory", `cannot overwrite directory '${target}' with non-directory`);
    if (current && options.noClobber) {
      result.skipped += 1;
      return;
    }
    const temp = join(dirname(target), `.cohub-download.${randomUUID().slice(0, 8)}`);
    try {
      const bytes = await limit(async () => {
        const { response } = await files.open(path);
        let written = 0;
        if (response.body) {
          const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
          body.on("data", (chunk: Buffer) => {
            written += chunk.length;
          });
          await pipeline(body, createWriteStream(temp, { flags: "wx" }));
        } else {
          await pipeline(Readable.from([]), createWriteStream(temp, { flags: "wx" }));
        }
        return written;
      });
      if (options.preserveTimestamps && mtimeMs !== undefined) await utimes(temp, new Date(), new Date(mtimeMs));
      await rename(temp, target);
      result.files += 1;
      result.bytes += bytes;
      if (current) result.overwritten += 1;
      report();
    } catch (error) {
      await rm(temp, { force: true });
      fail(target, "download_failed", `cannot download '${display(path)}': ${(error as Error).message}`);
    }
  };

  const downloadDir = async (files: SpaceFiles, tree: SpaceFsTreeResponse, target: string): Promise<void> => {
    const current = await lstatOrNull(target);
    if (current && !current.isDirectory()) {
      return fail(target, "not_a_directory", `cannot overwrite non-directory '${target}' with directory '${display(tree.path)}'`);
    }
    if (!current) await mkdir(target);
    result.dirs += 1;
    if (tree.entries.length >= 1000) {
      fail(target, "listing_truncated", `cannot copy all of '${display(tree.path)}': directories with 1000 or more entries are not fully listed`);
    }
    await Promise.all(tree.entries.map(async (entry) => {
      const child = join(target, entry.name);
      if (entry.type === "file") return downloadFile(files, entry.path, child, entry.mtimeMs);
      if (entry.type === "symlink") {
        result.skipped += 1;
        return;
      }
      const node = await limit(() => statSpacePath(files, entry.path));
      if (node?.type === "dir") await downloadDir(files, node.tree, child);
    }));
  };

  for (const { files, path } of input.sources) {
    const node = await statSpacePath(files, path);
    if (!node) {
      fail(path, "path_not_found", `cannot stat '${display(path)}': No such file or directory`);
      continue;
    }
    if (node.type === "dir" && !options.recursive) {
      fail(path, "is_a_directory", `-r not specified; omitting directory '${display(path)}'`);
      continue;
    }
    const target = targetOf(path, input.destination, input.intoDirectory, join);
    if (node.type === "dir") {
      await downloadDir(files, node.tree, target);
    } else {
      const parent = options.preserveTimestamps ? await statSpacePath(files, posix.dirname(path) === "." ? "" : posix.dirname(path)) : null;
      const mtimeMs = parent?.type === "dir" ? parent.tree.entries.find((entry) => entry.path === path)?.mtimeMs : undefined;
      await downloadFile(files, path, target, mtimeMs);
    }
    result.paths.push(target);
  }
  return result;
}

export async function copyLocal(input: {
  sources: string[];
  destination: string;
  intoDirectory: boolean;
  options: CopyOptions;
}): Promise<SpaceFsCopyResult> {
  const { options } = input;
  const result = emptyCopyResult();
  const fail = (path: string, code: string, message: string) => {
    result.errors.push({ path, code, message });
  };

  for (const source of input.sources) {
    const stats = await lstatOrNull(source);
    if (!stats) {
      fail(source, "path_not_found", `cannot stat '${source}': No such file or directory`);
      continue;
    }
    if (stats.isDirectory() && !options.recursive) {
      fail(source, "is_a_directory", `-r not specified; omitting directory '${source}'`);
      continue;
    }
    const target = targetOf(source, input.destination, input.intoDirectory, join);
    if (target === source) {
      fail(source, "same_file", `'${source}' and '${target}' are the same file`);
      continue;
    }
    if (stats.isDirectory() && target.startsWith(`${source}/`)) {
      fail(source, "copy_into_itself", `cannot copy a directory, '${source}', into itself, '${target}'`);
      continue;
    }
    try {
      await cp(source, target, {
        recursive: true,
        force: !options.noClobber,
        errorOnExist: false,
        preserveTimestamps: options.preserveTimestamps,
        verbatimSymlinks: true,
        filter: async (from, to) => {
          const node = await lstat(from);
          if (node.isDirectory()) {
            result.dirs += 1;
            return true;
          }
          const existing = await lstatOrNull(to);
          if (existing && options.noClobber) {
            result.skipped += 1;
            return false;
          }
          if (existing) result.overwritten += 1;
          if (node.isSymbolicLink()) result.symlinks += 1;
          else {
            result.files += 1;
            result.bytes += node.size;
          }
          return true;
        },
      });
      result.paths.push(target);
    } catch (error) {
      fail(target, "copy_failed", `cannot copy '${source}': ${(error as Error).message}`);
    }
  }
  return result;
}
