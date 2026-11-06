/**
 * Checkpoint object storage.
 *
 * Object storage is the source of truth for checkpoint history. Every save
 * uploads one immutable pack holding the objects it introduced, and one
 * immutable manifest per commit listing every pack needed to read it. A
 * space's repository under SPACE_SYSTEM_ROOT is only a cache of those packs.
 *
 * Invariant: the packs in `manifest(c).packs` together contain every object
 * reachable from commit `c`.
 */
import { spawn } from "node:child_process";
import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CHECKPOINT_COVER_FANOUT = 16;
export const CHECKPOINT_COVER_MAX_LEVEL = 4;

export type CheckpointPackRef = {
  checksum: string;
  packKey: string;
  idxKey: string;
  size: number;
  idxSize: number;
  /** Save sequence range the pack holds; 0..0 marks a baseline pack with a full closure. */
  first: number;
  last: number;
  /** Commit at `last`. */
  tip: string;
};

export type CheckpointStorageManifest = {
  version: 1;
  commit: string;
  parent: string | null;
  seq: number;
  packs: CheckpointPackRef[];
};

export type CheckpointCoverRecord = {
  version: 1;
  level: number;
  pack: CheckpointPackRef;
};

export type CheckpointObjectReader = {
  /** Resolve false when the key does not exist. */
  download(key: string, filePath: string): Promise<boolean>;
  /** Resolve null when the key does not exist. */
  readText(key: string): Promise<string | null>;
};

const OID = /^[0-9a-f]{40}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9-]+$/;

export const isCommitOid = (value: unknown): value is string => typeof value === "string" && OID.test(value);

const assertOid = (value: string) => {
  if (!OID.test(value)) throw new Error(`invalid object id: ${value}`);
  return value;
};

const assertSegment = (value: string) => {
  if (!SAFE_SEGMENT.test(value)) throw new Error(`invalid storage key segment: ${value}`);
  return value;
};

export const checkpointManifestKey = (commit: string) => `checkpoint-manifests/${assertOid(commit)}.json`;
export const checkpointPackKey = (spaceId: string, checksum: string, ext: "pack" | "idx") =>
  `checkpoint-packs/${assertSegment(spaceId)}/pack-${assertOid(checksum)}.${ext}`;
export const checkpointCoverKey = (tip: string, level: number) => `checkpoint-covers/${assertOid(tip)}/L${level}.json`;

const isNonNegativeInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

export function parsePackRef(value: unknown): CheckpointPackRef | null {
  if (!value || typeof value !== "object") return null;
  const ref = value as Record<string, unknown>;
  if (!isCommitOid(ref.checksum) || !isCommitOid(ref.tip)) return null;
  if (typeof ref.packKey !== "string" || typeof ref.idxKey !== "string") return null;
  if (!isNonNegativeInt(ref.size) || !isNonNegativeInt(ref.idxSize) || !isNonNegativeInt(ref.first) || !isNonNegativeInt(ref.last)) return null;
  if (ref.first > ref.last) return null;
  return { checksum: ref.checksum, packKey: ref.packKey, idxKey: ref.idxKey, size: ref.size, idxSize: ref.idxSize, first: ref.first, last: ref.last, tip: ref.tip };
}

export function parseCheckpointManifest(raw: string): CheckpointStorageManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== 1 || !isCommitOid(manifest.commit) || !isNonNegativeInt(manifest.seq)) return null;
  if (manifest.parent !== null && !isCommitOid(manifest.parent)) return null;
  if (!Array.isArray(manifest.packs) || manifest.packs.length === 0) return null;
  const packs = manifest.packs.map(parsePackRef);
  if (packs.some((pack) => !pack)) return null;
  return { version: 1, commit: manifest.commit, parent: manifest.parent as string | null, seq: manifest.seq, packs: packs as CheckpointPackRef[] };
}

export function parseCoverRecord(raw: string): CheckpointCoverRecord | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const pack = parsePackRef(value?.pack);
    if (value?.version !== 1 || !isNonNegativeInt(value.level) || !pack) return null;
    return { version: 1, level: value.level, pack };
  } catch {
    return null;
  }
}

export async function readCheckpointManifest(store: CheckpointObjectReader, commit: string) {
  const raw = await store.readText(checkpointManifestKey(commit));
  if (raw === null) return null;
  const manifest = parseCheckpointManifest(raw);
  if (!manifest || manifest.commit !== commit) throw new Error(`invalid checkpoint manifest for ${commit}`);
  return manifest;
}

export type GitResult = { stdout: string; stderr: string };

export function runCheckpointGit(args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; input?: string | Buffer }) {
  return new Promise<GitResult>((resolve, reject) => {
    const child = spawn("git", ["-c", `safe.directory=*`, ...args], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8192) stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr });
      else reject(new Error(stderr.trim() || `git ${args[0]} exited with ${code}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}

export const checkpointGitDir = (repoDir: string) => join(repoDir, ".git");
export const checkpointPackDir = (repoDir: string) => join(repoDir, ".git", "objects", "pack");

const objectsExist = (repoDir: string) => stat(join(repoDir, ".git", "objects")).then(() => true, () => false);
const autoGcDisabled = (repoDir: string) =>
  runCheckpointGit(["config", "--get", "gc.auto"], { cwd: repoDir }).then((result) => result.stdout.trim() === "0", () => false);

/** Idempotent and safe to race: the API and workers may prepare the same cache concurrently. */
export async function initCheckpointRepo(repoDir: string) {
  await mkdir(repoDir, { recursive: true, mode: 0o775 });
  if (!await objectsExist(repoDir)) {
    await runCheckpointGit(["init", "-q", "-b", "main"], { cwd: repoDir }).catch(async (error) => {
      if (!await objectsExist(repoDir)) throw error;
    });
  }
  // Packs are managed by checkpoint storage; git must never repack or prune the cache on its own.
  if (!await autoGcDisabled(repoDir)) {
    await runCheckpointGit(["config", "gc.auto", "0"], { cwd: repoDir }).catch(async (error) => {
      if (!await autoGcDisabled(repoDir)) throw error;
    });
  }
  await mkdir(checkpointPackDir(repoDir), { recursive: true, mode: 0o775 });
}

export async function hasCommit(repoDir: string, commit: string) {
  assertOid(commit);
  return runCheckpointGit(["cat-file", "-e", `${commit}^{commit}`], { cwd: repoDir }).then(() => true, () => false);
}

export const isPackInstalled = (repoDir: string, checksum: string) =>
  stat(join(checkpointPackDir(repoDir), `pack-${assertOid(checksum)}.idx`)).then(() => true, () => false);

async function readTail(path: string, offsetFromEnd: number, length: number) {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - offsetFromEnd);
    return buffer.toString("hex");
  } finally {
    await handle.close();
  }
}

async function fsyncFile(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The pack trailer and the checksum recorded in its .idx must both match. */
export async function verifyPackFiles(packPath: string, idxPath: string, checksum: string) {
  const [packTrailer, idxPackChecksum] = await Promise.all([readTail(packPath, 20, 20), readTail(idxPath, 40, 20)]);
  if (packTrailer !== checksum || idxPackChecksum !== checksum) throw new Error(`pack ${checksum} failed checksum verification`);
}

/**
 * Install pack files into a cache repository. The .idx is renamed last so git
 * never sees a pack without a complete index.
 */
export async function installPackFiles(repoDir: string, checksum: string, files: { packPath: string; idxPath: string }) {
  const packDir = checkpointPackDir(repoDir);
  await mkdir(packDir, { recursive: true, mode: 0o775 });
  await verifyPackFiles(files.packPath, files.idxPath, checksum);
  await Promise.all([fsyncFile(files.packPath), fsyncFile(files.idxPath)]);
  await rename(files.packPath, join(packDir, `pack-${checksum}.pack`));
  await rename(files.idxPath, join(packDir, `pack-${checksum}.idx`));
}

export async function downloadPack(store: CheckpointObjectReader, repoDir: string, pack: CheckpointPackRef) {
  if (await isPackInstalled(repoDir, pack.checksum)) return false;
  const packDir = checkpointPackDir(repoDir);
  await mkdir(packDir, { recursive: true, mode: 0o775 });
  const token = crypto.randomUUID();
  const packPath = join(packDir, `tmp_cohub_${token}.pack`);
  const idxPath = join(packDir, `tmp_cohub_${token}.idx`);
  try {
    if (!await store.download(pack.packKey, packPath)) throw new Error(`checkpoint pack missing: ${pack.packKey}`);
    if (!await store.download(pack.idxKey, idxPath)) throw new Error(`checkpoint pack index missing: ${pack.idxKey}`);
    const [packStat, idxStat] = await Promise.all([stat(packPath), stat(idxPath)]);
    if (packStat.size !== pack.size || idxStat.size !== pack.idxSize) throw new Error(`checkpoint pack size mismatch: ${pack.packKey}`);
    await installPackFiles(repoDir, pack.checksum, { packPath, idxPath });
    return true;
  } finally {
    await Promise.all([rm(packPath, { force: true }), rm(idxPath, { force: true })]);
  }
}

export async function installPacks(store: CheckpointObjectReader, repoDir: string, packs: CheckpointPackRef[], concurrency = 4) {
  let installed = 0;
  const queue = [...packs];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let pack = queue.shift(); pack; pack = queue.shift()) {
      if (await downloadPack(store, repoDir, pack)) installed += 1;
    }
  }));
  return installed;
}

export class CheckpointObjectsUnavailableError extends Error {
  constructor(readonly commit: string) {
    super(`checkpoint objects unavailable for commit ${commit}`);
    this.name = "CheckpointObjectsUnavailableError";
  }
}

const completeMarker = (repoDir: string, commit: string) => join(repoDir, ".git", "cohub-complete", assertOid(commit));

/** Record that every object reachable from `commit` is installed in the cache repository. */
export async function markCheckpointCommitComplete(repoDir: string, commit: string) {
  const marker = completeMarker(repoDir, commit);
  await mkdir(join(repoDir, ".git", "cohub-complete"), { recursive: true, mode: 0o775 });
  await writeFile(marker, "");
}

/**
 * Make every object reachable from `commits` readable in the cache
 * repository. A commit without a manifest is a legacy commit and must already
 * be present locally.
 */
export async function ensureCheckpointCommits(store: CheckpointObjectReader, repoDir: string, commits: string[]) {
  let installed = 0;
  for (const commit of new Set(commits)) {
    if (await stat(completeMarker(repoDir, commit)).then(() => true, () => false)) continue;
    // A legacy commit already in the cache stays readable while object storage is unreachable.
    const manifest = await readCheckpointManifest(store, commit).catch(async (error) => {
      if (await hasCommit(repoDir, commit)) return null;
      throw error;
    });
    if (!manifest) {
      if (await hasCommit(repoDir, commit)) continue;
      throw new CheckpointObjectsUnavailableError(commit);
    }
    await initCheckpointRepo(repoDir);
    installed += await installPacks(store, repoDir, manifest.packs);
    if (!await hasCommit(repoDir, commit)) throw new CheckpointObjectsUnavailableError(commit);
    await markCheckpointCommitComplete(repoDir, commit);
  }
  return { installed };
}
