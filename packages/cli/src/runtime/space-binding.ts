import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const CONFIG_DIR_NAME = ".config";
const CONFIG_FILE_NAME = "runtime-spaces.json";
const LOCK_STALE_MS = 5 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 60 * 1000;
const LOCK_RETRY_MS = 100;
const LOCK_ATTEMPTS = 600;
const GLOBAL_LOCK_SUFFIX = ".lock";

export type RuntimeSpaceBinding = {
  /** Canonical local workspace root. */
  root: string;
  /** Environment + authenticated actor identity. */
  key: string;
  spaceId: string;
};

export type RuntimeSpaceBindingsFile = {
  version: 1;
  bindings: RuntimeSpaceBinding[];
};

export type RuntimeSpaceBindingResolution = {
  spaceId: string;
  source: "binding" | "created" | "explicit";
};

export class RuntimeSpaceBindingsError extends Error {
  override name = "RuntimeSpaceBindingsError";
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export function runtimeSpaceBindingsPath(): string {
  return join(homedir(), CONFIG_DIR_NAME, "cohub", CONFIG_FILE_NAME);
}

export function normalizeRuntimeRoot(root: string): string {
  return resolve(root);
}

export async function canonicalRuntimeRoot(root: string): Promise<string> {
  return realpath(normalizeRuntimeRoot(root));
}

function invalidBindings(path: string, detail?: string): RuntimeSpaceBindingsError {
  return new RuntimeSpaceBindingsError(
    `Runtime Space bindings are invalid${detail ? ` (${detail})` : ""}: ${path}`,
  );
}

export function parseRuntimeSpaceBindings(raw: string, path = CONFIG_FILE_NAME): RuntimeSpaceBindingsFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidBindings(path, "invalid JSON");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidBindings(path);
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.bindings)) {
    throw invalidBindings(path, "unsupported format");
  }

  const seen = new Set<string>();
  const bindings: RuntimeSpaceBinding[] = [];
  for (const item of record.bindings) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw invalidBindings(path, "invalid binding");
    }
    const binding = item as Record<string, unknown>;
    if (!nonEmptyString(binding.root) || !isAbsolute(binding.root)) {
      throw invalidBindings(path, "binding root must be absolute");
    }
    if (!nonEmptyString(binding.key) || !nonEmptyString(binding.spaceId)) {
      throw invalidBindings(path, "binding identity is incomplete");
    }
    const root = normalizeRuntimeRoot(binding.root);
    const key = binding.key.trim();
    const spaceId = binding.spaceId.trim();
    const identity = `${key}\u0000${root}`;
    if (seen.has(identity)) throw invalidBindings(path, "duplicate binding");
    seen.add(identity);
    bindings.push({ root, key, spaceId });
  }

  return { version: 1, bindings };
}

export async function readRuntimeSpaceBindings(
  path = runtimeSpaceBindingsPath(),
): Promise<RuntimeSpaceBindingsFile> {
  try {
    return parseRuntimeSpaceBindings(await readFile(path, "utf8"), path);
  } catch (error) {
    if (missing(error)) return { version: 1, bindings: [] };
    throw error;
  }
}

export function findRuntimeSpaceBinding(
  bindings: RuntimeSpaceBinding[] | RuntimeSpaceBindingsFile,
  input: { root: string; key: string },
): RuntimeSpaceBinding | null {
  const entries = Array.isArray(bindings) ? bindings : bindings.bindings;
  const root = normalizeRuntimeRoot(input.root);
  const key = input.key.trim();
  return entries.find((binding) => binding.root === root && binding.key === key) ?? null;
}

function upsertRuntimeSpaceBinding(
  file: RuntimeSpaceBindingsFile,
  binding: RuntimeSpaceBinding,
): { file: RuntimeSpaceBindingsFile; changed: boolean } {
  const root = normalizeRuntimeRoot(binding.root);
  const key = binding.key.trim();
  const spaceId = binding.spaceId.trim();
  const nextBinding = { root, key, spaceId };
  const index = file.bindings.findIndex((item) => item.root === root && item.key === key);
  if (index < 0) {
    return { file: { version: 1, bindings: [...file.bindings, nextBinding] }, changed: true };
  }

  const current = file.bindings[index];
  if (current?.root === root && current.key === key && current.spaceId === spaceId) {
    return { file, changed: false };
  }
  const bindings = [...file.bindings];
  bindings[index] = nextBinding;
  return { file: { version: 1, bindings }, changed: true };
}

async function writeRuntimeJson(path: string, file: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const output = await open(temporary, "wx", 0o600);
    try {
      await output.writeFile(`${JSON.stringify(file, null, 2)}\n`, "utf8");
      await output.sync();
    } finally {
      await output.close();
    }
    await rename(temporary, path);
    await chmod(path, 0o600);
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

const statIfPresent = async (path: string): Promise<{ mtimeMs: number } | null> =>
  stat(path, { bigint: false }).catch((error) => {
    if (missing(error)) return null;
    throw error;
  });

type LockSnapshot = { owner: string; mtimeMs: number };

async function lockSnapshot(lockPath: string): Promise<LockSnapshot | null> {
  let names: string[];
  try {
    names = await readdir(lockPath);
  } catch (error) {
    // A malformed non-directory lock is not safe to reclaim automatically.
    if (missing(error) || (error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw error;
  }
  if (names.length !== 1 || !names[0]) return null;
  const owner = names[0];
  const info = await statIfPresent(join(lockPath, owner));
  return info ? { owner, mtimeMs: info.mtimeMs } : null;
}

async function reclaimStaleLock(lockPath: string, snapshot: LockSnapshot): Promise<boolean> {
  const ownerPath = join(lockPath, snapshot.owner);
  const current = await statIfPresent(ownerPath);
  if (!current || Date.now() - current.mtimeMs <= LOCK_STALE_MS) return false;

  // Remove only the owner observed during the stale check. If another process
  // replaced the lock, its owner token is different and rmdir stays harmless.
  await rm(ownerPath, { force: true });
  try {
    await rmdir(lockPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return false;
    throw error;
  }
}

async function acquireLock(lockPath: string): Promise<string> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const owner = randomUUID();
      try {
        // The owner token is the filename. Removing this exact file before
        // rmdir makes an old process unable to remove a replacement lock.
        await writeFile(join(lockPath, owner), "", { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (error) {
        await rm(join(lockPath, owner), { force: true });
        await rmdir(lockPath).catch((cleanupError) => {
          const code = (cleanupError as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw cleanupError;
        });
        throw error;
      }
      return owner;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const snapshot = await lockSnapshot(lockPath);
      if (snapshot && Date.now() - snapshot.mtimeMs > LOCK_STALE_MS) {
        await reclaimStaleLock(lockPath, snapshot);
        continue;
      }
      await delay(LOCK_RETRY_MS);
    }
  }
  throw new RuntimeSpaceBindingsError("Timed out waiting for the Runtime Space bindings lock");
}

async function releaseLock(lockPath: string, owner: string): Promise<void> {
  await rm(join(lockPath, owner), { force: true });
  await rmdir(lockPath).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
  });
}

async function refreshLock(lockPath: string, owner: string): Promise<void> {
  const ownerPath = join(lockPath, owner);
  const current = await stat(ownerPath).catch((error) => {
    if (missing(error)) return null;
    throw error;
  });
  if (!current) return;
  const now = new Date();
  await utimes(ownerPath, now, now);
}

export async function withRuntimeSpaceBindingsLock<T>(
  fn: () => Promise<T>,
  options: { path?: string; lockPath?: string } = {},
): Promise<T> {
  const path = options.path ?? runtimeSpaceBindingsPath();
  const lockPath = options.lockPath ?? `${path}${GLOBAL_LOCK_SUFFIX}`;
  const owner = await acquireLock(lockPath);
  const heartbeat = setInterval(() => {
    void refreshLock(lockPath, owner).catch(() => undefined);
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await releaseLock(lockPath, owner);
  }
}

function bindingLockPath(path: string, root: string, key: string): string {
  const digest = createHash("sha256").update(`${key}\u0000${root}`).digest("hex");
  return `${path}.${digest}.lock`;
}

async function persistRuntimeSpaceBinding(path: string, binding: RuntimeSpaceBinding): Promise<void> {
  await withRuntimeSpaceBindingsLock(async () => {
    const file = await readRuntimeSpaceBindings(path);
    const result = upsertRuntimeSpaceBinding(file, binding);
    if (result.changed) await writeRuntimeJson(path, result.file);
  }, { path, lockPath: `${path}${GLOBAL_LOCK_SUFFIX}` });
}

export async function getRuntimeSpaceBinding(
  root: string,
  key: string | null | undefined,
  path = runtimeSpaceBindingsPath(),
): Promise<RuntimeSpaceBinding | null> {
  if (!nonEmptyString(key)) return null;
  const canonicalRoot = await canonicalRuntimeRoot(root);
  const file = await readRuntimeSpaceBindings(path);
  return findRuntimeSpaceBinding(file, { root: canonicalRoot, key: key.trim() });
}

/**
 * Resolve a local Runtime Space without silently creating duplicates.
 * The per-binding lock covers creation; the shared file is locked only for
 * short read-modify-write commits.
 */
export async function resolveRuntimeSpace(input: {
  root: string;
  identityKey: string | null | undefined;
  explicitSpaceId?: string | null;
  /** Explicit new selection; compare the binding observed before prompting. */
  newSpace?: boolean;
  expectedSpaceId?: string | null;
  createSpace: () => Promise<string>;
  validateSpace?: (spaceId: string) => Promise<void>;
  path?: string;
}): Promise<RuntimeSpaceBindingResolution> {
  const root = await canonicalRuntimeRoot(input.root);
  const explicitSpaceId = input.explicitSpaceId?.trim() || null;
  const identityKey = input.identityKey?.trim() || null;
  const path = input.path ?? runtimeSpaceBindingsPath();

  // An explicit target remains usable even in an environment where there is no
  // decodable identity to scope a persisted local binding to.
  if (!identityKey) {
    if (explicitSpaceId) {
      await input.validateSpace?.(explicitSpaceId);
      return { spaceId: explicitSpaceId, source: "explicit" };
    }
    throw new RuntimeSpaceBindingsError(
      "Cannot remember a local Runtime Space without an authenticated identity",
    );
  }
  const bindingKey = identityKey;
  const lockPath = bindingLockPath(path, root, bindingKey);

  return withRuntimeSpaceBindingsLock(async () => {
    const file = await readRuntimeSpaceBindings(path);
    const receiptPath = `${lockPath}.creation.json`;
    if (explicitSpaceId) {
      await input.validateSpace?.(explicitSpaceId);
      await persistRuntimeSpaceBinding(path, { root, key: bindingKey, spaceId: explicitSpaceId });
      // Preserve an ambiguous creation receipt for diagnosis, rather than deleting it.
      if (await statIfPresent(receiptPath)) await rename(receiptPath, `${receiptPath}.${randomUUID()}.resolved`);
      return { spaceId: explicitSpaceId, source: "explicit" };
    }

    const existing = findRuntimeSpaceBinding(file, { root, key: bindingKey });
    if (input.newSpace && (existing?.spaceId ?? null) !== (input.expectedSpaceId ?? null)) {
      throw new RuntimeSpaceBindingsError("Directory binding changed; run up again");
    }
    if (existing && !input.newSpace) {
      await input.validateSpace?.(existing.spaceId);
      return { spaceId: existing.spaceId, source: "binding" };
    }

    // Fail closed across the remote-create/local-commit crash window. A saved ID
    // resumes binding; an ambiguous request must be resolved with --space, never replayed.
    let receipt: { operationId: string; spaceId?: string } | null = null;
    try {
      receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      if (!receipt || !nonEmptyString(receipt.operationId) || receipt.spaceId !== undefined && !nonEmptyString(receipt.spaceId)) {
        throw new RuntimeSpaceBindingsError(`Invalid creation receipt; original retained: ${receiptPath}`);
      }
    } catch (error) { if (!missing(error)) throw error; }
    if (receipt && !receipt.spaceId) throw new RuntimeSpaceBindingsError(
      `A previous Space creation has an unknown outcome. Check your Spaces and use --space <id>. ${receiptPath}`,
    );
    if (!receipt) {
      receipt = { operationId: randomUUID() };
      await writeRuntimeJson(receiptPath, receipt);
    }
    let createdSpaceId = receipt.spaceId;
    if (!createdSpaceId) {
      try { createdSpaceId = await input.createSpace(); }
      catch (error) {
        const status = (error as { status?: number })?.status;
        if (status && status >= 400 && status < 500 && status !== 408) await rm(receiptPath);
        throw error;
      }
      await writeRuntimeJson(receiptPath, { ...receipt, spaceId: createdSpaceId });
    }
    if (!nonEmptyString(createdSpaceId)) {
      throw new RuntimeSpaceBindingsError("Local Runtime Space creation returned no Space ID");
    }
    const spaceId = createdSpaceId.trim();
    await input.validateSpace?.(spaceId);
    await persistRuntimeSpaceBinding(path, { root, key: bindingKey, spaceId });
    await rm(receiptPath);
    return { spaceId, source: "created" };
  }, { path, lockPath });
}
