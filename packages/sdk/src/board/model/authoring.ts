import {
  BoardIdSchema,
  applyBoardPatchToDocument,
  type BoardAnimation,
  type BoardDocument,
  type BoardKeyframe,
  type BoardPatch,
  type BoardTrack,
  type BoardVec2,
} from "@cohub/protocol";
import { type BoardTimelinePlacement, boardPlaceTarget, boardTargetSpan } from "./timeline.js";

export type BoardChapter = { animation: string; frame?: string; label?: string; gap?: number; pause?: boolean };

function validateChapterComposition(document: BoardDocument, chapters: readonly BoardChapter[]): void {
  const uses = new Map<string, Map<string, { chapters: Set<number>; additive: boolean }>>();
  for (const [index, chapter] of chapters.entries()) {
    for (const track of Object.values(document.animations[chapter.animation]?.tracks ?? {})) {
      let properties = uses.get(track.target);
      if (!properties) {
        properties = new Map();
        uses.set(track.target, properties);
      }
      for (const [property, usage] of properties) {
        const overlaps = property === track.property || property.startsWith(`${track.property}.`) || track.property.startsWith(`${property}.`);
        if (overlaps && (usage.additive || track.composite === "add") && [...usage.chapters].some((other) => other !== index)) {
          throw new Error(`Chapters share additive tracks on ${track.target}.${track.property}; use distinct items or combine the tracks before sequencing.`);
        }
      }
      const usage = properties.get(track.property) ?? { chapters: new Set<number>(), additive: false };
      usage.chapters.add(index);
      usage.additive ||= track.composite === "add";
      properties.set(track.property, usage);
    }
  }
}

export function boardSequence(document: BoardDocument, chapters: readonly BoardChapter[]): BoardAnimation {
  if (!chapters.length) throw new Error("A sequence needs at least one chapter.");
  validateChapterComposition(document, chapters);
  const tracks: Record<string, BoardTrack> = {};
  const markers: BoardAnimation["markers"] = [];
  let cursor = 0;
  const seen = new Set<string>();
  const seenFrames = new Set<string>();
  for (const [index, chapter] of chapters.entries()) {
    const animation = document.animations[chapter.animation];
    if (!animation) throw new Error(`Animation ${chapter.animation} does not exist.`);
    if (animation.play !== "manual") throw new Error(`Chapter ${chapter.animation} must use manual playback.`);
    if (!Number.isFinite(animation.duration) || animation.duration <= 0)
      throw new Error("Chapter duration must be positive and finite.");
    if (seen.has(chapter.animation))
      throw new Error(`Animation ${chapter.animation} appears more than once; use separate animation IDs.`);
    seen.add(chapter.animation);
    if (chapter.frame && document.items[chapter.frame]?.type !== "frame")
      throw new Error(`Chapter ${chapter.animation} needs a valid frame.`);
    if (chapter.frame && seenFrames.has(chapter.frame))
      throw new Error("Each chapter needs a separate frame, or omit frame visibility control.");
    if (chapter.frame) seenFrames.add(chapter.frame);
    const gap = chapter.gap ?? 0;
    if (!Number.isFinite(gap) || gap < 0) throw new Error("Chapter gap must be finite and non-negative.");
    cursor += gap;
    const start = cursor;
    const end = start + animation.duration;
    const rankWidth = String(Object.keys(animation.tracks).length).length;
    const ranks = new Map(Object.keys(animation.tracks).sort().map((id, rank) => [id, String(rank).padStart(rankWidth, "0")]));
    const chapterIndex = String(index).padStart(String(chapters.length).length, "0");
    for (const [id, track] of Object.entries(animation.tracks)) {
      if (document.animations[track.target]) throw new Error(`Chapter ${chapter.animation} contains nested clocks; compose its leaf animations instead.`);
      // Preserve both lexical replace priority and original additive evaluation order.
      tracks[`chapter-${chapterIndex}-${ranks.get(id)}`] = {
        ...track,
        keyframes: track.keyframes.map((keyframe) => ({ ...keyframe, at: start + keyframe.at })),
      };
    }
    const boundary = end + (chapter.pause && index < chapters.length - 1 ? 1 : 0);
    if (chapter.frame) {
      tracks[`visibility-${index}`] = {
        target: chapter.frame,
        property: "opacity",
        composite: "add",
        interpolation: "step",
        keyframes: [
          ...(start > 0 ? [{ at: 0, value: 0 }] : []),
          { at: start, value: 1 },
          ...(index < chapters.length - 1 ? [{ at: boundary + (chapters[index + 1]?.gap ?? 0), value: 0 }] : []),
        ],
      };
      tracks[`chapter-${chapterIndex}--camera`] = {
        target: "camera",
        property: "focus",
        composite: "replace",
        interpolation: "step",
        keyframes: [{ at: start, value: chapter.frame }],
      };
    }
    markers.push({ at: start, label: chapter.label ?? animation.name ?? chapter.animation });
    for (const marker of animation.markers) markers.push({ ...marker, at: start + marker.at });
    if (chapter.pause) markers.push({ at: end, pause: true });
    cursor = boundary;
  }
  const byTime = new Map<number, BoardAnimation["markers"][number]>();
  for (const marker of markers) {
    const previous = byTime.get(marker.at);
    byTime.set(marker.at, { ...previous, ...marker, pause: Boolean(previous?.pause || marker.pause) });
  }
  return {
    duration: cursor,
    play: "manual",
    end: "hold",
    delay: 0,
    loop: false,
    tracks,
    markers: [...byTime.values()].sort((a, b) => a.at - b.at),
  };
}

export function boardSequencePatch(document: BoardDocument, id: string, chapters: readonly BoardChapter[]): BoardPatch {
  BoardIdSchema.parse(id);
  if (chapters.some((chapter) => chapter.animation === id)) throw new Error("A sequence cannot overwrite one of its source chapters.");
  const animation = boardSequence(document, chapters);
  const tracks: Record<string, BoardTrack | null> = { ...animation.tracks };
  for (const key of Object.keys(document.animations[id]?.tracks ?? {})) {
    if (!(key in tracks)) tracks[key] = null;
  }
  const patch: BoardPatch = { animations: { [id]: { ...animation, tracks } } };
  const result = applyBoardPatchToDocument(document, patch);
  if (!result.ok) throw new Error(result.diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join("; "));
  return patch;
}

export function boardPlacePatch(
  document: BoardDocument,
  id: string,
  targets: readonly string[],
  placement: BoardTimelinePlacement & { together?: boolean },
): BoardPatch {
  BoardIdSchema.parse(id);
  const existing = document.animations[id];
  let animation: BoardAnimation = existing ?? { duration: 1, play: "manual", delay: 0, loop: false, end: "hold", markers: [], tracks: {} };
  let at = placement.at;
  for (const target of targets) {
    if (target === id || (!document.items[target] && !document.animations[target])) throw new Error(`${target} is not an item or animation on this Board.`);
    animation = boardPlaceTarget(document, animation, target, { ...placement, at });
    if (!placement.together) at = boardTargetSpan(document, animation, target)?.end ?? at;
  }
  const tracks = Object.fromEntries(Object.entries(animation.tracks).filter(([key, track]) => existing?.tracks[key] !== track));
  const patch: BoardPatch = { animations: { [id]: existing ? { duration: animation.duration, tracks } : { ...animation, tracks } } };
  const result = applyBoardPatchToDocument(document, patch);
  if (!result.ok) throw new Error(result.diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join("; "));
  return patch;
}

export function boardPathTrack(
  target: string,
  points: readonly BoardVec2[],
  options: { duration: number; at?: number; samples?: number; orient?: boolean },
): BoardTrack {
  const { duration, at = 0, samples = 64, orient = false } = options;
  if (points.length < 2 || points.length > 10000 || points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)))
    throw new Error("A path needs 2 to 10000 finite points.");
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(at) || at < 0)
    throw new Error("Path duration must be positive and start time non-negative.");
  if (!Number.isInteger(samples) || samples < 2 || samples > 10000)
    throw new Error("Path samples must be an integer from 2 to 10000.");
  const segments: Array<{ a: BoardVec2; b: BoardVec2; start: number; end: number }> = [];
  let total = 0;
  let previous = points[0];
  for (const point of points.slice(1)) {
    if (!previous) break;
    const start = total;
    total += Math.hypot(point.x - previous.x, point.y - previous.y);
    segments.push({ a: previous, b: point, start, end: total });
    previous = point;
  }
  const distances = [
    ...new Set([
      ...segments.map((segment) => segment.end),
      ...Array.from({ length: samples }, (_, index) => (total * index) / (samples - 1)),
    ]),
  ].sort((a, b) => a - b);
  let segmentIndex = 0;
  const keyframes: BoardKeyframe[] = distances.map((distance) => {
    const progress = total > 0 ? distance / total : 0;
    while (segmentIndex < segments.length - 1 && (segments[segmentIndex]?.end ?? 0) < distance) segmentIndex++;
    const segment = segments[segmentIndex];
    if (!segment) throw new Error("Path has no segments.");
    const { a, b, start, end } = segment;
    const fraction = end > start ? (distance - start) / (end - start) : 0;
    return {
      at: at + duration * progress,
      value: { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction },
    };
  });
  return { target, property: "position", composite: "replace", interpolation: "auto", orient, keyframes };
}
