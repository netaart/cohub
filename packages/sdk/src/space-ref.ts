import { isUuidOrShortUuid } from "@cohub/protocol/identifiers";
import { parseSpaceSlug, parseUsername } from "@cohub/protocol/public-identifiers";

export type SpaceRef =
  | { kind: "id"; id: string }
  | { kind: "public"; username: string; slug: string }
  | { kind: "owned"; slug: string };

const canonicalUuid = (value: string) => {
  const hex = value.replaceAll("-", "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export function parseSpaceRef(value: string): SpaceRef | null {
  const trimmed = value.trim();
  if (isUuidOrShortUuid(trimmed)) return { kind: "id", id: canonicalUuid(trimmed) };
  const parts = trimmed.split("/");
  if (parts.length === 2) {
    const username = parseUsername(parts[0]);
    const slug = parseSpaceSlug(parts[1]);
    return username && slug ? { kind: "public", username, slug } : null;
  }
  const slug = parts.length === 1 ? parseSpaceSlug(trimmed) : null;
  return slug ? { kind: "owned", slug } : null;
}
