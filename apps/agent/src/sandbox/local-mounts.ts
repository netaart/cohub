import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpaceModListItem } from "@cohub/core/space-mods";
import type { RpcMethod, RpcRequestMap, SandboxCapabilities } from "@cohub/protocol/sandbox";
import { logger } from "../logger.js";
import {
  getAgentModSnapshotPath,
  getAgentPlatformAgentsPath,
  getAgentUserAgentsPath,
  SANDBOX_PLATFORM_AGENTS_PATH,
  SANDBOX_USER_AGENTS_PATH,
} from "../runtime/paths.js";

// A Local Runtime gets no Pod mounts, so the agent mirrors the same read-only
// directories from its own copy into the Runtime's cache (mounts.sync/write).
const MAX_MOUNT_BYTES = 64 * 1024 * 1024;
const MAX_MOUNT_FILES = 5_000;
const BATCH_BYTES = 8 * 1024 * 1024;
const SCAN_TTL_MS = 15_000;

export type LocalMountSource = { path: string; dir: string };

type SourceFile = { path: string; absolute: string; size: number; mtimeMs: number; executable: boolean };
export type RpcCall = <M extends RpcMethod>(method: M, params: RpcRequestMap[M]["params"]) => Promise<RpcRequestMap[M]["result"]>;
type ScannedSource = LocalMountSource & { revision: string; files: SourceFile[]; bytes: number };

const scanCache = new Map<string, { expiresAt: number; scan: Promise<Omit<ScannedSource, keyof LocalMountSource>> }>();

/** The cloud sandbox Pod's read-only mounts: platform and owner skills, and the latest snapshot of each enabled Mod. */
export function localMountSources(input: { ownerUserId: string | null; mods: SpaceModListItem[] }): LocalMountSource[] {
  return [
    { path: SANDBOX_PLATFORM_AGENTS_PATH, dir: getAgentPlatformAgentsPath() },
    ...(input.ownerUserId ? [{ path: SANDBOX_USER_AGENTS_PATH, dir: getAgentUserAgentsPath(input.ownerUserId) }] : []),
    ...input.mods.map((mod) => ({ path: mod.mountPath, dir: getAgentModSnapshotPath(mod.modSpaceId) })),
  ];
}

// Symlinks are skipped: following one could copy agent files from outside the source directory.
async function listFiles(root: string, dir = ""): Promise<SourceFile[]> {
  let names: string[];
  try {
    names = await readdir(join(root, dir));
  } catch {
    return [];
  }
  const groups = await Promise.all(names.sort().map(async (name): Promise<SourceFile[]> => {
    if (name === ".git" || /[\\:]/.test(name)) return [];
    const path = dir ? `${dir}/${name}` : name;
    const absolute = join(root, path);
    const info = await lstat(absolute).catch(() => null);
    if (info?.isDirectory()) return listFiles(root, path);
    if (!info?.isFile()) return [];
    return [{ path, absolute, size: info.size, mtimeMs: info.mtimeMs, executable: (info.mode & 0o111) !== 0 }];
  }));
  return groups.flat();
}

function scanSource(dir: string) {
  const now = Date.now();
  const cached = scanCache.get(dir);
  if (cached && cached.expiresAt > now) return cached.scan;
  const scan = listFiles(dir).then((files) => {
    const hash = createHash("sha256");
    for (const file of files) hash.update(`${file.path}\0${file.size}\0${file.mtimeMs}\0${file.executable}\n`);
    return { revision: hash.digest("hex").slice(0, 32), files, bytes: files.reduce((sum, file) => sum + file.size, 0) };
  });
  scanCache.set(dir, { expiresAt: now + SCAN_TTL_MS, scan });
  scan.catch(() => {
    if (scanCache.get(dir)?.scan === scan) scanCache.delete(dir);
  });
  return scan;
}

async function uploadMount(rpc: RpcCall, source: ScannedSource) {
  if (source.files.length > MAX_MOUNT_FILES || source.bytes > MAX_MOUNT_BYTES) {
    throw new Error(`mount exceeds ${MAX_MOUNT_FILES} files or ${MAX_MOUNT_BYTES} bytes`);
  }
  const uploadId = randomUUID();
  let batch: Array<{ path: string; contentBase64: string; executable?: boolean }> = [];
  let batchBytes = 0;
  const send = (final: boolean) => rpc("mounts.write", { path: source.path, revision: source.revision, uploadId, files: batch, final });
  for (const file of source.files) {
    if (batch.length > 0 && batchBytes + file.size > BATCH_BYTES) {
      await send(false);
      batch = [];
      batchBytes = 0;
    }
    batch.push({ path: file.path, contentBase64: (await readFile(file.absolute)).toString("base64"), ...(file.executable ? { executable: true } : {}) });
    batchBytes += file.size;
  }
  await send(true);
}

/**
 * Bring the Runtime's mounts to the current sources and return each mount's host path,
 * or null when this Runtime cannot hold mounts. A mount that fails to upload keeps its
 * previous content and is retried on the next Turn.
 */
export async function syncLocalMounts(input: {
  rpc: RpcCall;
  capabilities: SandboxCapabilities | undefined;
  spaceId: string;
  sources: LocalMountSource[];
}): Promise<Record<string, string> | null> {
  if (!input.capabilities?.mounts) return null;
  const { rpc } = input;

  const scanned = await Promise.all(input.sources.map(async (source): Promise<ScannedSource> => ({ ...source, ...(await scanSource(source.dir)) })));
  const { mounts } = await rpc("mounts.sync", { mounts: scanned.map(({ path, revision }) => ({ path, revision })) });
  const held = new Map(mounts.map((mount) => [mount.path, mount.revision]));
  for (const source of scanned) {
    if (held.get(source.path) === source.revision) continue;
    try {
      await uploadMount(rpc, source);
    } catch (error) {
      logger.warn(`[LocalMounts] failed to sync ${source.path} spaceId=${input.spaceId}`, error);
    }
  }
  return Object.fromEntries(mounts.map((mount) => [mount.path, mount.hostPath]));
}
