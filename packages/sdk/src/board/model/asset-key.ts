import { boardItemPreview, featuredTaskArtifact, taskArtifactPreviewUrl } from "@cohub/protocol";
import { type BoardMediaSource, isSafeBoardSourcePath, parseBoardMediaSource } from "@cohub/protocol/board-model";
import { MEDIA_VARIANT_MAX, type MediaSize, mediaVariantSize } from "../../media.js";
import { boardModelViewKey, isBoardModelItem } from "./media.js";
import { boardModelCover } from "./model-cover.js";
import type { BoardSceneItem } from "./scene.js";

export type BoardAssetMedia = "image" | "video" | "model";

export type BoardAssetKeySource = { kind: "file" | "url"; media: BoardAssetMedia; value: string; fit?: "cover" };

/** `natural` is the media's own pixel size, never a scaled copy's; it replaces the item's recorded size. */
export type BoardAssetRef = { src: string; media?: "image" | "video"; fit?: "contain" | "cover"; natural?: MediaSize };

const COVER = "cover:";
const MODEL_VIEW = "@";

export function boardAssetRefKey({ src, media = "image", fit }: BoardAssetRef): string | null {
  if (!src) return null;
  const source: BoardMediaSource = { kind: isSafeBoardSourcePath(src) ? "file" : "url", value: src };
  if (media === "video") return stillKey("video", source, undefined);
  const key = `${source.kind}:${source.value}`;
  return fit === "cover" ? COVER + key : key;
}

export function imageAssetKey(item: BoardSceneItem): string | null {
  if (item.type === "image") {
    const source = parseBoardMediaSource(item.props.src);
    return source ? `${source.kind}:${source.value}` : null;
  }
  if (item.type === "file") {
    const snapshot = item.props.snapshot;
    if (snapshot?.coverUrl) return `url:${snapshot.coverUrl}`;
    if (snapshot?.coverPath) return `file:${snapshot.coverPath}`;
    return null;
  }
  if (item.type === "task") {
    const url = taskArtifactPreviewUrl(featuredTaskArtifact(item.props.snapshot.artifacts));
    return url ? `url:${url}` : null;
  }
  const cover = boardItemPreview(item)?.cover;
  const source = cover ? parseBoardMediaSource(cover) : null;
  return source ? `${source.kind}:${source.value}` : null;
}

const STILL_MEDIA = ["video", "model"] as const;

function stillKey(media: (typeof STILL_MEDIA)[number], source: BoardMediaSource | null, mtimeMs: number | undefined) {
  if (!source) return null;
  return source.kind === "url"
    ? `${media}-url:${encodeURIComponent(source.value)}`
    : `${media}:${encodeURIComponent(source.value)}:${mtimeMs ?? "unknown"}`;
}

function taskPreviewKey(item: Extract<BoardSceneItem, { type: "task" }>) {
  const artifact = featuredTaskArtifact(item.props.snapshot.artifacts);
  const cover = taskArtifactPreviewUrl(artifact);
  if (cover) return `url:${cover}`;
  return artifact?.type === "video" ? stillKey("video", { kind: "url", value: artifact.url }, undefined) : null;
}

export function boardMediaNaturalSize(item: BoardSceneItem): MediaSize | null {
  const recorded =
    item.type === "task"
      ? featuredTaskArtifact(item.props.snapshot.artifacts)
      : item.type === "image" || item.type === "video"
        ? item.props.snapshot
        : null;
  return recorded && "naturalWidth" in recorded && recorded.naturalWidth && recorded.naturalHeight
    ? { width: recorded.naturalWidth, height: recorded.naturalHeight }
    : null;
}

export function boardAssetKey(item: BoardSceneItem): string | null {
  if (item.type === "task") return taskPreviewKey(item);
  if (item.type === "video") return stillKey("video", parseBoardMediaSource(item.props.src), item.props.snapshot?.mtimeMs);
  if (item.type === "file" && isBoardModelItem(item)) {
    const cover = boardModelCover(item);
    if (cover) return `url:${cover}`;
    const key = stillKey("model", parseBoardMediaSource(item.props.src), item.props.snapshot?.mtimeMs);
    const { view, animation } = item.props.model ?? {};
    const look = `${boardModelViewKey(view)}${animation ? `${MODEL_VIEW}${encodeURIComponent(animation)}` : ""}`;
    return key && look ? `${key}${MODEL_VIEW}${look}` : key;
  }
  return imageAssetKey(item);
}

export function boardAssetKeySource(key: string): BoardAssetKeySource | null {
  let base = key;
  if (key.startsWith("local:")) {
    const separator = key.indexOf(":", 6);
    if (separator < 0) return null;
    base = key.slice(separator + 1);
  }
  if (base.startsWith("model")) base = base.split(MODEL_VIEW, 1)[0] as string;
  if (!base.startsWith(COVER)) return sourceOf(base);
  const source = sourceOf(base.slice(COVER.length));
  return source?.media === "image" ? { ...source, fit: "cover" } : null;
}

function sourceOf(base: string): BoardAssetKeySource | null {
  try {
    for (const media of STILL_MEDIA) {
      if (base.startsWith(`${media}-url:`)) return { kind: "url", media, value: decodeURIComponent(base.slice(media.length + 5)) };
      if (base.startsWith(`${media}:`)) {
        const end = base.lastIndexOf(":");
        return end > media.length ? { kind: "file", media, value: decodeURIComponent(base.slice(media.length + 1, end)) } : null;
      }
    }
  } catch {
    return null;
  }
  if (base.startsWith("file:")) return { kind: "file", media: "image", value: base.slice(5) };
  if (base.startsWith("url:")) return { kind: "url", media: "image", value: base.slice(4) };
  return null;
}

export function boardTexturePixels(item: BoardSceneItem, scale: number): number {
  const crop = item.type === "image" ? item.props.crop : undefined;
  return Math.max(item.frame.width / (crop?.w || 1), item.frame.height / (crop?.h || 1)) * scale;
}

export const BOARD_THUMBNAIL_EDGE = 64;

export function boardTextureEdge(item: BoardSceneItem, scale: number): number {
  const pixels = boardTexturePixels(item, scale);
  if (pixels <= BOARD_THUMBNAIL_EDGE) return BOARD_THUMBNAIL_EDGE;
  return pixels > MEDIA_VARIANT_MAX ? Number.POSITIVE_INFINITY : mediaVariantSize(pixels);
}
