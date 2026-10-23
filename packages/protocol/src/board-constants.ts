export type BoardCoordinateSpace =
  | "world"
  | "frame-local"
  | "world-offset"
  | "screen"
  | "screen-offset"
  | "normalized";

export const BOARD_TEXT_FONT_FAMILY = "Geist Variable";
export const BOARD_TEXT_FONT_SIZE = 24;
export const BOARD_TEXT_LINE_HEIGHT = 32;
export const BOARD_TEXT_MIN_FONT_SIZE = 2;
export const BOARD_TEXT_MAX_FONT_SIZE = 512;
export const BOARD_DRAW_STROKE_SIZE = 4;
export const BOARD_ARROW_STROKE_SIZE = 2.5;

export const BOARD_PAGE_SIZE = { width: 960, height: 540 } as const;
export const BOARD_MEDIA_EDGE = 480;
export const BOARD_TEXT_SCALE = { title: 56, heading: 40, body: BOARD_TEXT_FONT_SIZE, caption: 16 } as const;

export const BOARD_DEFAULT_ITEM_SIZE = { width: 240, height: 160 } as const;
export const BOARD_DEFAULT_SIZES = {
  frame: { width: 480, height: 320 },
  shape: { width: 200, height: 140 },
  image: { width: BOARD_MEDIA_EDGE, height: 270 },
  video: { width: BOARD_MEDIA_EDGE, height: 270 },
  audio: { width: 320, height: 112 },
  file: { width: 260, height: 132 },
  task: { width: BOARD_MEDIA_EDGE, height: 270 },
  effect: { width: 240, height: 240 },
  custom: { width: 480, height: 320 },
} as const;

export function boardDefaultSize(type: string): { width: number; height: number } {
  const size = Object.hasOwn(BOARD_DEFAULT_SIZES, type)
    ? BOARD_DEFAULT_SIZES[type as keyof typeof BOARD_DEFAULT_SIZES]
    : BOARD_DEFAULT_ITEM_SIZE;
  return { ...size };
}

export const BOARD_REALTIME_DELTA_MAX_BYTES = 64 * 1024;

export const BOARD_STROKE_MIN_SIZE = 1;
export const BOARD_STROKE_MAX_SIZE = 64;

export function clampBoardStrokeSize(size: number): number {
  if (!Number.isFinite(size)) return BOARD_ARROW_STROKE_SIZE;
  return Math.min(BOARD_STROKE_MAX_SIZE, Math.max(BOARD_STROKE_MIN_SIZE, size));
}

export const BOARD_FONT_STACK =
  '"Geist Variable", "Geist", "Noto Sans CJK SC", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, -apple-system, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Noto Sans Math", "Noto Sans Symbols 2", "DejaVu Sans", "FreeSans", "FreeSerif", sans-serif';
export const BOARD_MONO_FONT_STACK =
  '"Geist Mono Variable", "Geist Mono", "Fira Code", ui-monospace, "Noto Sans Mono CJK SC", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Noto Sans Math", "DejaVu Sans", "FreeSans", "FreeSerif", monospace';
