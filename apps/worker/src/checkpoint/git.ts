import { stat, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "../config.js";

const STALE_GIT_LOCK_AGE_MS = 30_000;
const GIT_LOCK_RETRY_DELAY_MS = 1_000;

const redactBasicAuthUrls = (value: string) =>
  value.replace(/(https?:\/\/[^:\s/@]+:)([^@\s]+)(@)/g, "$1***$3");

const isGitIndexLockError = (message: string) => message.includes("index.lock") && message.includes("File exists");

const getGitIndexLockPath = (cwd: string) => join(cwd, ".git", "index.lock");

export const cleanStaleGitLock = async (cwd: string) => {
  const lockPath = getGitIndexLockPath(cwd);
  try {
    const lockStat = await stat(lockPath);
    const ageMs = Date.now() - lockStat.mtimeMs;
    if (ageMs < STALE_GIT_LOCK_AGE_MS) return false;

    await unlink(lockPath);
    console.warn(`[checkpoint:git] removed stale index.lock age=${Math.round(ageMs / 1000)}s cwd=${cwd}`);
    return true;
  } catch {
    return false;
  }
};

const waitForStaleGitLock = async (cwd: string) => {
  const lockPath = getGitIndexLockPath(cwd);
  try {
    const lockStat = await stat(lockPath);
    const ageMs = Date.now() - lockStat.mtimeMs;
    const waitMs = Math.max(0, STALE_GIT_LOCK_AGE_MS - ageMs) + GIT_LOCK_RETRY_DELAY_MS;
    if (waitMs > 0) await delay(waitMs);
  } catch {
    return;
  }
};

const spawnGitWithOutput = async (args: string[], cwd: string) => {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("git", ["-c", `safe.directory=${cwd}`, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(redactBasicAuthUrls(stderr.trim() || `git ${args[0]} exited with non-zero status ${code}`)));
    });
  });
};

export const runGitWithOutput = async (args: string[], cwd: string) => {
  await cleanStaleGitLock(cwd);
  try {
    return await spawnGitWithOutput(args, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isGitIndexLockError(message)) throw error;

    await waitForStaleGitLock(cwd);
    const removed = await cleanStaleGitLock(cwd);
    if (!removed) throw error;
    return spawnGitWithOutput(args, cwd);
  }
};

export const runGit = async (args: string[], cwd: string) => {
  await runGitWithOutput(args, cwd);
};

export const ensureGitRepo = async (repoDir: string, branch = "main") => {
  const hasGit = await runGit(["rev-parse", "--git-dir"], repoDir).then(() => true, () => false);
  if (!hasGit) {
    await runGit(["init", "-b", branch], repoDir).catch(async () => {
      await runGit(["init"], repoDir);
      await runGit(["checkout", "-B", branch], repoDir);
    });
  }
  await runGit(["config", "user.name", "Cohub Worker"], repoDir);
  await runGit(["config", "user.email", config.checkpointGitAuthorEmail], repoDir);
  await runGit(["checkout", "-B", branch], repoDir);
};
