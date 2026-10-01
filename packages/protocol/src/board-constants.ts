export type BoardCoordinateSpace =
  | "world"
  | "frame-local"
  | "world-offset"
  | "screen"
  | "screen-offset"
  | "normalized";

export const BOARD_TEXT_FONT_FAMILY = "Geist";
export const BOARD_TEXT_FONT_SIZE = 24;
export const BOARD_TEXT_LINE_HEIGHT = 32;
export const BOARD_TEXT_MIN_FONT_SIZE = 2;
export const BOARD_TEXT_MAX_FONT_SIZE = 512;
export const BOARD_DRAW_STROKE_SIZE = 4;
export const BOARD_ARROW_STROKE_SIZE = 2.5;

export const BOARD_REALTIME_DELTA_MAX_BYTES = 64 * 1024;

export const BOARD_STROKE_MIN_SIZE = 1;
export const BOARD_STROKE_MAX_SIZE = 64;

export function clampBoardStrokeSize(size: number): number {
  if (!Number.isFinite(size)) return BOARD_ARROW_STROKE_SIZE;
  return Math.min(BOARD_STROKE_MAX_SIZE, Math.max(BOARD_STROKE_MIN_SIZE, size));
}

export const BOARD_FONT_STACK =
  '"Geist", system-ui, -apple-system, "Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
export const BOARD_MONO_FONT_STACK =
  '"Geist Mono", "Fira Code", ui-monospace, "Noto Sans Mono CJK SC", monospace';
