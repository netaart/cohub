import { isUuid, isUuidOrShortUuid } from "@cohub/protocol/identifiers";
import { isReservedPublicIdentifier, parseSpaceSlug, parseUsername } from "@cohub/protocol/public-identifiers";

export type SpaceRef =
  | { kind: "id"; id: string }
  | { kind: "public"; username: string; slug: string }
  | { kind: "owned"; slug: string };

const canonicalUuid = (value: string) => {
  const hex = value.replaceAll("-", "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** `https://<host>/spaces/<id>/...`, `https://<host>/<username>/<slug>/...`, or `cohub://spaces/<id>/...`. */
function parseSpaceUrl(value: string): SpaceRef | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const path = url.pathname.split("/").filter(Boolean);
  const segments = url.protocol === "cohub:" ? [url.hostname, ...path] : url.protocol.startsWith("http") ? path : [];
  const [first = "", second = ""] = segments.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  if (first === "spaces") return isUuid(second) ? { kind: "id", id: second.toLowerCase() } : null;
  if (url.protocol === "cohub:") return null;
  const username = parseUsername(first);
  const slug = parseSpaceSlug(second);
  if (!username || !slug || isReservedPublicIdentifier("username", username)) return null;
  return { kind: "public", username, slug };
}

export function parseSpaceRef(value: string): SpaceRef | null {
  const trimmed = value.trim();
  if (isUuidOrShortUuid(trimmed)) return { kind: "id", id: canonicalUuid(trimmed) };
  if (trimmed.includes("://")) return parseSpaceUrl(trimmed);
  const parts = trimmed.split("/");
  if (parts.length === 2) {
    const username = parseUsername(parts[0]);
    const slug = parseSpaceSlug(parts[1]);
    return username && slug ? { kind: "public", username, slug } : null;
  }
  const slug = parts.length === 1 ? parseSpaceSlug(trimmed) : null;
  return slug ? { kind: "owned", slug } : null;
}
