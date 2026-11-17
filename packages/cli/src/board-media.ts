import { execFile } from "node:child_process";
import { resolve } from "node:path";
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
import { createClient } from "./client.js";
import { localMediaFacts } from "./local-media.js";
import { WORKSPACE_ROOT } from "./space-files/operands.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function boardMediaFileResolver(spaceId: string): BoardMediaFileResolver {
  const local = process.env.COHUB_SPACE_ID === spaceId;
  return async (path, type, signal) => {
    const file = resolve(WORKSPACE_ROOT, path);
    const facts = local && file.startsWith(`${WORKSPACE_ROOT}/`) ? await localMediaFacts(file, type, signal) : null;
    const resolved = facts ? null : await createClient().space(spaceId).files.resolve(path, { purpose: "playback", signal }).catch(() => null);
    const size = facts ?? resolved?.media;
    return size ? { width: size.width, height: size.height } : (resolved?.url ?? null);
  };
}

export async function settleBoardDocument(spaceId: string, document: BoardDocument): Promise<BoardDocument> {
  const settled = await settleBoardMediaSizes(document.items, { resolveFile: boardMediaFileResolver(spaceId) });
  return Object.keys(settled).length ? { ...document, items: { ...document.items, ...settled } } : document;
}

export async function settleBoardPatch<T extends Record<string, unknown>>(
  spaceId: string,
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
  const settled = await settleBoardMediaSizes(created, { resolveFile: boardMediaFileResolver(spaceId) });
  if (!Object.keys(settled).length) return patch;
  const adopted = Object.entries(settled).map(([id, item]) => [id, mergePatch(items[id], diffMergePatch(created[id], item))]);
  return { ...patch, items: { ...items, ...Object.fromEntries(adopted) } };
}

const run = promisify(execFile);

export async function settleBoardMediaDurations(spaceId: string, document: BoardDocument, ids: readonly string[]): Promise<Record<string, BoardItem>> {
  const local = process.env.COHUB_SPACE_ID === spaceId;
  const settled: Record<string, BoardItem> = {};
  for (const id of ids) {
    const item = document.items[id];
    if ((item?.type !== "video" && item?.type !== "audio") || item.props.snapshot?.durationMs) continue;
    const file = item.props.src.startsWith("http") ? null : resolve(WORKSPACE_ROOT, item.props.src);
    const input = file && local && file.startsWith(`${WORKSPACE_ROOT}/`)
      ? file
      : file ? (await createClient().space(spaceId).files.resolve(item.props.src, { purpose: "playback" }).catch(() => null))?.url : null;
    const seconds = input
      ? Number((await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input], { timeout: 15_000 }).catch(() => ({ stdout: "" }))).stdout)
      : Number.NaN;
    if (!(seconds > 0)) throw new Error(`The length of ${id} is unknown; pass --duration.`);
    settled[id] = { ...item, props: { ...item.props, snapshot: { ...item.props.snapshot, durationMs: Math.round(seconds * 1000) } } } as BoardItem;
  }
  return settled;
}
