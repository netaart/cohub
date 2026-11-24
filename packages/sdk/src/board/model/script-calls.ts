import { BOARD_TEXT_FONT_SIZE } from "@cohub/protocol/board-constants";
import { layoutBoardText } from "@cohub/protocol/board-layout";
import type { BoardScriptPreload, BoardScriptTextInput } from "./script.js";

export const BOARD_SCRIPT_PRELOAD_MAX = 16;

export function layoutBoardScriptText(value: unknown): { width: number; height: number } {
  const input = value as BoardScriptTextInput;
  if (!input || typeof input.text !== "string" || input.text.length > 10_000) throw new Error("layoutText() needs text of at most 10000 characters.");
  for (const key of ["fontSize", "fontWeight", "lineHeight", "width"] as const)
    if (input[key] !== undefined && !(Number.isFinite(input[key]) && (input[key] as number) > 0)) throw new Error(`layoutText() ${key} must be a positive number.`);
  const { width, height } = layoutBoardText({ fontSize: BOARD_TEXT_FONT_SIZE, fontWeight: 500, font: "sans", lineHeight: 4 / 3, ...input });
  return { width, height };
}

export function boardScriptPreloads(value: unknown): BoardScriptPreload[] {
  if (!Array.isArray(value) || value.length > BOARD_SCRIPT_PRELOAD_MAX)
    throw new Error(`preload() takes a list of up to ${BOARD_SCRIPT_PRELOAD_MAX} images.`);
  return value.map((entry) => {
    const image = (typeof entry === "string" ? { src: entry } : entry) as BoardScriptPreload | null;
    if (!image || typeof image.src !== "string" || !image.src) throw new Error("preload() takes image sources or { src, width?, height? }.");
    for (const key of ["width", "height"] as const)
      if (image[key] !== undefined && !(Number.isFinite(image[key]) && (image[key] as number) > 0)) throw new Error(`preload() ${key} must be a positive number.`);
    return { src: image.src, width: image.width, height: image.height };
  });
}

export const BOARD_SCRIPT_EXPORT_CALLS: Readonly<Record<string, (input: unknown) => unknown>> = {
  "board.emit": () => undefined,
  "board.broadcast": () => undefined,
  "board.commit": () => false,
  "board.layoutText": layoutBoardScriptText,
  "board.preload": (input) => ({ loaded: boardScriptPreloads(input).length, failed: 0 }),
};
