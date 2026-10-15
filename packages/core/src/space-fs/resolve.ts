import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
export const SPACE_FILE_FLAGS = constants.O_NOFOLLOW | constants.O_NONBLOCK;
const fdPath = (file: FileHandle) => `/proc/self/fd/${file.fd}`;
const errorCode = (error: unknown) => error instanceof Error && "code" in error ? error.code : undefined;

export class SpaceFsPathError extends Error {
  readonly code = "path_invalid";
  constructor() {
    super("Path must stay within the workspace and use relative symlinks.");
    this.name = "SpaceFsPathError";
  }
}

export function assertWorkspaceId(spaceId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(spaceId)) throw new SpaceFsPathError();
}

export function directoryEntry(directory: FileHandle, name = ".") {
  if (!name || name === ".." || name.includes("/") || name.includes("\0")) throw new SpaceFsPathError();
  return `${fdPath(directory)}/${name}`;
}

export type ResolvedSpacePath = AsyncDisposable & {
  target: string;
  createdDirs: string[];
};

// 从根目录句柄逐段解析中间目录；相对链接中的 .. 只能返回已经打开的父目录。
// 末级目录项留给调用方处理，文件打开必须使用 SPACE_FILE_FLAGS。
export async function resolveSpacePath(root: string, path: string, createParents = false): Promise<ResolvedSpacePath> {
  if (isAbsolute(path) || path.includes("\0") || path.includes("\\") || path.length > 4096) throw new SpaceFsPathError();
  const parts = path.split("/").filter(Boolean);
  if (parts.length > 64 || parts.some((part) => part === "." || part === "..")) throw new SpaceFsPathError();
  if (process.platform !== "linux") throw new Error("Shared workspace storage requires Linux /proc/self/fd.");
  const absolute = resolve(root);
  const directory = await open(absolute, DIRECTORY_FLAGS);
  const directories = [directory];
  const resources = new AsyncDisposableStack();
  resources.use(directory);
  try {
    if (await readlink(fdPath(directory)) !== absolute) throw new SpaceFsPathError();
    const pending = parts.slice(0, -1).map((name, index) => ({ name, createdPath: parts.slice(0, index + 1).join("/") }));
    const createdDirs: string[] = [];
    let links = 0;
    while (pending.length) {
      const component = pending.shift();
      if (!component) throw new SpaceFsPathError();
      if (!component.name || component.name === ".") continue;
      if (component.name === "..") {
        if (directories.length === 1) throw new SpaceFsPathError();
        const parent = directories.pop();
        if (!parent) throw new SpaceFsPathError();
        await parent.close();
        continue;
      }
      const parent = directories.at(-1);
      if (!parent || directories.length > 64) throw new SpaceFsPathError();
      const target = directoryEntry(parent, component.name);
      if (createParents && component.createdPath) {
        try {
          await mkdir(target);
          createdDirs.push(component.createdPath);
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
        }
      }
      try {
        directories.push(resources.use(await open(target, DIRECTORY_FLAGS)));
      } catch (error) {
        if (errorCode(error) !== "ELOOP" && errorCode(error) !== "ENOTDIR") throw error;
        if (!(await lstat(target)).isSymbolicLink()) throw error;
        const link = await readlink(target);
        if (isAbsolute(link) || ++links > 40) throw new SpaceFsPathError();
        pending.unshift(...link.split("/").map((name) => ({ name, createdPath: "" })));
      }
    }
    const parent = directories.at(-1);
    if (!parent) throw new SpaceFsPathError();
    return {
      target: directoryEntry(parent, parts.at(-1) ?? "."),
      createdDirs,
      [Symbol.asyncDispose]: () => resources.disposeAsync(),
    };
  } catch (error) {
    await resources.disposeAsync();
    throw error;
  }
}

export async function openSpaceFile(root: string, path: string) {
  await using resolved = await resolveSpacePath(root, path);
  const file = await open(resolved.target, constants.O_RDONLY | SPACE_FILE_FLAGS);
  try {
    if (!(await file.stat()).isFile()) throw Object.assign(new Error("Target is not a regular file."), { code: "EISDIR" });
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function openSpaceDirectory(target: string) {
  try {
    return await open(target, DIRECTORY_FLAGS);
  } catch (error) {
    if (errorCode(error) === "ENOTDIR" && (await lstat(target)).isSymbolicLink()) throw new SpaceFsPathError();
    throw error;
  }
}

// 递归删除始终从已打开的目录访问子项，符号链接作为目录项直接删除。
export async function removeSpaceEntry(target: string, recursive: boolean): Promise<void> {
  if (!(await lstat(target)).isDirectory()) {
    await unlink(target);
    return;
  }
  if (!recursive) throw Object.assign(new Error("Recursive deletion is required for directories."), { code: "EISDIR" });
  await using directory = await openSpaceDirectory(target);
  for (const name of await readdir(directoryEntry(directory))) {
    await removeSpaceEntry(directoryEntry(directory, name), true);
  }
  await rmdir(target);
}
