import { type CampEvent, EVENTS, readSnapshot } from "./protocol.ts";
import { type CampState, decodeSnapshot, emptyCamp, foldCamp } from "./state.ts";

type Group = { upTo: number; first: number; parts: number; chunks: Map<number, string> };

export type CampHistory = readonly CampEvent[] & { truncated?: boolean };

export const restoreCamp = async (events: CampHistory): Promise<{ state: CampState; from: "start" | "snapshot"; upTo: number }> => {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const groups = new Map<string, Group>();
  for (const event of ordered) {
    if (event.type !== EVENTS.snapshot) continue;
    const part = readSnapshot(event.data);
    if (!part || part.upTo >= event.sequence) continue;
    const group = groups.get(part.key) ?? { upTo: part.upTo, first: event.sequence, parts: part.parts, chunks: new Map<number, string>() };
    if (group.parts !== part.parts || group.upTo !== part.upTo) continue;
    group.chunks.set(part.part, part.data);
    groups.set(part.key, group);
  }
  const candidates = [...groups.values()]
    .filter((group) => group.chunks.size === group.parts)
    .sort((a, b) => b.upTo - a.upTo || a.first - b.first);
  for (const group of candidates) {
    const parts = Array.from({ length: group.parts }, (_, index) => group.chunks.get(index) ?? "");
    const restored = await decodeSnapshot(parts);
    if (!restored || restored.sequence !== group.upTo) continue;
    return { state: foldCamp(restored, ordered.filter((event) => event.sequence > group.upTo)), from: "snapshot", upTo: group.upTo };
  }
  if (events.truncated || [...groups.values()].some((group) => group.upTo === 0)) {
    throw new Error("Camp history is incomplete. The previous cache has been preserved.");
  }
  return { state: foldCamp(emptyCamp(), ordered), from: "start", upTo: 0 };
};

export const hasCampHistory = (events: readonly CampEvent[]) =>
  events.some((event) => event.type.startsWith("camp.") && event.type !== EVENTS.chat && event.type !== EVENTS.wood && event.type !== EVENTS.snapshot);
