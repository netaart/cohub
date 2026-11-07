import { createHash } from "node:crypto";
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
// One mount goes in one message, well under the sandbox's 50 MiB frame limit.
const MAX_MOUNT_BYTES = 16 * 1024 * 1024;
const MAX_MOUNT_FILES = 5_000;
const SCAN_TTL_MS = 15_000;

export type LocalMountSource = { path: string; dir: string };
export type RpcCall = <M extends RpcMethod>(method: M, params: RpcRequestMap[M]["params"]) => Promise<RpcRequestMap[M]["result"]>;

/** Mounts a Runtime holds at their current revision. */
export type LocalMounts = {
  hostPaths: Record<string, string>;
  revisions: Record<string, string>;
  /** Every sandbox file path the held mounts contain. */
  files: ReadonlySet<string>;
};

type SourceFile = { path: string; absolute: string; size: number; mtimeMs: number; executable: boolean };
type Scan = { revision: string; files: SourceFile[] };

const scanCache = new Map<string, { expiresAt: number; scan: Promise<Scan> }>();

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
  const names = await readdir(join(root, dir)).catch(() => [] as string[]);
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

// The sources live on PVCs shared by every agent instance, so path/size/mtime fingerprints agree across them.
function scanSource(dir: string): Promise<Scan> {
  const now = Date.now();
  const cached = scanCache.get(dir);
  if (cached && cached.expiresAt > now) return cached.scan;
  const scan = listFiles(dir).then((files) => {
    const hash = createHash("sha256");
    for (const file of files) hash.update(`${file.path}\0${file.size}\0${file.mtimeMs}\0${file.executable}\n`);
    return { revision: hash.digest("hex").slice(0, 32), files };
  });
  scanCache.set(dir, { expiresAt: now + SCAN_TTL_MS, scan });
  scan.catch(() => {
    if (scanCache.get(dir)?.scan === scan) scanCache.delete(dir);
  });
  return scan;
}

async function uploadMount(rpc: RpcCall, path: string, { revision, files }: Scan) {
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  if (files.length > MAX_MOUNT_FILES || bytes > MAX_MOUNT_BYTES) {
    throw new Error(`mount exceeds ${MAX_MOUNT_FILES} files or ${MAX_MOUNT_BYTES} bytes`);
  }
  await rpc("mounts.write", {
    path,
    revision,
    files: await Promise.all(files.map(async (file) => ({
      path: file.path,
      contentBase64: (await readFile(file.absolute)).toString("base64"),
      ...(file.executable ? { executable: true } : {}),
    }))),
  });
}

/**
 * Bring the Runtime's mounts to the current sources, or return null when this Runtime cannot
 * hold mounts. A mount that fails to upload is left out, so nothing lists its files, and is
 * retried on the next Turn.
 */
export async function syncLocalMounts(input: {
  rpc: RpcCall;
  capabilities: SandboxCapabilities | undefined;
  spaceId: string;
  sources: LocalMountSource[];
}): Promise<LocalMounts | null> {
  if (!input.capabilities?.mounts) return null;
  const scanned = await Promise.all(input.sources.map(async (source) => ({ path: source.path, scan: await scanSource(source.dir) })));
  const { mounts } = await input.rpc("mounts.sync", { mounts: scanned.map(({ path, scan }) => ({ path, revision: scan.revision })) });
  const holding = new Map(mounts.map((mount) => [mount.path, mount]));

  const hostPaths: Record<string, string> = {};
  const revisions: Record<string, string> = {};
  const files = new Set<string>();
  for (const { path, scan } of scanned) {
    const mount = holding.get(path);
    if (!mount) continue;
    if (mount.revision !== scan.revision) {
      try {
        await uploadMount(input.rpc, path, scan);
      } catch (error) {
        logger.warn(`[LocalMounts] failed to sync ${path} spaceId=${input.spaceId}`, error);
        continue;
      }
    }
    hostPaths[path] = mount.hostPath;
    revisions[path] = scan.revision;
    for (const file of scan.files) files.add(`${path}/${file.path}`);
  }
  return { hostPaths, revisions, files };
}
