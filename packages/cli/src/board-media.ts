import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  type BoardDocument,
  type BoardItem,
  type BoardMediaFileResolver,
  type BoardMediaSize,
  diffMergePatch,
  mergePatch,
  parseBoardItem,
  settleBoardMediaSizes,
} from "@neta-art/cohub/board";
import { createClient } from "./client.js";
import { WORKSPACE_ROOT } from "./space-files/operands.js";

const run = promisify(execFile);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const oriented = (width: number, height: number, turned: boolean): BoardMediaSize | null =>
  width > 0 && height > 0 ? (turned ? { width: height, height: width } : { width, height }) : null;

async function localMediaSize(file: string, type: "image" | "video", signal?: AbortSignal): Promise<BoardMediaSize | null> {
  try {
    if (type === "image") {
      const { default: sharp } = await import("sharp");
      const { width = 0, height = 0, orientation = 1 } = await sharp(file).metadata();
      return oriented(width, height, orientation >= 5);
    }
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height:stream_side_data=rotation", "-of", "json", file,
    ], { signal, timeout: 5_000 });
    const stream = (JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number; side_data_list?: Array<{ rotation?: number }> }> }).streams?.[0];
    const rotation = stream?.side_data_list?.find((data) => data.rotation !== undefined)?.rotation ?? 0;
    return oriented(stream?.width ?? 0, stream?.height ?? 0, Math.abs(rotation) % 180 === 90);
  } catch {
    return null;
  }
}

export function boardMediaFileResolver(spaceId: string): BoardMediaFileResolver {
  const local = process.env.COHUB_SPACE_ID === spaceId;
  return async (path, type, signal) => {
    const file = resolve(WORKSPACE_ROOT, path);
    const size = local && file.startsWith(`${WORKSPACE_ROOT}/`) ? await localMediaSize(file, type, signal) : null;
    return size ?? createClient().space(spaceId).files.resolveUrl(path, { purpose: "playback", signal }).catch(() => null);
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
