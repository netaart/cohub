import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import type { ScannedFile } from "./scan.js";

/**
 * Per-space stat cache: lets a save reuse the blob of every file whose stat is
 * unchanged since the save that recorded it, without reading the file. It is a
 * cache only; a missing or unusable index makes the next save hash every file.
 *
 * Stored as gzipped NDJSON (a header line, then one compact array per entry)
 * and streamed both ways, so large workspaces never build one huge string.
 */
const INDEX_FILE = "checkpoint-index.v1.ndjson.gz";
/** Entries modified this close to the scan may change again without a visible stat change. */
const RACY_WINDOW_NS = 3_000_000_000n;
const PENDING_FILE = `${INDEX_FILE}.pending`;
const WRITE_BATCH = 1_000;

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
  commit: string;
  entries: Map<string, FileIndexEntry>;
  /** Tree id of every directory in `commit` ("" is the root), so a save rebuilds only the directories that changed. */
  trees: Map<string, string>;
};

type Row = [string, ScannedFile["type"], string, number, string, string, string, string, 0 | 1, [string, string, string | null] | 0];

export const fileMode = (file: Pick<ScannedFile, "type" | "executable">) =>
  file.type === "symlink" ? "120000" : file.executable ? "100755" : "100644";

const toRow = (path: string, entry: FileIndexEntry): Row => [
  path, entry.type, entry.mode, entry.size, entry.mtimeNs, entry.ctimeNs, entry.ino, entry.oid, entry.racy ? 1 : 0,
  entry.asset ? [entry.asset.sha256, entry.asset.objectKey, entry.asset.mimeType] : 0,
];

const fromRow = (row: Row): [string, FileIndexEntry] => {
  const [path, type, mode, size, mtimeNs, ctimeNs, ino, oid, racy, asset] = row;
  return [path, { type, mode, size, mtimeNs, ctimeNs, ino, oid, racy: racy === 1, asset: asset ? { sha256: asset[0], objectKey: asset[1], mimeType: asset[2] } : null }];
};

/** The index as last written, whichever commit it belongs to; null when absent or unreadable. */
export const loadFileIndex = (systemDir: string) => readIndexFile(join(systemDir, INDEX_FILE));
export const loadStagedFileIndex = (systemDir: string) => readIndexFile(join(systemDir, PENDING_FILE));

async function readIndexFile(path: string): Promise<FileIndex | null> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return null;
  const gunzip = createGunzip();
  const source = handle.createReadStream();
  source.on("error", (error) => gunzip.destroy(error));
  const lines = createInterface({ input: source.pipe(gunzip), crlfDelay: Number.POSITIVE_INFINITY });
  try {
    let commit: string | null = null;
    const entries = new Map<string, FileIndexEntry>();
    const trees = new Map<string, string>();
    for await (const line of lines) {
      if (commit === null) {
        const header = JSON.parse(line) as { version?: unknown; commit?: unknown };
        if (header.version !== 1 || typeof header.commit !== "string") return null;
        commit = header.commit;
        continue;
      }
      const row = JSON.parse(line) as Row | [string, string];
      if (row.length === 2) trees.set(row[0], row[1]);
      else {
        const [path, entry] = fromRow(row as Row);
        entries.set(path, entry);
      }
    }
    return commit ? { commit, entries, trees } : null;
  } catch {
    return null;
  } finally {
    lines.close();
    await handle.close().catch(() => undefined);
  }
}

/**
 * Written before the checkpoint commits and promoted after, so a run retried
 * after its worker died still finds the index of the commit it made.
 */
export const stageFileIndex = (systemDir: string, index: FileIndex) => writeIndexFile(systemDir, PENDING_FILE, index);

/** Promote the staged index if it belongs to `commit`. */
export async function promoteFileIndex(systemDir: string, commit: string) {
  if (await readIndexCommit(join(systemDir, PENDING_FILE)) !== commit) return;
  await rename(join(systemDir, PENDING_FILE), join(systemDir, INDEX_FILE));
}

async function readIndexCommit(path: string) {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return null;
  const lines = createInterface({ input: handle.createReadStream().pipe(createGunzip()), crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      const header = JSON.parse(line) as { version?: unknown; commit?: unknown };
      return header.version === 1 && typeof header.commit === "string" ? header.commit : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    lines.close();
    await handle.close().catch(() => undefined);
  }
}

async function writeIndexFile(systemDir: string, name: string, index: FileIndex) {
  await mkdir(systemDir, { recursive: true, mode: 0o775 });
  const target = join(systemDir, name);
  const tmp = `${target}.tmp-${crypto.randomUUID()}`;
  async function* lines() {
    yield `${JSON.stringify({ version: 1, commit: index.commit })}\n`;
    let batch = "";
    let count = 0;
    for (const [path, entry] of index.entries) {
      batch += `${JSON.stringify(toRow(path, entry))}\n`;
      if (++count % WRITE_BATCH === 0) {
        yield batch;
        batch = "";
      }
    }
    for (const [dir, oid] of index.trees) {
      batch += `${JSON.stringify([dir, oid])}\n`;
      if (++count % WRITE_BATCH === 0) {
        yield batch;
        batch = "";
      }
    }
    if (batch) yield batch;
  }
  try {
    await pipeline(Readable.from(lines()), createGzip(), createWriteStream(tmp));
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
