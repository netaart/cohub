import { graphemeSegments } from "unicode-segmenter/grapheme";

const COMMIT_MIN_MS = 48;
const COMMIT_MAX_MS = 96;
const TAIL_SCALE_UNITS = 1024;
const ACTIVE_INPUT_WINDOW_MS = 220;
const DRAIN_AFTER_IDLE_MS = 600;
const DEFAULT_CPS = 40;
const FLUSH_CPS = 240;
const MIN_CPS = 12;
const ARRIVAL_SMOOTHING = 0.25;
/** Display lag kept while input is active, in milliseconds of text at the arrival rate. */
const TARGET_BUFFER_MS = 120;
/** A single patch larger than this shows at once instead of animating for seconds. */
const LARGE_APPEND_CHARS = 240;
/** How long a revealed grapheme fades in, and how many can animate at once. */
export const GLYPH_FADE_MS = 180;
export const MAX_FADING_GLYPHS = 32;

type Unit = { offset: number; length: number };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function segment(value: string): Unit[] {
  const units: Unit[] = [];
  for (const part of graphemeSegments(value)) units.push({ offset: part.index, length: part.segment.length });
  return units;
}

export function graphemeLength(value: string) {
  return [...graphemeSegments(value)].length;
}

export function splitGraphemes(value: string) {
  const parts: string[] = [];
  for (const part of graphemeSegments(value)) parts.push(part.segment);
  return parts;
}

/**
 * Presentation-only pacing for one streaming text item. Cohub's snapshots stay
 * authoritative: the controller never invents text, it only decides when a
 * prefix becomes visible. Appends are revealed grapheme by grapheme; a rewrite
 * or a new item resets without replaying.
 *
 * Commits are throttled below the display refresh rate because every commit
 * re-parses and re-renders the trailing Markdown block. The interval widens as
 * the active block grows, and while input is active the reveal rate tracks the
 * arrival rate with a small time-based buffer, so the display never trails a
 * fast stream by more than that buffer.
 */
export class StreamRevealController {
  private source = "";
  private displayedLength = 0;
  private units: Unit[] = [];
  private births: number[] = [];
  private nextUnit = 0;
  private initialized = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();
  private lastInputAt = 0;
  private arrivalCps = DEFAULT_CPS;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getDisplayed = () => this.source.slice(0, this.displayedLength);

  /** Trailing graphemes still inside the fade window, oldest-last. */
  readonly getFadeTailCount = (now = Date.now()) => {
    let count = 0;
    for (let index = this.nextUnit - 1; index >= 0 && count < MAX_FADING_GLYPHS; index -= 1) {
      const birth = this.births[index] ?? -1;
      if (birth < 0 || now - birth >= GLYPH_FADE_MS) break;
      count += 1;
    }
    return count;
  };

  setTarget(source: string) {
    if (source === this.source) return;
    const now = Date.now();
    if (!this.initialized) {
      this.initialized = true;
      this.lastInputAt = now;
      this.arrivalCps = DEFAULT_CPS;
      // First content fades in rather than popping; there is no prior text to reveal from.
      this.flush(source, true);
      return;
    }
    if (!source.startsWith(this.source)) {
      this.lastInputAt = now;
      this.arrivalCps = DEFAULT_CPS;
      this.flush(source, false);
      return;
    }
    const appended = source.slice(this.source.length);
    const added = graphemeLength(appended);
    const elapsed = Math.max(16, now - this.lastInputAt);
    if (added > 0) {
      const inputCps = added * 1000 / elapsed;
      this.arrivalCps = this.arrivalCps * (1 - ARRIVAL_SMOOTHING) + clamp(inputCps, MIN_CPS, FLUSH_CPS) * ARRIVAL_SMOOTHING;
    }
    // An append can extend the trailing grapheme (combining mark, ZWJ), so
    // re-segment from that unit instead of trusting the previous boundaries.
    const tail = this.units.at(-1);
    const tailStart = tail?.offset ?? 0;
    const tailBirth = this.births.at(-1) ?? -1;
    if (tail) {
      this.units.length -= 1;
      this.births.length -= 1;
    }
    segment(source.slice(tailStart)).forEach((unit, index) => {
      this.units.push({ offset: tailStart + unit.offset, length: unit.length });
      this.births.push(index === 0 ? tailBirth : -1);
    });
    // The last old unit may now be extended, so step back onto it instead of
    // treating the appended graphemes as already displayed.
    this.nextUnit = this.units.length === 0 ? 0 : Math.max(0, Math.min(this.nextUnit, this.units.length - 1));
    while (this.nextUnit < this.units.length && this.units[this.nextUnit]!.offset + this.units[this.nextUnit]!.length <= this.displayedLength) {
      this.nextUnit += 1;
    }
    this.source = source;
    this.lastInputAt = now;
    this.schedule();
  }

  /**
   * Show the full target immediately. `fade` keeps the target segmented and
   * stamps its graphemes so first content can fade in; completion and
   * teardown pass `false` and drop the segmentation.
   */
  flush(source = this.source, fade = false) {
    this.clearTimer();
    this.initialized = true;
    this.source = source;
    if (fade) {
      const now = Date.now();
      this.units = segment(source);
      this.births = this.units.map(() => now);
      this.nextUnit = this.units.length;
    } else {
      // Skip segmentation: a future append re-segments from the tail anyway, and
      // non-streaming mounts must not pay O(source) per history row.
      this.units = [];
      this.births = [];
      this.nextUnit = 0;
    }
    this.displayedLength = source.length;
    this.publish();
  }

  /** Stop pacing without discarding state; a later setTarget resumes. */
  stop() {
    this.clearTimer();
  }

  private publish() {
    for (const listener of this.listeners) listener();
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule() {
    if (this.timer !== null || this.nextUnit >= this.units.length) return;
    const tailLength = this.displayedLength - (this.source.lastIndexOf("\n\n", this.displayedLength - 1) + 2);
    const interval = Math.min(COMMIT_MAX_MS, COMMIT_MIN_MS * (1 + Math.max(0, tailLength) / TAIL_SCALE_UNITS));
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.nextUnit >= this.units.length) return;
      const now = Date.now();
      const idle = now - this.lastInputAt;
      const remainingLength = this.source.length - this.displayedLength;
      const remainingUnits = this.units.length - this.nextUnit;
      const active = idle < ACTIVE_INPUT_WINDOW_MS;
      let budget: number;
      if (idle >= DRAIN_AFTER_IDLE_MS || remainingLength > LARGE_APPEND_CHARS) {
        budget = remainingLength;
      } else if (active) {
        const baseCps = clamp(this.arrivalCps, MIN_CPS, FLUSH_CPS);
        const lagChars = Math.round(baseCps * TARGET_BUFFER_MS / 1000);
        const rate = Math.ceil(baseCps * interval / 1000);
        budget = Math.max(1, remainingLength - lagChars, rate);
      } else {
        budget = Math.max(1, Math.ceil(FLUSH_CPS * interval / 1000));
      }
      let take = 0;
      let end = this.displayedLength;
      while (take < remainingUnits && end - this.displayedLength < budget) {
        const unit = this.units[this.nextUnit + take]!;
        end = unit.offset + unit.length;
        take += 1;
      }
      for (let index = this.nextUnit; index < this.nextUnit + take; index += 1) this.births[index] = now;
      this.nextUnit += take;
      this.displayedLength = end;
      this.publish();
      this.schedule();
    }, interval);
  }
}
