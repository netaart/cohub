import type { SpaceListSpace } from "./space-list";
import type { RemoteSpaceSearchHit } from "./session-search";

/**
 * Composer @mentions, ported from the Cohub web composer. Drafts store mention
 * markup (`@[Label](cohub://spaces/<id>)`) exactly as the server parses it; the
 * native input only shows `@Label`, so edits are mapped from display text back
 * onto the markup.
 */

export type TextSelection = { start: number; end: number };
export type SpaceMentionTrigger = { start: number; end: number; query: string };
export type SpaceMentionSuggestion = { spaceId: string; name: string | null; description: string | null; avatarUrl: string | null };

export type CohubResourceLink =
  | { kind: "space"; spaceId: string; sessionId?: string }
  | { kind: "app"; username: string; spaceSlug: string; appSlug: string; launchSuffix: string };
export type CohubLinkMatch = { start: number; end: number; raw: string; link: CohubResourceLink };

type ComposerSegment = { mention: boolean; markup: string; display: string };

const TRIGGER_SCAN_LIMIT = 96;
const SUGGESTION_LIMIT = 50;
const MENTION_PATTERN = /@\[([^\]\n]+)\]\((cohub:\/\/(?:spaces|apps)\/[^\s)]+)\)/g;
const BOUNDARY_CHARS = "\\s([{<:,;!?，。！？、；：";
const BOUNDARY = new RegExp(`[${BOUNDARY_CHARS}]`);
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const USERNAME = /^(?!-)(?!.*--)[a-z0-9-]{1,39}(?<!-)$/;
const SLUG = /^[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?$/;
// Keep in sync with message-links.ts; both modules stay import-free for the workflow checks.
export const COHUB_WEB_ORIGIN_SOURCE = "(?:https?:\\/\\/(?:dev\\.|www\\.)?cohub\\.(?:live|run)|https?:\\/\\/localhost(?::\\d+)?)";
const PATH_END = "(?![a-zA-Z0-9_%/-]|\\.[a-zA-Z0-9])";
const SPACE_PATH = `\\/spaces\\/(${UUID})(?:\\/sessions\\/(${UUID}))?(?:[?#][^\\s)\\]]*)?${PATH_END}`;
const APP_PATH = `\\/([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\\/([a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?)\\/w\\/([a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?)((?:[?#][^\\s)\\]]*)?)${PATH_END}`;
const SPACE_LINK = new RegExp(`${COHUB_WEB_ORIGIN_SOURCE}${SPACE_PATH}|(^|[${BOUNDARY_CHARS}])${SPACE_PATH}`, "g");
const APP_LINK = new RegExp(`${COHUB_WEB_ORIGIN_SOURCE}${APP_PATH}|(^|[${BOUNDARY_CHARS}])${APP_PATH}`, "gi");

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function appIdentity(username: string, spaceSlug: string, appSlug: string) {
  const user = safeDecode(username).trim().toLowerCase();
  const space = safeDecode(spaceSlug).trim();
  const app = safeDecode(appSlug).trim();
  return USERNAME.test(user) && SLUG.test(space) && SLUG.test(app) ? { username: user, spaceSlug: space, appSlug: app } : null;
}

function isMentionUri(uri: string) {
  if (uri.startsWith("cohub://spaces/")) {
    const path = uri.slice("cohub://spaces/".length).split("/").map((part) => safeDecode(part).trim());
    return Boolean(path[0]) && (path.length === 1 || (path.length === 3 && path[1] === "sessions" && Boolean(path[2])));
  }
  const value = uri.slice("cohub://apps/".length);
  const suffix = value.search(/[?#]/);
  const path = (suffix >= 0 ? value.slice(0, suffix) : value).split("/");
  return path.length === 3 && appIdentity(path[0]!, path[1]!, path[2]!) !== null;
}

function mentionLabel(label: string) {
  return label.replace(/[[\]\\]/g, "").replace(/\s+/g, " ").trim();
}

export function buildSpaceMentionMarkdown(input: { spaceId: string; sessionId?: string; label: string }) {
  const label = mentionLabel(input.label) || `space:${input.spaceId.slice(0, 8)}`;
  const uri = `cohub://spaces/${encodeURIComponent(input.spaceId)}${input.sessionId ? `/sessions/${encodeURIComponent(input.sessionId)}` : ""}`;
  return `@[${label}](${uri})`;
}

export function buildAppMentionMarkdown(input: { username: string; spaceSlug: string; appSlug: string; launchSuffix: string; label: string }) {
  const label = mentionLabel(input.label) || input.appSlug;
  return `@[${label}](cohub://apps/${encodeURIComponent(input.username)}/${encodeURIComponent(input.spaceSlug)}/${encodeURIComponent(input.appSlug)}${input.launchSuffix})`;
}

export function cohubLinkKey(link: CohubResourceLink) {
  if (link.kind === "app") return `app:${link.username}/${link.spaceSlug}/${link.appSlug}`;
  return link.sessionId ? `space:${link.spaceId}/sessions/${link.sessionId}` : `space:${link.spaceId}`;
}

function composerSegments(markup: string): ComposerSegment[] {
  const segments: ComposerSegment[] = [];
  let cursor = 0;
  for (const match of markup.matchAll(MENTION_PATTERN)) {
    const index = match.index ?? 0;
    const label = match[1]?.trim() ?? "";
    if ((index > 0 && !BOUNDARY.test(markup[index - 1] ?? "")) || !label || !isMentionUri(match[2] ?? "")) continue;
    if (index > cursor) segments.push({ mention: false, markup: markup.slice(cursor, index), display: markup.slice(cursor, index) });
    segments.push({ mention: true, markup: match[0], display: `@${label}` });
    cursor = index + match[0].length;
  }
  if (cursor < markup.length) segments.push({ mention: false, markup: markup.slice(cursor), display: markup.slice(cursor) });
  return segments;
}

/** Text shown in the native input: each mention collapses to `@Label`. */
export function mentionDisplayText(markup: string) {
  return composerSegments(markup).map((segment) => segment.display).join("");
}

/**
 * Space mentions in a draft, shaped like the web composer's `_meta.mentions`.
 * Work mentions stay text-only there too.
 */
export function extractSpaceMentions(markup: string) {
  const mentions = new Map<string, { type: "space"; spaceId: string; sessionId?: string; label: string; uri: string; href: string }>();
  for (const segment of composerSegments(markup)) {
    const uri = segment.mention ? /\((cohub:\/\/spaces\/[^\s)]+)\)$/.exec(segment.markup)?.[1] : undefined;
    if (!uri) continue;
    const [spaceId = "", , sessionId] = uri.slice("cohub://spaces/".length).split("/").map((part) => safeDecode(part).trim());
    const key = sessionId ? `${spaceId}/sessions/${sessionId}` : spaceId;
    if (mentions.has(key)) continue;
    const path = `${encodeURIComponent(spaceId)}${sessionId ? `/sessions/${encodeURIComponent(sessionId)}` : ""}`;
    mentions.set(key, { type: "space", spaceId, ...(sessionId ? { sessionId } : {}), label: segment.display.slice(1), uri: `cohub://spaces/${path}`, href: `/spaces/${path}` });
  }
  return [...mentions.values()];
}

/** `@Label` → mention markup for every mention in the draft. */
export function draftMentions(markup: string): Map<string, string> {
  return new Map(composerSegments(markup).filter((segment) => segment.mention).map((segment) => [segment.display, segment.markup]));
}

/**
 * Native copy only carries the visible `@Label`, so a paste of that text turns
 * back into the mention it came from. Display text is unchanged, so the native
 * caret stays put.
 */
export function restoreDraftMentions(markup: string, range: TextSelection, known: ReadonlyMap<string, string>) {
  if (known.size === 0) return markup;
  // Longest labels first so "@Design Studio" wins over "@Design".
  const labels = [...known.keys()].sort((left, right) => right.length - left.length);
  const pattern = new RegExp(`(?:${labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}_])`, "gu");
  let next = "";
  let offset = 0;
  for (const segment of composerSegments(markup)) {
    const start = offset;
    offset += segment.markup.length;
    next += segment.mention || offset < range.start || start > range.end
      ? segment.markup
      : segment.markup.replace(pattern, (label: string, index: number) => {
        const at = start + index;
        // The boundary is checked against the whole draft: a segment can start right after a mention's `)`.
        const bounded = at === 0 || BOUNDARY.test(markup[at - 1] ?? "");
        return bounded && at < range.end && at + label.length > range.start ? known.get(label)! : label;
      });
  }
  return next;
}

function mentionDisplayRanges(segments: readonly ComposerSegment[]) {
  const ranges: TextSelection[] = [];
  let position = 0;
  for (const segment of segments) {
    if (segment.mention) ranges.push({ start: position, end: position + segment.display.length });
    position += segment.display.length;
  }
  return ranges;
}

function rebuildMarkup(segments: readonly ComposerSegment[], start: number, end: number, inserted: string, degrade: (range: TextSelection) => boolean) {
  let before = "";
  let after = "";
  let position = 0;
  for (const segment of segments) {
    const range = { start: position, end: position + segment.display.length };
    position = range.end;
    if (segment.mention && !degrade(range)) {
      if (range.end <= start) before += segment.markup;
      else after += segment.markup;
      continue;
    }
    // Plain text and degraded mentions share display and markup offsets.
    before += segment.display.slice(0, Math.max(0, start - range.start));
    after += segment.display.slice(Math.max(0, end - range.start));
  }
  return { markup: before + inserted + after, insertedStart: before.length };
}

/**
 * Maps a native edit of the display text onto the markup. A mention the edit
 * cuts into (or detaches from its leading boundary) becomes its plain `@Label`
 * text, so the display always matches what the native input already shows.
 */
export function applyComposerDisplayEdit(markup: string, nextDisplay: string) {
  const segments = composerSegments(markup);
  const previous = segments.map((segment) => segment.display).join("");
  if (previous === nextDisplay) return { markup, insertedStart: markup.length, insertedText: "" };
  const shortest = Math.min(previous.length, nextDisplay.length);
  let start = 0;
  while (start < shortest && previous[start] === nextDisplay[start]) start += 1;
  let suffix = 0;
  while (suffix < shortest - start && previous[previous.length - 1 - suffix] === nextDisplay[nextDisplay.length - 1 - suffix]) suffix += 1;
  let end = previous.length - suffix;
  let inserted = nextDisplay.slice(start, nextDisplay.length - suffix);
  const mentions = mentionDisplayRanges(segments);
  const cuts = (range: TextSelection) => start === end ? range.start < start && start < range.end : range.start < end && range.end > start;
  // The common prefix can land inside a mention when the edit is ambiguous
  // ("@" typed before "@Name"); slide the edit left to keep the mention whole.
  while (start > 0 && mentions.some(cuts) && (inserted && start === end ? previous[start - 1] === inserted.at(-1) : !inserted && previous[start - 1] === previous[end - 1])) {
    if (inserted) inserted = previous[start - 1] + inserted.slice(0, -1);
    start -= 1;
    end -= 1;
  }
  const precedingChar = start > 0 || inserted ? (inserted.at(-1) ?? previous[start - 1] ?? "") : "";
  const detached = (range: TextSelection) => range.start === end && precedingChar !== "" && !BOUNDARY.test(precedingChar);
  const result = rebuildMarkup(segments, start, end, inserted, (range) => cuts(range) || detached(range));
  return { ...result, insertedText: inserted };
}

function displayToMarkupOffset(segments: readonly ComposerSegment[], offset: number) {
  let display = 0;
  let markup = 0;
  for (const segment of segments) {
    if (offset <= display + segment.display.length) return segment.mention ? markup + (offset === display ? 0 : segment.markup.length) : markup + offset - display;
    display += segment.display.length;
    markup += segment.markup.length;
  }
  return markup;
}

export function detectSpaceMentionTrigger(markup: string, selection: TextSelection): SpaceMentionTrigger | null {
  const display = mentionDisplayText(markup);
  const cursor = selection.start;
  if (cursor !== selection.end || cursor < 0 || cursor > display.length) return null;
  const match = /(^|\s)@([^@\s[\]()]{0,80})$/.exec(display.slice(Math.max(0, cursor - TRIGGER_SCAN_LIMIT), cursor));
  if (!match) return null;
  const query = match[2] ?? "";
  const start = cursor - query.length - 1;
  if (mentionDisplayRanges(composerSegments(markup)).some((range) => range.start <= start && start < range.end)) return null;
  return { start, end: cursor, query };
}

/** Replaces the active `@query` with a Space mention; returns the display caret after it. */
export function insertSpaceMention(markup: string, trigger: SpaceMentionTrigger, space: { spaceId: string; label: string }) {
  const segments = composerSegments(markup);
  const start = displayToMarkupOffset(segments, trigger.start);
  const end = displayToMarkupOffset(segments, trigger.end);
  const rest = markup.slice(end);
  const spacer = /^\s/.test(rest) ? "" : " ";
  const head = `${markup.slice(0, start)}${buildSpaceMentionMarkdown(space)}${spacer}`;
  // The caret always lands after one space, reusing whitespace that follows.
  return { markup: head + rest, caret: mentionDisplayText(head).length + (spacer ? 0 : 1) };
}

/** Cohub web links in plain text that overlap `range`; existing mentions are skipped. */
export function findCohubLinks(markup: string, range: TextSelection): CohubLinkMatch[] {
  const matches: CohubLinkMatch[] = [];
  let offset = 0;
  for (const segment of composerSegments(markup)) {
    const segmentStart = offset;
    offset += segment.markup.length;
    if (segment.mention || offset < range.start || segmentStart > range.end) continue;
    for (const match of segment.markup.matchAll(SPACE_LINK)) {
      const prefix = match[3] ?? "";
      const spaceId = match[1] ?? match[4];
      const sessionId = match[2] ?? match[5];
      if (!spaceId) continue;
      const start = segmentStart + (match.index ?? 0) + prefix.length;
      matches.push({ start, end: start + match[0].length - prefix.length, raw: match[0].slice(prefix.length), link: { kind: "space", spaceId, ...(sessionId ? { sessionId } : {}) } });
    }
    for (const match of segment.markup.matchAll(APP_LINK)) {
      const prefix = match[5] ?? "";
      const identity = appIdentity(match[1] ?? match[6] ?? "", match[2] ?? match[7] ?? "", match[3] ?? match[8] ?? "");
      if (!identity) continue;
      const start = segmentStart + (match.index ?? 0) + prefix.length;
      matches.push({ start, end: start + match[0].length - prefix.length, raw: match[0].slice(prefix.length), link: { kind: "app", ...identity, launchSuffix: match[4] ?? match[9] ?? "" } });
    }
  }
  return matches.filter((match) => match.start < range.end && match.end > range.start).sort((left, right) => left.start - right.start);
}

/** Converts matched links with a known label to mentions; unresolved links stay as pasted text. */
export function replaceCohubLinks(markup: string, matches: readonly CohubLinkMatch[], labelFor: (link: CohubResourceLink) => string | null | undefined) {
  let next = markup;
  for (const match of [...matches].sort((left, right) => right.start - left.start)) {
    const label = labelFor(match.link);
    if (!label || next.slice(match.start, match.end) !== match.raw) continue;
    const mention = match.link.kind === "app" ? buildAppMentionMarkdown({ ...match.link, label }) : buildSpaceMentionMarkdown({ ...match.link, label });
    next = next.slice(0, match.start) + mention + next.slice(match.end);
  }
  return next;
}

function normalizeSearchText(value: string | null | undefined) {
  return (value ?? "").toLowerCase().normalize("NFKC").replace(/[\s_-]+/g, " ").trim();
}

function subsequenceScore(text: string, query: string) {
  let index = 0;
  let streak = 0;
  let score = 0;
  for (let position = 0; position < text.length && index < query.length; position += 1) {
    if (text[position] !== query[index]) {
      streak = 0;
      continue;
    }
    index += 1;
    streak += 1;
    score += 1 + Math.min(streak, 5) * 0.15;
  }
  if (index < query.length) return 0;
  return Math.min(0.68, score / Math.max(text.length, query.length) + 0.22);
}

/** Same fuzzy tiers as the web palette: exact, prefix, word, substring, then subsequence. */
export function textMatchScore(text: string | null | undefined, query: string) {
  const haystack = normalizeSearchText(text);
  const needle = normalizeSearchText(query);
  if (!haystack || !needle) return 0;
  if (haystack === needle) return 1;
  if (haystack.startsWith(needle)) return 0.92;
  if (haystack.includes(` ${needle}`)) return 0.84;
  if (haystack.includes(needle)) return 0.74;
  return subsequenceScore(haystack, needle);
}

function localSuggestion(space: SpaceListSpace): SpaceMentionSuggestion {
  return { spaceId: space.id, name: space.name?.trim() || space.title?.trim() || null, description: space.description?.trim() || null, avatarUrl: space.publicProfile?.avatarUrl ?? null };
}

/**
 * Mirrors the Spaces tab: an empty query keeps the Recent order (then the rest
 * by activity). A typed query ranks the viewer's Spaces by match quality, ties
 * keeping Recent order, and appends server-only hits after them.
 */
export function selectSpaceMentionSuggestions(input: {
  recent: readonly SpaceListSpace[];
  spaces: readonly SpaceListSpace[];
  remote: readonly RemoteSpaceSearchHit[];
  query: string;
  currentSpaceId: string | null;
}): SpaceMentionSuggestion[] {
  const local = new Map<string, SpaceMentionSuggestion>();
  for (const space of [...input.recent, ...input.spaces]) {
    if (space.id !== input.currentSpaceId && !local.has(space.id)) local.set(space.id, localSuggestion(space));
  }
  const query = input.query.trim();
  if (!query) return [...local.values()].slice(0, SUGGESTION_LIMIT);
  const matches = [...local.values()]
    .map((item) => ({ item, score: Math.max(textMatchScore(item.name, query), textMatchScore(item.description, query) * 0.6) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.item);
  const remote = input.remote
    .filter((hit) => hit.spaceId !== input.currentSpaceId && !local.has(hit.spaceId))
    .map((hit) => ({ spaceId: hit.spaceId, name: hit.title, description: hit.description, avatarUrl: hit.avatarUrl }));
  return [...matches, ...remote].slice(0, SUGGESTION_LIMIT);
}
