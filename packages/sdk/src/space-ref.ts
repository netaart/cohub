import { isUuid } from "@cohub/protocol/identifiers";
import { parseSpaceSlug, parseUsername } from "@cohub/protocol/public-identifiers";

export type SpaceRef =
  | { kind: "id"; id: string }
  | { kind: "public"; username: string; slug: string }
  | { kind: "owned"; slug: string };

export function parseSpaceRef(value: string): SpaceRef | null {
  const trimmed = value.trim();
  if (isUuid(trimmed)) return { kind: "id", id: trimmed };
  const parts = trimmed.split("/");
  if (parts.length === 2) {
    const username = parseUsername(parts[0]);
    const slug = parseSpaceSlug(parts[1]);
    return username && slug ? { kind: "public", username, slug } : null;
  }
  const slug = parts.length === 1 ? parseSpaceSlug(trimmed) : null;
  return slug ? { kind: "owned", slug } : null;
}
