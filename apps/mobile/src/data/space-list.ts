import type { PaletteOverviewResponse, SpaceRecord, UserSessionListItem } from "@neta-art/cohub";

export type SpaceFilter = "recent" | "all" | "pinned";
export type SpaceListSpace = Pick<SpaceRecord, "id" | "name" | "description" | "isPinned"> & Partial<Pick<SpaceRecord, "title" | "status" | "publicProfile" | "lastActivityAt" | "updatedAt" | "createdAt">>;
export type SpaceVisit = { spaceId: string; timestamp: number };
export const SPACE_VISIT_MAX_AGE_MS = 90 * 86_400_000;

export function recentSpaceVisits(visits: readonly SpaceVisit[], now: number): SpaceVisit[] {
  const byId = new Map<string, SpaceVisit>();
  for (const visit of visits) {
    if (!visit.spaceId.trim() || !Number.isFinite(visit.timestamp)) throw new Error("Invalid Space visit: expected a Space ID and finite timestamp.");
    if (now - visit.timestamp > SPACE_VISIT_MAX_AGE_MS) continue;
    if (visit.timestamp > (byId.get(visit.spaceId)?.timestamp ?? 0)) byId.set(visit.spaceId, visit);
  }
  return [...byId.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);
}

function time(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function selectSpaceList(input: {
  spaces: readonly SpaceRecord[];
  sessions: readonly UserSessionListItem[];
  overview: PaletteOverviewResponse | null;
  visits: readonly SpaceVisit[];
  personalActivity: ReadonlyMap<string, number>;
  filter: SpaceFilter;
  now: number;
}): SpaceListSpace[] {
  const visits = new Map(recentSpaceVisits(input.visits, input.now).map((visit) => [visit.spaceId, visit.timestamp]));
  if (input.filter === "pinned") return input.spaces.filter((space) => space.isPinned === true);
  if (input.filter === "recent") {
    const known = new Map(input.spaces.map((space) => [space.id, space]));
    return (input.overview?.spaces ?? []).map((space) => ({
      space: {
        ...known.get(space.id),
        id: space.id,
        name: space.name,
        description: space.description,
        isPinned: known.get(space.id)?.isPinned ?? space.isPinned,
      },
      activity: Math.max(time(space.lastParticipatedAt), visits.get(space.id) ?? 0, input.personalActivity.get(space.id) ?? 0),
    })).sort((a, b) => b.activity - a.activity).map((item) => item.space);
  }
  const sessionActivity = new Map<string, number>();
  for (const session of input.sessions) {
    sessionActivity.set(session.spaceId, Math.max(sessionActivity.get(session.spaceId) ?? 0, time(session.lastMessageAt ?? session.updatedAt ?? session.createdAt)));
  }
  const activity = (space: SpaceRecord) => Math.max(visits.get(space.id) ?? 0, sessionActivity.get(space.id) ?? 0, time(space.lastActivityAt ?? space.updatedAt ?? space.createdAt));
  return [...input.spaces].sort((a, b) => activity(b) - activity(a));
}
