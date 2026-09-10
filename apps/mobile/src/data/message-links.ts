const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const COHUB_SPACE_URI = new RegExp(`^cohub://spaces/(${UUID})(?:/sessions/(${UUID}))?/?$`);
const COHUB_WEB_SPACE = new RegExp(`^(?:https?://(?:www\\.)?cohub\\.live)?/spaces/(${UUID})(?:/sessions/(${UUID}))?(?:[?#].*)?$`);

export type ResolvedMessageLink =
  | { kind: "session"; spaceId: string; sessionId: string }
  | { kind: "space"; spaceId: string }
  | { kind: "file"; path: string }
  | { kind: "external"; url: string };

/**
 * Message markdown mixes three URL families: Cohub mentions (`cohub://spaces/…`),
 * cohub.live web URLs, and sandbox paths (`/workspace/...`) that only make sense
 * inside the Space that produced them. Anything else opens in the system browser.
 */
export function resolveMessageLink(url: string): ResolvedMessageLink | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const uri = COHUB_SPACE_URI.exec(trimmed) ?? COHUB_WEB_SPACE.exec(trimmed);
  if (uri) {
    const [, spaceId, sessionId] = uri;
    return sessionId ? { kind: "session", spaceId: spaceId!, sessionId } : { kind: "space", spaceId: spaceId! };
  }
  if (trimmed.startsWith("/")) return { kind: "file", path: trimmed };
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) return { kind: "external", url: trimmed };
  return null;
}
