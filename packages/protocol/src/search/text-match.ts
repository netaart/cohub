export type SearchTextRange = [start: number, end: number];

export type SearchExcerpt = {
  text: string;
  highlights: SearchTextRange[];
};

const MAX_HIGHLIGHTS = 8;
const EXCERPT_LEAD_COLUMNS = 8;
const EXCERPT_LENGTH = 120;
const WORD_CHAR = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}_]/u;
const WIDE_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Emoji_Presentation}\u3000-\u303f\uff00-\uffef]/u;
const RESOURCE_MENTION = /@\[([^\]\n]+)\]\(cohub:\/\/(?:spaces|apps)\/[^\s)]+\)/g;

export function collapseSearchWhitespace(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function toSearchDisplayText(value: string | null | undefined): string {
  return collapseSearchWhitespace((value ?? "").replace(RESOURCE_MENTION, (_, label: string) => `@${label.trim()}`));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLowSurrogate(text: string, index: number) {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

function leadStart(text: string, end: number, columns: number) {
  let start = end;
  let used = 0;
  while (start > 0) {
    const size = start > 1 && isLowSurrogate(text, start - 1) ? 2 : 1;
    const char = text.slice(start - size, start);
    const width = WIDE_CHAR.test(char) ? 2 : 1;
    if (used + width > columns) break;
    used += width;
    start -= size;
  }
  return start;
}

let lastPattern: { needle: string; pattern: RegExp } | null = null;

function patternFor(needle: string) {
  if (lastPattern?.needle !== needle) {
    lastPattern = { needle, pattern: new RegExp(escapeRegExp(needle).replace(/ /g, "\\s+"), "giu") };
  }
  return lastPattern.pattern;
}

export function findSearchMatches(text: string, query: string, limit = MAX_HIGHLIGHTS): SearchTextRange[] {
  const needle = collapseSearchWhitespace(query);
  if (!text || !needle) return [];
  const ranges: SearchTextRange[] = [];
  for (const match of text.matchAll(patternFor(needle))) {
    ranges.push([match.index, match.index + match[0].length]);
    if (ranges.length >= limit) break;
  }
  return ranges;
}

export function buildSearchExcerpt(
  source: string | null | undefined,
  query: string,
  options?: { clippedStart?: boolean; clippedEnd?: boolean },
): SearchExcerpt | null {
  const text = toSearchDisplayText(source);
  if (!text) return null;
  const matchStart = findSearchMatches(text, query, 1)[0]?.[0] ?? 0;
  let start = leadStart(text, matchStart, EXCERPT_LEAD_COLUMNS);
  if (start > 0 && WORD_CHAR.test(text[start - 1] ?? "") && WORD_CHAR.test(text[start] ?? "")) {
    const nextWord = text.indexOf(" ", start) + 1;
    if (nextWord > 0 && nextWord <= matchStart) start = nextWord;
  }
  let end = Math.min(text.length, start + EXCERPT_LENGTH);
  if (end < text.length && isLowSurrogate(text, end)) end += 1;
  const prefix = options?.clippedStart || start > 0 ? "…" : "";
  const suffix = options?.clippedEnd || end < text.length ? "…" : "";
  const excerpt = `${prefix}${text.slice(start, end)}${suffix}`;
  return { text: excerpt, highlights: findSearchMatches(excerpt, query) };
}
