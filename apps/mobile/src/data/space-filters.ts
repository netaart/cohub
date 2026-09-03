import type { SpaceRecord } from "@neta-art/cohub";

export type SpaceFilter = "recent" | "all" | "pinned";

export const SPACE_RECENT_LIMIT = 20;

export function filterSpaces(spaces: readonly SpaceRecord[], filter: SpaceFilter) {
  if (filter === "pinned") return spaces.filter((space) => space.isPinned === true);
  if (filter === "recent") {
    return [...spaces]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, SPACE_RECENT_LIMIT);
  }
  return [...spaces];
}
