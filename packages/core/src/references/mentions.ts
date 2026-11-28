import { parseSpaceSlug, parseUsername } from "@cohub/protocol";

/**
 * Structured parser for Cohub resource mentions embedded in turn text.
 *
 * Mentions are authored as markdown links with a `cohub://` URI, e.g.
 *   @[Core API](cohub://spaces/<spaceId>)
 *   @[Fork](cohub://spaces/<spaceId>/sessions/<sessionId>)
 *   @[Launch](cohub://apps/<username>/<spaceSlug>/<appSlug>)
 *   @[Ada](cohub://users/<userUuid>)
 *
 * Parsing is deterministic against this structured format \u2014 not fuzzy text
 * mining \u2014 so it reliably resolves down to session granularity.
 */

export type ParsedMention =
  | {
      type: "space";
      spaceId: string;
      sessionId?: string;
      label: string;
    }
  | {
      type: "user";
      userUuid: string;
      label: string;
    }
  | {
      type: "app";
      username: string;
      spaceSlug: string;
      appSlug: string;
      label: string;
    };

const SPACE_MENTION_PATTERN =
  /@\[([^\]\n]+)\]\(cohub:\/\/spaces\/([^/\s)]+)(?:\/sessions\/([^/\s)]+))?\)/g;
const APP_MENTION_PATTERN =
  /@\[([^\]\n]+)\]\(cohub:\/\/apps\/([^/\s)]+)\/([^/\s)]+)\/([^/?#\s)]+)(?:[?#][^\s)]*)?\)/g;

const USER_MENTION_PATTERN = /@\[([^\]\n]+)\]\(cohub:\/\/users\/([A-Za-z0-9_-]{1,128})\)/g;

const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Extract all structured resource mentions from a block of text. */
export const parseMentions = (text: string | null | undefined): ParsedMention[] => {
  if (!text) return [];
  const mentions: Array<ParsedMention & { index: number }> = [];
  for (const match of text.matchAll(SPACE_MENTION_PATTERN)) {
    const label = match[1]?.trim();
    const spaceId = safeDecode(match[2] ?? "").trim();
    const sessionId = safeDecode(match[3] ?? "").trim() || undefined;
    if (!spaceId) continue;
    mentions.push({ type: "space", spaceId, label: label || spaceId, ...(sessionId ? { sessionId } : {}), index: match.index ?? 0 });
  }
  for (const match of text.matchAll(APP_MENTION_PATTERN)) {
    const label = match[1]?.trim();
    const username = parseUsername(safeDecode(match[2] ?? ""));
    const spaceSlug = parseSpaceSlug(safeDecode(match[3] ?? ""));
    const appSlug = parseSpaceSlug(safeDecode(match[4] ?? ""));
    if (!username || !spaceSlug || !appSlug) continue;
    mentions.push({
      type: "app",
      username,
      spaceSlug,
      appSlug,
      label: label || appSlug,
      index: match.index ?? 0,
    });
  }
  for (const match of text.matchAll(USER_MENTION_PATTERN)) {
    const userUuid = match[2];
    if (!userUuid) continue;
    mentions.push({ type: "user", userUuid, label: match[1]?.trim() || userUuid, index: match.index ?? 0 });
  }
  return mentions
    .sort((left, right) => left.index - right.index)
    .map(({ index: _index, ...mention }) => mention);
};

export const formatMentionsForDisplay = (text: string) =>
  text.replace(/@\[([^\]\n]+)\]\(cohub:\/\/[^\s)]+\)/g, "@$1");
