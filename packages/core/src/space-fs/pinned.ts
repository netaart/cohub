import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_NOFOLLOW | constants.O_NONBLOCK;
const fdPath = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;
const errorCode = (error: unknown) => error instanceof Error && "code" in error ? error.code : undefined;

export class SpaceFsPathError extends Error {
  readonly code = "path_invalid";
  constructor() {
    super("Space file paths must not traverse symlinks or leave the workspace.");
    this.name = "SpaceFsPathError";
  }
}

export function assertWorkspaceId(spaceId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(spaceId)) throw new SpaceFsPathError();
}

function pathParts(path: string) {
  if (isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.length > 4096) throw new SpaceFsPathError();
  if (!path) return [];
  const parts = path.split("/");
  if (parts.length > 64 || parts.some((part) => !part || part === "." || part === "..")) throw new SpaceFsPathError();
  return parts;
}

async function openDirectory(path: string) {
  try {
    return await open(path, DIRECTORY_FLAGS);
  } catch (error) {
    if (errorCode(error) === "ELOOP" || errorCode(error) === "ENOTDIR") throw new SpaceFsPathError();
    throw error;
  }
}

/** Linux shared-volume operations fail closed if descriptor-relative access is unavailable. */
async function openRoot(root: string) {
  if (process.platform !== "linux") throw new Error("Shared workspace storage requires Linux /proc/self/fd.");
  const absolute = resolve(root);
  const handle = await openDirectory(absolute);
  try {
    // Opening the root follows intermediate components. Reject any redirected root
    // before exposing a descriptor to callers; never realpath an untrusted workspace.
    if (await readlink(fdPath(handle)) !== absolute) throw new SpaceFsPathError();
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export type PinnedSpacePath = {
  target: string;
  createdDirs: string[];
  close(): Promise<void>;
};

/** Pin every directory component. The final entry is deliberately not followed. */
export async function pinSpacePath(root: string, path: string, options: { createParents?: boolean } = {}): Promise<PinnedSpacePath> {
  const parts = pathParts(path);
  const rootHandle = await openRoot(root);
  const handles = [rootHandle];
  const createdDirs: string[] = [];
  const close = async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close()));
  };
  try {
    let parent = rootHandle;
    for (const [index, part] of parts.slice(0, -1).entries()) {
      const next = `${fdPath(parent)}/${part}`;
      if (options.createParents) {
        try {
          await mkdir(next);
          createdDirs.push(parts.slice(0, index + 1).join("/"));
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
        }
      }
      parent = await openDirectory(next);
      handles.push(parent);
    }
    return {
      // '/.' lets directory opens keep O_NOFOLLOW: the proc fd itself is trusted.
      target: parts.length ? `${fdPath(parent)}/${parts.at(-1)}` : `${fdPath(parent)}/.`,
      createdDirs,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function withSpacePath<T>(root: string, path: string, options: { createParents?: boolean }, task: (path: PinnedSpacePath) => Promise<T>): Promise<T> {
  const pinned = await pinSpacePath(root, path, options);
  try {
    return await task(pinned);
  } finally {
    await pinned.close();
  }
}

/** Open before inspecting metadata, then perform IO through this same handle. */
export async function openSpaceFile(root: string, path: string) {
  if (!path) throw new SpaceFsPathError();
  return withSpacePath(root, path, {}, async ({ target }) => {
    let handle: FileHandle;
    try {
      handle = await open(target, constants.O_RDONLY | FILE_FLAGS);
    } catch (error) {
      if (errorCode(error) === "ELOOP") throw new SpaceFsPathError();
      throw error;
    }
    try {
      if (!(await handle.stat()).isFile()) throw new SpaceFsPathError();
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  });
}

export async function openSpaceDirectory(root: string, path = "") {
  return withSpacePath(root, path, {}, async ({ target }) => openDirectory(target));
}

export function pinnedDirectoryEntry(handle: FileHandle, name = "") {
  // readdir returns native names, where backslashes are ordinary characters.
  if (name === "." || name === ".." || name.includes("/") || name.includes("\0")) throw new SpaceFsPathError();
  return name ? `${fdPath(handle)}/${name}` : `${fdPath(handle)}/.`;
}

export async function writeSpacePath(root: string, path: string, data: Uint8Array, options: { exclusive?: boolean; checkVersion?: (stats: Stats) => void } = {}) {
  if (!path) throw new SpaceFsPathError();
  return withSpacePath(root, path, { createParents: !options.checkVersion }, async (pinned) => {
    let handle: FileHandle;
    let created = false;
    if (options.checkVersion) {
      handle = await open(pinned.target, constants.O_WRONLY | FILE_FLAGS);
    } else {
      try {
        handle = await open(pinned.target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | FILE_FLAGS);
        created = true;
      } catch (error) {
        if (errorCode(error) !== "EEXIST" || options.exclusive) throw error;
        // Do not truncate before fstat/version validation. NOFOLLOW protects the leaf.
        handle = await open(pinned.target, constants.O_WRONLY | FILE_FLAGS);
      }
    }
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new SpaceFsPathError();
      options.checkVersion?.(before);
      await handle.truncate(0);
      await handle.writeFile(data);
      return { stats: await handle.stat(), created, createdDirs: pinned.createdDirs };
    } finally {
      await handle.close();
    }
  });
}

export async function createSpacePathDirectory(root: string, path: string) {
  if (!path) throw new SpaceFsPathError();
  return withSpacePath(root, path, { createParents: true }, async (pinned) => {
    let created = false;
    try {
      await mkdir(pinned.target);
      created = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const handle = await openDirectory(pinned.target);
    try {
      return { stats: await handle.stat(), created, createdDirs: [...pinned.createdDirs, ...(created ? [path] : [])] };
    } finally {
      await handle.close();
    }
  });
}

// Node's recursive rm walks path strings. Walk pinned directories instead so
// replacing any child with a symlink can never redirect recursion elsewhere.
async function removeEntry(target: string, recursive: boolean): Promise<Stats> {
  const stats = await lstat(target);
  if (!stats.isDirectory()) {
    await unlink(target);
    return stats;
  }
  if (!recursive) throw Object.assign(new Error("Path is a directory; recursive deletion is required."), { code: "EISDIR" });
  const dir = await openDirectory(target);
  try {
    for (const name of await readdir(pinnedDirectoryEntry(dir))) {
      await removeEntry(pinnedDirectoryEntry(dir, name), true);
    }
  } finally {
    await dir.close();
  }
  await rmdir(target);
  return stats;
}

export async function removeSpacePath(root: string, path: string, recursive: boolean) {
  if (!path) throw new SpaceFsPathError();
  return withSpacePath(root, path, {}, ({ target }) => removeEntry(target, recursive));
}

export async function renameSpacePath(root: string, from: string, to: string) {
  if (!from || !to) throw new SpaceFsPathError();
  return withSpacePath(root, from, {}, async (source) => {
    const stats = await lstat(source.target);
    return withSpacePath(root, to, { createParents: true }, async (destination) => {
      await rename(source.target, destination.target);
      return { stats, createdDirs: destination.createdDirs };
    });
  });
}
