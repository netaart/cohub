import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, readlink, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { checkpoints, spaces } from "@cohub/db";
import { db } from "../db.js";
import { config } from "../config.js";
import {
  CheckpointObjectsUnavailableError,
  checkpointGitDir,
  ensureCheckpointCommits,
  initCheckpointRepo,
  markCheckpointCommitComplete,
  runCheckpointGit,
} from "@cohub/core/checkpoint/storage";
import { getCheckpointSystemRepoDir, CHECKPOINT_ASSET_MANIFEST_PATH, LEGACY_USER_GIT_REPOS_PATH, USER_GIT_REPOS_PATH } from "./paths.js";
import { runGit } from "./git.js";
import { checkpointObjectStore, getCheckpointAssetClient } from "./assets.js";
import { assertDirectoryEmpty } from "../git.js";

type AssetManifest = {
  version: number;
  assets?: Array<{ path: string; objectKey: string; size?: number; sha256?: string; mimeType?: string | null }>;
};

type RepoBundle = { objectKey: string; sha256: string; size: number };

type UserGitReposManifest = {
  version: number;
  repos?: Array<{
    path: string;
    head: string | null;
    branch: string | null;
    /** v1: one full bundle. */
    bundle?: RepoBundle | null;
    /** v2: bundle chain plus the refs at save time. */
    bundles?: RepoBundle[];
    refs?: Record<string, string>;
  }>;
};

function assertSafeRelativePath(path: string) {
  if (path === ".") return path;
  if (!path || path.includes("\0") || isAbsolute(path) || path === ".." || path.startsWith("../") || path.includes("/../")) {
    throw new Error(`unsafe checkpoint path: ${path}`);
  }
  return path;
}

function safeJoin(root: string, path: string) {
  const safePath = assertSafeRelativePath(path);
  const target = resolve(root, safePath);
  const rel = relative(resolve(root), target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path escapes root: ${path}`);
  return target;
}

const isSafeSymlinkTarget = (target: string) => {
  if (isAbsolute(target)) return false;
  const normalized = normalize(target).replace(/\\/g, "/");
  return normalized !== ".." && !normalized.startsWith("../");
};

async function downloadObjectToFile(objectKey: string, targetPath: string) {
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o775 });
  const result = await getCheckpointAssetClient().send(new GetObjectCommand({ Bucket: config.checkpointAssetOssBucket, Key: objectKey }));
  if (!result.Body) throw new Error(`empty object body: ${objectKey}`);
  await pipeline(result.Body as NodeJS.ReadableStream, createWriteStream(targetPath));
}

async function collectArchiveEntries(root: string, dir = root): Promise<{ dirs: string[]; files: string[] }> {
  const names = await readdir(dir).catch(() => []);
  const entries = await Promise.all(names.map(async (name) => {
    const absPath = join(dir, name);
    const rel = relative(root, absPath);
    const st = await lstat(absPath).catch(() => null);
    if (!st) return { dirs: [], files: [] };
    if (st.isDirectory() && !st.isSymbolicLink()) {
      const nested = await collectArchiveEntries(root, absPath);
      return { dirs: [rel, ...nested.dirs], files: nested.files };
    }
    return { dirs: [], files: [rel] };
  }));
  return {
    dirs: entries.flatMap((entry) => entry.dirs),
    files: entries.flatMap((entry) => entry.files),
  };
}

async function copyEntry(source: string, target: string) {
  const st = await lstat(source);
  await mkdir(dirname(target), { recursive: true, mode: 0o775 });
  await rm(target, { recursive: true, force: true });
  if (st.isSymbolicLink()) {
    const link = await readlink(source);
    if (!isSafeSymlinkTarget(link)) throw new Error(`unsafe symlink target while restoring ${source}`);
    await symlink(link, target);
    return;
  }
  if (st.isDirectory()) {
    await mkdir(target, { recursive: true, mode: 0o775 });
    return;
  }
  await copyFile(source, target, constants.COPYFILE_FICLONE).catch(async () => copyFile(source, target));
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (!raw) return fallback;
  return JSON.parse(raw) as T;
}

async function archiveCommit(input: { repoDir: string; commitHash: string; restoreTmpDir: string }) {
  await rm(input.restoreTmpDir, { recursive: true, force: true });
  await mkdir(input.restoreTmpDir, { recursive: true, mode: 0o775 });
  await new Promise<void>((resolve, reject) => {
    const archive = spawn("git", ["-c", `safe.directory=${input.repoDir}`, "archive", "--format=tar", input.commitHash], { cwd: input.repoDir, stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("tar", ["-xf", "-", "-C", input.restoreTmpDir], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    archive.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    tar.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    archive.stdout.pipe(tar.stdin);
    archive.on("error", reject);
    tar.on("error", reject);
    archive.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr || `git archive exited with ${code}`));
    });
    tar.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `tar exited with ${code}`)));
  });
}

async function restoreFilesFromArchive(input: { restoreTmpDir: string; targetDir: string; assetManifest: AssetManifest }) {
  await assertDirectoryEmpty(input.targetDir);
  const assets = new Map((input.assetManifest.assets ?? []).map((asset) => [assertSafeRelativePath(asset.path), asset]));
  const entries = await collectArchiveEntries(input.restoreTmpDir);
  await Promise.all(entries.dirs.map(async (rel) => {
    const safeRel = assertSafeRelativePath(rel);
    if (safeRel === ".cohub" || safeRel === ".cohub/system" || safeRel.startsWith(".cohub/system/")) return;
    await mkdir(safeJoin(input.targetDir, safeRel), { recursive: true, mode: 0o775 });
  }));
  await Promise.all(entries.files.map(async (rel) => {
    const safeRel = assertSafeRelativePath(rel);
    if (safeRel === ".cohub" || safeRel === ".cohub/system" || safeRel.startsWith(".cohub/system/")) return;
    const asset = assets.get(safeRel);
    const target = safeJoin(input.targetDir, safeRel);
    if (asset) {
      await downloadObjectToFile(asset.objectKey, target);
      return;
    }
    await copyEntry(safeJoin(input.restoreTmpDir, safeRel), target);
  }));
}

const SAFE_BRANCH_REGEX = /^[a-zA-Z0-9._/-]+$/;

function restoreBranchName(value: string | null) {
  const branch = value?.trim();
  if (!branch || branch === "HEAD" || branch.startsWith("-") || branch.includes("..") || !SAFE_BRANCH_REGEX.test(branch)) return "restored";
  return branch;
}

const SAFE_REF_REGEX = /^refs\/(heads|tags)\/[a-zA-Z0-9._/-]+$/;
const OID_REGEX = /^[0-9a-f]{40}$/;

async function restoreBundleChain(input: { repoDir: string; bundleDir: string; bundles: RepoBundle[]; refs: Record<string, string> }) {
  for (const bundle of input.bundles) {
    const bundlePath = join(input.bundleDir, `${bundle.sha256}.bundle`);
    await downloadObjectToFile(bundle.objectKey, bundlePath);
    await runGit(["bundle", "unbundle", bundlePath], input.repoDir);
    await rm(bundlePath, { force: true });
  }
  for (const [ref, oid] of Object.entries(input.refs)) {
    if (!SAFE_REF_REGEX.test(ref) || ref.includes("..") || !OID_REGEX.test(oid)) continue;
    const target = ref.startsWith("refs/heads/") ? `refs/remotes/restore/${ref.slice("refs/heads/".length)}` : ref;
    await runGit(["update-ref", target, oid], input.repoDir).catch(() => undefined);
  }
}

async function restoreUserGitRepos(input: { workspaceDir: string; restoreTmpDir: string; manifest: UserGitReposManifest }) {
  const bundleDir = join(input.restoreTmpDir, ".cohub-restore-bundles");
  await mkdir(bundleDir, { recursive: true, mode: 0o775 });
  for (const repo of input.manifest.repos ?? []) {
    const chain = repo.bundles ?? [];
    if ((!repo.bundle && chain.length === 0) || !repo.head) continue;
    const repoPath = repo.path === "." ? "." : assertSafeRelativePath(repo.path);
    const repoDir = repoPath === "." ? input.workspaceDir : safeJoin(input.workspaceDir, repoPath);
    await mkdir(repoDir, { recursive: true, mode: 0o775 });
    const branch = restoreBranchName(repo.branch);
    await runGit(["init"], repoDir);
    if (chain.length > 0) {
      await restoreBundleChain({ repoDir, bundleDir, bundles: chain, refs: repo.refs ?? {} });
    } else if (repo.bundle) {
      const bundlePath = join(bundleDir, `${repo.bundle.sha256}.bundle`);
      await downloadObjectToFile(repo.bundle.objectKey, bundlePath);
      await runGit(["fetch", bundlePath, "refs/heads/*:refs/remotes/restore/*", "refs/tags/*:refs/tags/*"], repoDir);
    }
    await runGit(["update-ref", `refs/heads/${branch}`, repo.head], repoDir);
    await runGit(["symbolic-ref", "HEAD", `refs/heads/${branch}`], repoDir);
    await runGit(["reset", "--mixed", repo.head], repoDir);
  }
}

/**
 * Make `commitHash` readable in a space's cache repository: from its storage
 * manifest when there is one, otherwise from the legacy source repository.
 */
export async function prepareCheckpointRepo(input: { sourceSpaceId: string; targetRepoDir: string; commitHash: string }) {
  await initCheckpointRepo(input.targetRepoDir);
  await ensureCheckpointCommits(checkpointObjectStore, input.targetRepoDir, [input.commitHash]).catch(async (error) => {
    if (!(error instanceof CheckpointObjectsUnavailableError)) throw error;
    const sourceRepoDir = getCheckpointSystemRepoDir(input.sourceSpaceId);
    await runCheckpointGit(["fetch", "-q", "--no-tags", sourceRepoDir, input.commitHash], { cwd: input.targetRepoDir });
    await markCheckpointCommitComplete(input.targetRepoDir, input.commitHash);
  });
  await runCheckpointGit(["update-ref", "refs/heads/main", input.commitHash], { cwd: input.targetRepoDir, env: { GIT_DIR: checkpointGitDir(input.targetRepoDir) } });
}

async function readCommitJson<T>(restoreTmpDir: string, paths: string[], fallback: T): Promise<T> {
  for (const path of paths) {
    const value = await readJson<T | null>(join(restoreTmpDir, path), null);
    if (value) return value;
  }
  return fallback;
}

export async function restoreWorkspaceFromCheckpoint(input: {
  checkpointId: string;
  targetWorkspaceDir: string;
  targetRepoDir: string;
  restoreTmpDir: string;
}) {
  const [checkpoint] = await db.select().from(checkpoints).where(eq(checkpoints.id, input.checkpointId)).limit(1);
  if (!checkpoint) throw new Error("checkpoint not found");
  const [sourceSpace] = await db.select().from(spaces).where(eq(spaces.id, checkpoint.spaceId)).limit(1);
  if (!sourceSpace) throw new Error("checkpoint source space not found");
  await prepareCheckpointRepo({ sourceSpaceId: sourceSpace.id, targetRepoDir: input.targetRepoDir, commitHash: checkpoint.commitHash });
  await archiveCommit({ repoDir: input.targetRepoDir, commitHash: checkpoint.commitHash, restoreTmpDir: input.restoreTmpDir });
  const assetManifest = await readJson<AssetManifest>(join(input.restoreTmpDir, CHECKPOINT_ASSET_MANIFEST_PATH), { version: 1, assets: [] });
  const gitReposManifest = await readCommitJson<UserGitReposManifest>(input.restoreTmpDir, [USER_GIT_REPOS_PATH, LEGACY_USER_GIT_REPOS_PATH], { version: 1, repos: [] });
  await restoreFilesFromArchive({ restoreTmpDir: input.restoreTmpDir, targetDir: input.targetWorkspaceDir, assetManifest });
  await restoreUserGitRepos({ workspaceDir: input.targetWorkspaceDir, restoreTmpDir: input.restoreTmpDir, manifest: gitReposManifest });
  return { checkpoint, sourceSpace, assetManifest, gitReposManifest };
}
