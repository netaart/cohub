import { markdownBlockSignature, parseMarkdown, type MarkdownBlock } from "./markdown";
import { splitStreamingMarkdown, type StreamingMarkdownSplit } from "./stream-markdown";

export type MarkdownBlockEntry = { block: MarkdownBlock; signature: string };

export function parseMarkdownEntries(source: string): MarkdownBlockEntry[] {
  return parseMarkdown(source).map((block) => ({ block, signature: markdownBlockSignature(block) }));
}

/**
 * Incremental Markdown projection for one streaming item. Boundaries only move
 * forward, so a moved boundary parses just the newly completed chunk and
 * appends it; only the tail re-parses per commit. A rewrite restarts the cache.
 * Calling `update` twice with the same source is idempotent, which keeps it safe
 * under React's double-invoked renders.
 */
export class StreamingMarkdownCache {
  private previous: StreamingMarkdownSplit | null = null;
  private stable = "";
  private entries: MarkdownBlockEntry[] = [];
  private streamed = false;

  get hasStreamed() {
    return this.streamed;
  }

  update(source: string): { entries: MarkdownBlockEntry[]; tail: string } {
    this.streamed = true;
    const split = splitStreamingMarkdown(source, this.previous);
    this.previous = split;
    if (split.stable !== this.stable) {
      this.entries = split.stable.startsWith(this.stable)
        ? [...this.entries, ...parseMarkdownEntries(split.stable.slice(this.stable.length))]
        : parseMarkdownEntries(split.stable);
      this.stable = split.stable;
    }
    return { entries: this.entries, tail: split.tail };
  }
}
