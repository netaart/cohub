import type { BoardSceneItem, } from "./core/scene.js";
import { featuredTaskArtifact, taskArtifactPreviewUrl } from "./task.js";

export function imageAssetKey(item: BoardSceneItem): string | null {
  if (item.type === "image") return `file:${item.props.src}`;
  if (item.type === "file") {
    const snapshot = item.props.snapshot;
    if (snapshot?.coverPath) return `file:${snapshot.coverPath}`;
    if (snapshot?.coverUrl) return `url:${snapshot.coverUrl}`;
    return null;
  }
  if (item.type === "task") {
    const url = taskArtifactPreviewUrl(
      featuredTaskArtifact(item.props.snapshot.artifacts),
    );
    return url ? `url:${url}` : null;
  }
  return null;
}

export function boardImageKeySource(
  key: string,
): { kind: "file" | "url"; value: string } | null {
  if (key.startsWith("file:")) return { kind: "file", value: key.slice(5) };
  if (key.startsWith("url:")) return { kind: "url", value: key.slice(4) };
  return null;
}
