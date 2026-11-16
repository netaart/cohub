import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type BoardDocument,
  type BoardItem,
  type BoardMediaFileResolver,
  diffMergePatch,
  mergePatch,
  parseBoardItem,
  settleBoardMediaSizes,
} from "@neta-art/cohub/board";
import type { BoardFiles } from "./board-files.js";
import { localMediaFacts } from "./local-media.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function boardMediaFileResolver(files: BoardFiles): BoardMediaFileResolver {
  return async (path, type, signal) => {
    const file = files.local(path);
    const facts = file ? await localMediaFacts(file, type, signal) : null;
    const resolved = facts ? null : await files.resolve(path, signal);
    const size = facts ?? resolved?.media;
    return size ? { width: size.width, height: size.height } : (resolved?.url ?? null);
  };
}

export async function settleBoardDocument(files: BoardFiles, document: BoardDocument): Promise<BoardDocument> {
  const settled = await settleBoardMediaSizes(document.items, { resolveFile: boardMediaFileResolver(files) });
  return Object.keys(settled).length ? { ...document, items: { ...document.items, ...settled } } : document;
}

export async function settleBoardPatch<T extends Record<string, unknown>>(
  files: BoardFiles,
  patch: T,
  current: (ids: string[]) => Promise<Record<string, unknown> | null>,
): Promise<T> {
  const items = isRecord(patch.items) ? patch.items : {};
  const created: Record<string, BoardItem> = {};
  for (const [id, value] of Object.entries(items)) {
    if (!isRecord(value) || (value.type !== "image" && value.type !== "video")) continue;
    const parsed = parseBoardItem(value, `items.${id}`);
    if (parsed.ok) created[id] = parsed.item;
  }
  const existing = Object.keys(created).length ? await current(Object.keys(created)) : null;
  if (!existing) return patch;
  for (const [id, item] of Object.entries(existing)) {
    if (isRecord(item) && item.type === created[id]?.type) delete created[id];
  }
  const settled = await settleBoardMediaSizes(created, { resolveFile: boardMediaFileResolver(files) });
  if (!Object.keys(settled).length) return patch;
  // A size is adopted whole: the patch may name neither edge, and half a size is invalid.
  const adopted = Object.entries(settled).map(([id, item]) => {
    const merged = mergePatch(items[id], diffMergePatch(created[id], item)) as Record<string, unknown>;
    return [id, merged.size ? { ...merged, size: (item as { size?: unknown }).size } : merged];
  });
  return { ...patch, items: { ...items, ...Object.fromEntries(adopted) } };
}

const run = promisify(execFile);

export async function settleBoardMediaDurations(files: BoardFiles, document: BoardDocument, ids: readonly string[]): Promise<Record<string, BoardItem>> {
  const settled: Record<string, BoardItem> = {};
  for (const id of ids) {
    const item = document.items[id];
    if ((item?.type !== "video" && item?.type !== "audio") || item.props.snapshot?.durationMs) continue;
    const remote = item.props.src.startsWith("http");
    const input = remote ? null : files.local(item.props.src) ?? (await files.resolve(item.props.src))?.url;
    const seconds = input
      ? Number((await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input], { timeout: 15_000 }).catch(() => ({ stdout: "" }))).stdout)
      : Number.NaN;
    if (!(seconds > 0)) throw new Error(`The length of ${id} is unknown; pass --duration.`);
    settled[id] = { ...item, props: { ...item.props, snapshot: { ...item.props.snapshot, durationMs: Math.round(seconds * 1000) } } } as BoardItem;
  }
  return settled;
}
