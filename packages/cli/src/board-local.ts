import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { BoardApplyResult, BoardPatch, BoardReadResult } from "@neta-art/cohub";
import {
  type BoardDelta,
  type BoardDocument,
  applyBoardDelta,
  applyBoardPatch,
  createBoardLayout,
  createDocumentState,
  diffBoardDocuments,
  isEmptyBoardDelta,
  parseBoardDocument,
} from "@neta-art/cohub/board";
import { isSpaceBoardManifest } from "./board-files.js";
import { localMediaFacts } from "./local-media.js";

/**
 * A local Board is one JSON file, `{ version, board, items, animations }`, with
 * its history beside it in `.<name>.history.jsonl`. Every write goes through a
 * lock file, so the CLI and an open viewer never lose each other's changes.
 */
export type LocalBoardWriter = "cli" | "viewer" | "restore" | "external";

export type LocalBoard = { version: number; document: BoardDocument; hash: string; updatedAt: string };

type HistoryEntry = {
  version: number;
  at: string;
  by: LocalBoardWriter;
  hash: string;
  mutationId?: string;
} & ({ document: BoardDocument } | { after: BoardDelta });

export type LocalBoardWrite = { result: BoardApplyResult; baseVersion: number; after?: BoardDelta };

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

const summarize = (delta: BoardDelta): BoardApplyResult["changed"] => ({
  board: Boolean(delta.board),
  items: Object.keys(delta.items ?? {}),
  animations: [...new Set([...Object.keys(delta.animations ?? {}), ...Object.keys(delta.tracks ?? {})])],
});

const historyPath = (path: string) => join(dirname(path), `.${basename(path)}.history.jsonl`);
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

function serialize(version: number, document: BoardDocument): string {
  return `${JSON.stringify({ version, board: document.board, items: document.items, animations: document.animations }, null, 2)}\n`;
}

function parse(path: string, text: string): { version: number; document: BoardDocument } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${path} is not valid JSON.`, { cause });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path} must contain a JSON object.`);
  if (isSpaceBoardManifest(raw)) throw new Error(`${path} points to a Board in a Space; use it from that Space.`);
  const parsed = parseBoardDocument(raw, { keepUnknown: true });
  if (!parsed.ok) {
    const first = parsed.diagnostics[0];
    throw new Error(`${path} is not a valid Board: ${first?.path}: ${first?.message}`);
  }
  const version = (raw as { version?: unknown }).version;
  return { version: Number.isSafeInteger(version) && (version as number) >= 0 ? (version as number) : 0, document: parsed.document };
}

export async function readLocalBoard(path: string): Promise<LocalBoard> {
  const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") throw new Error(`${path} does not exist; create it with cohub boards create ${path}.`);
    throw cause;
  });
  return { ...parse(path, text), hash: hashOf(text), updatedAt: info.mtime.toISOString() };
}

export function localBoardTitle(path: string, document: BoardDocument): string {
  return document.board.title || basename(path).replace(/\.board$/i, "") || basename(path);
}

export function localBoardReadResult(id: string, path: string, board: LocalBoard): BoardReadResult {
  const { document } = board;
  return {
    id,
    title: localBoardTitle(path, document),
    version: board.version,
    updatedAt: board.updatedAt,
    board: document.board,
    items: document.items,
    animations: document.animations,
    playback: null,
  };
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (cause) {
    await unlink(temp).catch(() => undefined);
    throw cause;
  }
}

async function withLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await writeFile(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      const held = await stat(lock).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (held > LOCK_STALE_MS) await unlink(lock).catch(() => undefined);
      else if (Date.now() > deadline) throw new Error(`${path} is locked by another write; remove ${lock} if no cohub process is running.`);
      else await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await work();
  } finally {
    await unlink(lock).catch(() => undefined);
  }
}

/** The last line of the history, read from the end so long histories stay cheap. */
async function lastHistoryEntry(path: string): Promise<HistoryEntry | null> {
  const handle = await open(historyPath(path), constants.O_RDONLY).catch(() => null);
  if (!handle) return null;
  try {
    const { size } = await handle.stat();
    let end = size;
    let tail = "";
    while (end > 0) {
      const length = Math.min(64 * 1024, end);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, end - length);
      end -= length;
      tail = buffer.toString("utf8") + tail;
      const lines = tail.trimEnd().split("\n");
      if (lines.length > 1 || end === 0) return JSON.parse(lines.at(-1) as string) as HistoryEntry;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function readHistory(path: string): Promise<HistoryEntry[]> {
  const text = await readFile(historyPath(path), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as HistoryEntry);
}

async function appendHistory(path: string, entry: HistoryEntry): Promise<void> {
  await writeFile(historyPath(path), `${JSON.stringify(entry)}\n`, { flag: "a" });
}

export async function createLocalBoard(path: string, input: { title?: string; patch?: BoardPatch }): Promise<LocalBoard> {
  const empty = parseBoardDocument({});
  if (!empty.ok) throw new Error("The empty Board is invalid.");
  const patch = { ...input.patch, ...(input.title ? { board: { ...(input.patch?.board as object | undefined), title: input.title } } : {}) };
  const applied = applyBoardPatch(createDocumentState(empty.document), patch);
  if (!applied.ok) {
    const first = applied.diagnostics[0];
    throw new Error(`The initial document is invalid: ${first?.path}: ${first?.message}`);
  }
  const document = applyBoardDelta(empty.document, applied.after);
  const text = serialize(1, document);
  await writeFile(path, text, { flag: "wx" }).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "EEXIST") throw new Error(`${path} already exists.`);
    throw cause;
  });
  await unlink(historyPath(path)).catch(() => undefined);
  const at = new Date().toISOString();
  await appendHistory(path, { version: 1, at, by: "cli", hash: hashOf(text), document });
  return { version: 1, document, hash: hashOf(text), updatedAt: at };
}

/** Records an edit made outside these functions as a version of its own. */
async function adoptExternal(path: string, current: LocalBoard): Promise<LocalBoard> {
  const last = await lastHistoryEntry(path);
  if (last?.hash === current.hash) return current;
  const version = Math.max(current.version, last?.version ?? 0) + 1;
  const text = serialize(version, current.document);
  await writeAtomic(path, text);
  await appendHistory(path, { version, at: new Date().toISOString(), by: "external", hash: hashOf(text), document: current.document });
  return { ...current, version, hash: hashOf(text) };
}

export async function applyLocalBoard(
  path: string,
  input: BoardPatch,
  options: { by: LocalBoardWriter; replace?: boolean; cascade?: boolean; dryRun?: boolean; baseVersion?: number; mutationId?: string },
): Promise<LocalBoardWrite> {
  const mutationId = options.mutationId ?? randomUUID();
  return withLock(path, async () => {
    let current = await readLocalBoard(path);
    if (options.baseVersion !== undefined && options.baseVersion !== current.version)
      throw Object.assign(new Error(`Board is at version ${current.version}, not ${options.baseVersion}.`), { status: 409 });
    let patch = input;
    if (options.replace) {
      const target = parseBoardDocument(patch);
      if (!target.ok) throw Object.assign(new Error(`Board document is invalid: ${target.diagnostics[0]?.path}: ${target.diagnostics[0]?.message}`), { status: 400 });
      patch = diffBoardDocuments(current.document, target.document);
    }
    const layout = createBoardLayout((id) => current.document.items[id]);
    const applied = applyBoardPatch(createDocumentState(current.document), patch, {
      cascade: options.cascade,
      resolveArrowEnd: (arrowId, which) => layout.arrowEnd(arrowId, which),
    });
    if (!applied.ok) {
      const first = applied.diagnostics[0];
      throw Object.assign(new Error(first ? `${first.path}: ${first.message}` : "Board patch is invalid."), { status: 400, diagnostics: applied.diagnostics });
    }
    const changed = summarize(applied.after);
    const result = (status: BoardApplyResult["status"], version: number): BoardApplyResult =>
      ({ mutationId, status, replayed: false, version, changed, diagnostics: status === "unchanged" ? [] : applied.diagnostics });
    if (options.dryRun) return { result: result("validated", current.version), baseVersion: current.version };
    current = await adoptExternal(path, current);
    if (isEmptyBoardDelta(applied.after)) return { result: result("unchanged", current.version), baseVersion: current.version };
    const version = current.version + 1;
    const document = applyBoardDelta(current.document, applied.after);
    const text = serialize(version, document);
    await writeAtomic(path, text);
    await appendHistory(path, { version, at: new Date().toISOString(), by: options.by, hash: hashOf(text), mutationId, after: applied.after });
    return { result: result("applied", version), baseVersion: current.version, after: applied.after };
  });
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};

/** Named by content, so the same image is stored once. */
export async function storeLocalBoardImage(path: string, bytes: Uint8Array, mimeType: string, title: string) {
  const extension = IMAGE_EXTENSIONS[mimeType];
  if (!extension) throw Object.assign(new Error(`${mimeType || "This file"} is not a supported image.`), { status: 415 });
  const src = `assets/${createHash("sha256").update(bytes).digest("hex").slice(0, 20)}.${extension}`;
  const file = join(dirname(path), src);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes, { flag: "wx" }).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== "EEXIST") throw cause;
  });
  const facts = await localMediaFacts(file, "image");
  return {
    url: src,
    snapshot: {
      ...(title ? { title } : {}),
      mimeType,
      size: bytes.byteLength,
      ...(facts ? { naturalWidth: facts.width, naturalHeight: facts.height } : {}),
    },
  };
}

/** The newest history entry, if it describes the file as it is now. */
export async function localBoardChange(path: string): Promise<{ version: number; mutationId?: string; after: BoardDelta } | null> {
  const [last, text] = await Promise.all([lastHistoryEntry(path), readFile(path, "utf8").catch(() => null)]);
  if (!last || text === null || last.hash !== hashOf(text) || !("after" in last)) return null;
  return { version: last.version, after: last.after, ...(last.mutationId ? { mutationId: last.mutationId } : {}) };
}

export type LocalBoardVersion = { version: number; at: string; by: LocalBoardWriter; items: number; animations: number };

export async function localBoardHistory(path: string, options: { before?: number; limit: number }): Promise<{ versions: LocalBoardVersion[]; nextBefore: number | null }> {
  const entries = (await readHistory(path)).filter((entry) => options.before === undefined || entry.version < options.before).reverse();
  const page = entries.slice(0, options.limit);
  return {
    versions: page.map((entry) => {
      const touched = "after" in entry ? entry.after : { items: entry.document.items, animations: entry.document.animations };
      return {
        version: entry.version,
        at: entry.at,
        by: entry.by,
        items: Object.keys(touched.items ?? {}).length,
        animations: new Set([...Object.keys(touched.animations ?? {}), ...Object.keys(("tracks" in touched && touched.tracks) || {})]).size,
      };
    }),
    nextBefore: entries.length > options.limit ? (page.at(-1)?.version ?? null) : null,
  };
}

export async function restoreLocalBoard(path: string, version: number): Promise<LocalBoardWrite> {
  const entries = (await readHistory(path)).filter((entry) => entry.version <= version);
  let start = entries.length - 1;
  while (start >= 0 && !("document" in (entries[start] as HistoryEntry))) start--;
  if (start < 0 || entries.at(-1)?.version !== version) throw new Error(`Version ${version} is not in the history of ${path}.`);
  let document = (entries[start] as { document: BoardDocument }).document;
  for (const entry of entries.slice(start + 1)) if ("after" in entry) document = applyBoardDelta(document, entry.after);
  const current = await readLocalBoard(path);
  return applyLocalBoard(path, diffBoardDocuments(current.document, document), { by: "restore", baseVersion: current.version });
}
