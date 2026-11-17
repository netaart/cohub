import { EARSHOT } from "../camp/world.ts";

export type MediaCandidate = { participantId: string; name: string; kind: "audio" | "video" };
export type MediaPosition = { distance: number; visible: boolean; hearing?: number };
export type CameraQuality = "low" | "medium" | "high";
export const CAMERA_RANGE = 720;
export const CAMERA_LIMIT = 4;
export const MEDIA_LIMIT = 16;
export const mediaKey = (candidate: MediaCandidate) => `${candidate.participantId}:${candidate.name}`;

export function selectCampMedia(candidates: readonly MediaCandidate[], position: (id: string) => MediaPosition | null) {
  const located = candidates.map((candidate) => ({ candidate, at: position(candidate.participantId) }))
    .sort((a, b) => (a.at?.distance ?? Infinity) - (b.at?.distance ?? Infinity) || mediaKey(a.candidate).localeCompare(mediaKey(b.candidate)));
  const voice = located.filter(({ candidate, at }) => candidate.kind === "audio" && (!at || (at.hearing ?? at.distance) < EARSHOT * 1.1))
    .slice(0, MEDIA_LIMIT);
  const video = located.filter(({ candidate, at }) => candidate.kind === "video" && candidate.name === "cam" && at?.visible && at.distance < CAMERA_RANGE)
    .slice(0, Math.min(CAMERA_LIMIT, MEDIA_LIMIT - voice.length));
  return new Set([...voice, ...video].map(({ candidate }) => mediaKey(candidate)));
}

export const cameraQuality = (distance: number): CameraQuality => distance < 220 ? "high" : distance < 440 ? "medium" : "low";
