import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  type BoardDocument,
  type BoardItem,
  type BoardMediaFileResolver,
  type BoardModelClip,
  boardModelFormat,
  boardModelJsonLength,
  diffMergePatch,
  mergePatch,
  parseBoardItem,
  parseBoardMediaSource,
  readBoardModelClips,
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

const GLTF_JSON_MAX_BYTES = 16 * 1024 * 1024;

async function localModelClips(file: string): Promise<BoardModelClip[] | null> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const head = new Uint8Array(20);
    const { bytesRead } = await handle.read(head, 0, head.byteLength, 0);
    const length = Math.min(boardModelJsonLength(head.subarray(0, bytesRead)) ?? (await handle.stat()).size, GLTF_JSON_MAX_BYTES);
    const bytes = new Uint8Array(length);
    await handle.read(bytes, 0, length, 0);
    return readBoardModelClips(bytes);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function settleBoardModelClips(spaceId: string, items: Readonly<Record<string, BoardItem>>): Promise<Record<string, BoardItem>> {
  if (process.env.COHUB_SPACE_ID !== spaceId) return {};
  const settled: Record<string, BoardItem> = {};
  await Promise.all(Object.entries(items).map(async ([id, item]) => {
    if (item.type !== "file" || item.props.snapshot?.clips) return;
    const format = boardModelFormat(item.props.src, item.props.snapshot?.mimeType);
    if (format !== "glb" && format !== "gltf") return;
    const source = parseBoardMediaSource(item.props.src);
    const file = source?.kind === "file" ? resolve(WORKSPACE_ROOT, source.value) : null;
    const clips = file?.startsWith(`${WORKSPACE_ROOT}/`) ? await localModelClips(file) : null;
    if (clips?.length) settled[id] = { ...item, props: { ...item.props, snapshot: { ...item.props.snapshot, clips } } };
  }));
  return settled;
}

async function settleItems(spaceId: string, items: Readonly<Record<string, BoardItem>>): Promise<Record<string, BoardItem>> {
  const sized = await settleBoardMediaSizes(items, { resolveFile: boardMediaFileResolver(spaceId) });
  return { ...sized, ...(await settleBoardModelClips(spaceId, items)) };
}

export async function settleBoardDocument(spaceId: string, document: BoardDocument): Promise<BoardDocument> {
  const settled = await settleItems(spaceId, document.items);
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
    if (!isRecord(value) || (value.type !== "image" && value.type !== "video" && value.type !== "file")) continue;
    const parsed = parseBoardItem(value, `items.${id}`);
    if (parsed.ok) created[id] = parsed.item;
  }
  const existing = Object.keys(created).length ? await current(Object.keys(created)) : null;
  if (!existing) return patch;
  for (const [id, item] of Object.entries(existing)) {
    if (isRecord(item) && item.type === created[id]?.type) delete created[id];
  }
  const settled = await settleItems(spaceId, created);
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
