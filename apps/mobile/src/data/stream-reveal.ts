const REVEAL_FRAME_MS = 24;
const COMMIT_INTERVAL_MS = 80;
const REVEAL_MIN_STEP = 2;
const REVEAL_MAX_STEP = 14;
const REVEAL_PRESSURE_BACKLOG = 36;

function visibleStepSize(remaining: number) {
  const pressure = Math.min(1, Math.max(0, remaining / REVEAL_PRESSURE_BACKLOG));
  return Math.round(REVEAL_MIN_STEP + (REVEAL_MAX_STEP - REVEAL_MIN_STEP) * pressure);
}

function isWordBoundary(value: string) {
  return /[\s.,!?;:，。！？；：、）\]}"'`»]/u.test(value);
}

/** Move at most `maxStep` characters, then continue to the next word boundary. */
export function advanceByWord(source: string, from: number, maxStep: number) {
  const hardTarget = Math.min(source.length, from + maxStep);
  if (hardTarget >= source.length) return source.length;
  let cursor = hardTarget;
  while (cursor < source.length && cursor - from < maxStep + 16) {
    if (isWordBoundary(source[cursor] ?? "")) return cursor + 1;
    cursor += 1;
  }
  return hardTarget;
}

/**
 * Decouples network stream patches from rendering: the target text updates at
 * patch frequency while the displayed text advances word by word on a fixed
 * cadence, and subscribers are notified at most every {@link COMMIT_INTERVAL_MS}.
 * This is what keeps streamed markdown from re-rendering the whole bubble on
 * every token.
 */
export class StreamRevealController {
  private target = "";
  private displayed = "";
  private published = "";
  private initialized = false;
  private disposed = false;
  private readonly listeners = new Set<(value: string) => void>();
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCommitAt = 0;

  subscribe(listener: (value: string) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setTarget(source: string) {
    if (this.disposed || source === this.target) return;
    if (!this.initialized || !source.startsWith(this.displayed)) {
      // First content or a reset: show it whole instead of revealing from empty.
      this.initialized = true;
      this.target = source;
      this.displayed = source;
      this.scheduleCommit(0);
      return;
    }
    this.target = source;
    if (this.frameTimer === null) this.advance();
  }

  /** Show the full target immediately; used when the stream finalizes. */
  flush(source = this.target) {
    if (this.disposed) return;
    this.initialized = true;
    this.target = source;
    this.displayed = source;
    if (this.frameTimer !== null) {
      clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
    this.scheduleCommit(0);
  }

  dispose() {
    this.disposed = true;
    if (this.frameTimer !== null) clearTimeout(this.frameTimer);
    if (this.commitTimer !== null) clearTimeout(this.commitTimer);
    this.frameTimer = null;
    this.commitTimer = null;
    this.listeners.clear();
  }

  private advance() {
    this.frameTimer = null;
    if (this.disposed) return;
    if (this.displayed !== this.target) {
      if (!this.target.startsWith(this.displayed)) {
        this.displayed = this.target;
      } else {
        const remaining = this.target.length - this.displayed.length;
        const step = Math.min(remaining, visibleStepSize(remaining));
        this.displayed = this.target.slice(0, advanceByWord(this.target, this.displayed.length, step));
      }
    }
    this.scheduleCommit();
    if (this.displayed !== this.target) {
      this.frameTimer = setTimeout(() => this.advance(), REVEAL_FRAME_MS);
    }
  }

  private scheduleCommit(delay?: number) {
    if (delay === undefined) {
      if (this.commitTimer !== null) return;
    } else if (this.commitTimer !== null) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    const wait = delay ?? Math.max(0, COMMIT_INTERVAL_MS - (Date.now() - this.lastCommitAt));
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      this.lastCommitAt = Date.now();
      const value = this.displayed;
      if (value === this.published) return;
      this.published = value;
      for (const listener of this.listeners) listener(value);
    }, wait);
  }
}
