const OPEN_FENCE = /^\s*```\s*([^\s`]*)?\s*$/;
const CLOSE_FENCE = /^\s*```\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]\s+|[0-9]+[.)]\s+)/;

export type StreamingMarkdownSplit = { stable: string; tail: string };

function isListItem(line: string) {
  return LIST_ITEM.test(line);
}

/**
 * Split streamed Markdown at the last boundary whose prefix is final, so the
 * renderer can parse the prefix once and only re-parse the tail.
 *
 * A blank line is a boundary only outside a fence and only when it does not sit
 * between two list items: a loose list split in half would restart numbering.
 * Passing the previous split makes an append cost O(tail) instead of O(source).
 */
export function splitStreamingMarkdown(source: string, previous?: StreamingMarkdownSplit | null): StreamingMarkdownSplit {
  const resume = previous && source.startsWith(previous.stable) && source.startsWith(previous.tail, previous.stable.length)
    ? previous.stable.length
    : 0;
  let lastContent = "";
  if (resume > 0) {
    const stableLines = source.slice(0, resume).split("\n");
    for (let index = stableLines.length - 1; index >= 0; index -= 1) {
      if (stableLines[index]!.trim()) {
        lastContent = stableLines[index]!;
        break;
      }
    }
  }
  let boundary = resume;
  let offset = resume;
  let fence = false;
  const lines = source.slice(resume).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    offset += line.length + 1;
    if (fence ? CLOSE_FENCE.test(line) : OPEN_FENCE.test(line)) {
      fence = !fence;
      lastContent = line;
      continue;
    }
    if (fence) {
      if (line.trim()) lastContent = line;
      continue;
    }
    if (line.trim()) {
      lastContent = line;
      continue;
    }
    const next = lines[index + 1];
    if (next === undefined || !next.trim()) continue;
    if (isListItem(lastContent) && isListItem(next)) continue;
    boundary = offset;
  }
  return { stable: source.slice(0, boundary), tail: source.slice(boundary) };
}
