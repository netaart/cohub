/**
 * Origins serving the Cohub web app, as a group-free RegExp source. cohub.live is
 * primary; cohub.run links from before the domain migration still resolve. Kept in
 * sync with space-mentions.ts, which parses the same links in the composer.
 */
export const COHUB_WEB_ORIGIN_SOURCE = "(?:https?:\\/\\/(?:dev\\.|www\\.)?cohub\\.(?:live|run)|https?:\\/\\/localhost(?::\\d+)?)";
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const COHUB_SPACE_URI = new RegExp(`^cohub://spaces/(${UUID})(?:/sessions/(${UUID}))?/?$`);
const COHUB_WEB_SPACE = new RegExp(`^${COHUB_WEB_ORIGIN_SOURCE}?/spaces/(${UUID})(?:/sessions/(${UUID}))?(?:[?#].*)?$`);
const COHUB_APP_URI = /^cohub:\/\/apps\/([^/?#\s]+)\/([^/?#\s]+)\/([^/?#\s]+)([?#]\S*)?$/;

export type ResolvedMessageLink =
  | { kind: "session"; spaceId: string; sessionId: string }
  | { kind: "space"; spaceId: string }
  | { kind: "file"; path: string }
  | { kind: "external"; url: string };

/**
 * Message markdown mixes three URL families: Cohub mentions (`cohub://spaces/…`, `cohub://apps/…`),
 * Cohub web URLs, and sandbox paths (`/workspace/...`) that only make sense
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
  // Work mentions have no native slug route; open the published page instead.
  const app = COHUB_APP_URI.exec(trimmed);
  if (app) return { kind: "external", url: `https://cohub.live/${app[1]}/${app[2]}/w/${app[3]}${app[4] ?? ""}` };
  if (trimmed.startsWith("/")) return { kind: "file", path: trimmed };
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) return { kind: "external", url: trimmed };
  return null;
}
