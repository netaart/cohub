import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, readdir } from "node:fs/promises";
import { isAbsolute, join, normalize, relative } from "node:path";
import {
  CHECKPOINT_HARD_EXCLUDES,
  CHECKPOINT_PLATFORM_IGNORE,
} from "@cohub/core/checkpoint/ignore";
import { mimeTypeForPath } from "@cohub/protocol/fs";
import ignore, { type Ignore } from "ignore";
import { mapLimit } from "./limit.js";

/** Per-directory lstat fan-out; NFS calls are latency-bound, so this rides on the libuv pool size. */
const SCAN_CONCURRENCY = 64;

export type DiscoveredGitRepo = {
  path: string;
  absPath: string;
};

export type ScannedFile = {
  path: string;
  absPath: string;
  type: "file" | "symlink";
  size: number;
  executable: boolean;
  mimeType: string | null;
  /** Change detection fingerprint: nanosecond mtime/ctime and inode, as decimal strings. */
  mtimeNs: string;
  ctimeNs: string;
  ino: string;
};

export type ScanWarning = {
  path: string;
  type: string;
  action: "skipped";
  reason: string;
};

type IgnoreMatcher = {
  baseDir: string;
  matcher: Ignore;
};

const normalizeRel = (root: string, absPath: string) => relative(root, absPath);
const pathForIgnore = (path: string, isDirectory: boolean) => (isDirectory && !path.endsWith("/") ? `${path}/` : path);

async function readGitignore(dir: string): Promise<IgnoreMatcher | null> {
  const content = await readFile(join(dir, ".gitignore"), "utf8").catch(() => null);
  if (!content) return null;
  return { baseDir: dir, matcher: ignore().add(content) };
}

/** Copy `path` to `stagedPath` and hash the copied bytes in the same read, so hash and content always agree. */
export async function stageFile(path: string, stagedPath: string) {
  const hash = createHash("sha256");
  let size = 0;
  await pipeline(createReadStream(path), async function* (source: AsyncIterable<Buffer>) {
    for await (const chunk of source) {
      hash.update(chunk);
      size += chunk.length;
      yield chunk;
    }
  }, createWriteStream(stagedPath));
  return { sha256: hash.digest("hex"), size };
}

const isSafeSymlinkTarget = (target: string) => {
  if (isAbsolute(target)) return false;
  const normalized = normalize(target).replace(/\\/g, "/");
  return normalized !== ".." && !normalized.startsWith("../");
};

const isIgnoredByMatchers = (absPath: string, isDirectory: boolean, matchers: IgnoreMatcher[]) => {
  for (const { baseDir, matcher } of matchers) {
    const rel = normalizeRel(baseDir, absPath);
    if (!rel || rel.startsWith("../")) continue;
    if (matcher.ignores(pathForIgnore(rel, isDirectory))) return true;
  }
  return false;
};

export async function scanWorkspace(root: string) {
  const candidates: ScannedFile[] = [];
  const gitRepos: DiscoveredGitRepo[] = [];
  const warnings: ScanWarning[] = [];
  let ignoredCount = 0;

  const systemMatcher = ignore().add([...CHECKPOINT_HARD_EXCLUDES]).add(CHECKPOINT_PLATFORM_IGNORE);

  const walk = async (dir: string, inheritedMatchers: IgnoreMatcher[]) => {
    const localMatcher = await readGitignore(dir);
    const matchers = localMatcher ? [...inheritedMatchers, localMatcher] : inheritedMatchers;
    const names = await readdir(dir).catch(() => []);

    await mapLimit(names, SCAN_CONCURRENCY, async (name) => {
      const absPath = join(dir, name);
      const rel = normalizeRel(root, absPath);
      const st = await lstat(absPath, { bigint: true }).catch(() => null);
      if (!st) return;
      const stamp = { mtimeNs: st.mtimeNs.toString(), ctimeNs: st.ctimeNs.toString(), ino: st.ino.toString() };
      const isDirectory = st.isDirectory() && !st.isSymbolicLink();
      const ignorePath = pathForIgnore(rel, isDirectory);

      if (isDirectory && name === ".git") {
        const repoPath = normalizeRel(root, dir) || ".";
        gitRepos.push({ path: repoPath, absPath: dir });
        ignoredCount += 1;
        return;
      }

      if (systemMatcher.ignores(ignorePath) || isIgnoredByMatchers(absPath, isDirectory, matchers)) {
        ignoredCount += 1;
        return;
      }

      if (isDirectory) return walk(absPath, matchers);
      if (st.isFile()) {
        candidates.push({
          path: rel,
          absPath,
          type: "file",
          size: Number(st.size),
          executable: (st.mode & 0o111n) !== 0n,
          mimeType: mimeTypeForPath(rel),
          ...stamp,
        });
        return;
      }
      if (st.isSymbolicLink()) {
        const target = await readlink(absPath).catch(() => null);
        if (!target || !isSafeSymlinkTarget(target)) {
          warnings.push({ path: rel, type: "symlink", action: "skipped", reason: "unsafe_symlink_target" });
          return;
        }
        candidates.push({ path: rel, absPath, type: "symlink", size: Number(st.size), executable: false, mimeType: null, ...stamp });
        return;
      }
      warnings.push({ path: rel, type: st.isSocket() ? "socket" : st.isFIFO() ? "fifo" : st.isBlockDevice() ? "block_device" : st.isCharacterDevice() ? "char_device" : "unknown", action: "skipped", reason: "unsupported_file_type" });
    });
  };

  await walk(root, []);
  return { files: candidates.sort((a, b) => a.path.localeCompare(b.path)), gitRepos: gitRepos.sort((a, b) => a.path.localeCompare(b.path)), warnings, ignoredCount };
}
