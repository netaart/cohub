import type { HighlighterCore, ThemedToken } from "shiki/core";

type GrammarState = NonNullable<ReturnType<HighlighterCore["codeToTokens"]>["grammarState"]>;

export type StreamingEnqueueResult = { stable: ThemedToken[][]; unstable: ThemedToken[] };

/**
 * Incremental Shiki tokenization for append-only code, such as an assistant reply still streaming.
 *
 * Complete lines are tokenized once with the carried grammar state and become stable; only the
 * trailing partial line is re-tokenized when the next chunk arrives, so re-tokenizing the document
 * per chunk is avoided. This mirrors the technique in `@shikijs/stream`, applied directly to
 * `@shikijs/core`: that package evaluates a class extending the browser `TransformStream` at module
 * scope, which Hermes cannot load.
 *
 * The caller owns the highlighter and must have loaded `language` into it.
 */
export class StreamingCodeTokenizer {
  private stableLines: ThemedToken[][] = [];
  private unstableLine: ThemedToken[] = [];
  private pendingLine = "";
  private grammarState: GrammarState | undefined;
  private foreground: string | undefined;
  private background: string | undefined;

  private readonly highlighter: HighlighterCore;
  private readonly language: string;
  private readonly theme: string;

  constructor(highlighter: HighlighterCore, language: string, theme: string) {
    this.highlighter = highlighter;
    this.language = language;
    this.theme = theme;
  }

  /** Feed the next chunk of code (append-only; call `clear` first if the text was rewritten). */
  enqueue(chunk: string): StreamingEnqueueResult {
    const parts = `${this.pendingLine}${chunk}`.split("\n");
    this.pendingLine = parts[parts.length - 1] ?? "";
    const stable: ThemedToken[][] = [];
    for (let index = 0; index < parts.length - 1; index += 1) {
      const tokens = this.tokenizeLine(parts[index] ?? "", true);
      this.stableLines.push(tokens);
      stable.push(tokens);
    }
    this.unstableLine = this.tokenizeLine(this.pendingLine, false);
    return { stable, unstable: this.unstableLine };
  }

  /** Stable lines plus the trailing partial line, in document order. */
  lines(): ThemedToken[][] {
    return this.unstableLine.length > 0 ? [...this.stableLines, this.unstableLine] : [...this.stableLines];
  }

  colors(): { foreground: string | undefined; background: string | undefined } {
    return { foreground: this.foreground, background: this.background };
  }

  clear(): void {
    this.stableLines = [];
    this.unstableLine = [];
    this.pendingLine = "";
    this.grammarState = undefined;
  }

  private tokenizeLine(line: string, commit: boolean): ThemedToken[] {
    const result = this.highlighter.codeToTokens(line, { lang: this.language, theme: this.theme, grammarState: this.grammarState });
    this.foreground = result.fg ?? this.foreground;
    this.background = result.bg ?? this.background;
    // Only a complete line may advance the shared grammar state; the trailing line can still grow.
    if (commit) this.grammarState = result.grammarState;
    return result.tokens[0] ?? [];
  }
}
