import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { ScannedFile } from "./scan.js";

/**
 * Per-space stat cache: lets a save reuse the blob of every file whose stat is
 * unchanged since the previous save, without reading it. It is a cache only;
 * a missing or mismatched index makes the next save hash every file.
 */
const INDEX_FILE = "checkpoint-index.v1.json.gz";
/** Entries modified this close to the scan may change again without a visible stat change. */
const RACY_WINDOW_NS = 3_000_000_000n;

export type FileIndexAsset = {
  sha256: string;
  objectKey: string;
  mimeType: string | null;
};

export type FileIndexEntry = {
  type: ScannedFile["type"];
  mode: string;
  size: number;
  mtimeNs: string;
  ctimeNs: string;
  ino: string;
  oid: string;
  racy: boolean;
  asset: FileIndexAsset | null;
};

export type FileIndex = {
  version: 1;
  commit: string;
  entries: Record<string, FileIndexEntry>;
};

export const fileMode = (file: Pick<ScannedFile, "type" | "executable">) =>
  file.type === "symlink" ? "120000" : file.executable ? "100755" : "100644";

export async function loadFileIndex(systemDir: string, commit: string | null): Promise<FileIndex | null> {
  if (!commit) return null;
  const raw = await readFile(join(systemDir, INDEX_FILE)).catch(() => null);
  if (!raw) return null;
  try {
    const index = JSON.parse(gunzipSync(raw).toString("utf8")) as FileIndex;
    return index?.version === 1 && index.commit === commit && index.entries ? index : null;
  } catch {
    return null;
  }
}

export async function writeFileIndex(systemDir: string, index: FileIndex) {
  await mkdir(systemDir, { recursive: true, mode: 0o775 });
  const target = join(systemDir, INDEX_FILE);
  const tmp = `${target}.tmp-${crypto.randomUUID()}`;
  try {
    await writeFile(tmp, gzipSync(JSON.stringify(index)));
    await rename(tmp, target);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

export function reusableEntry(previous: FileIndexEntry | undefined, file: ScannedFile, asset: boolean) {
  if (!previous || previous.racy) return null;
  if (previous.type !== file.type || previous.mode !== fileMode(file) || previous.size !== file.size) return null;
  if (previous.mtimeNs !== file.mtimeNs || previous.ctimeNs !== file.ctimeNs || previous.ino !== file.ino) return null;
  if (Boolean(previous.asset) !== asset) return null;
  return previous;
}

export function isRacy(file: ScannedFile, scanStartedAtNs: bigint) {
  return BigInt(file.mtimeNs) >= scanStartedAtNs - RACY_WINDOW_NS || BigInt(file.ctimeNs) >= scanStartedAtNs - RACY_WINDOW_NS;
}
