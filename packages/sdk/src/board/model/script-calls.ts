import { BOARD_TEXT_FONT_SIZE } from "@cohub/protocol/board-constants";
import { layoutBoardText } from "@cohub/protocol/board-layout";
import type { BoardScriptTextInput } from "./script.js";

export function layoutBoardScriptText(value: unknown): { width: number; height: number } {
  const input = value as BoardScriptTextInput;
  if (!input || typeof input.text !== "string" || input.text.length > 10_000) throw new Error("layoutText() needs text of at most 10000 characters.");
  for (const key of ["fontSize", "fontWeight", "lineHeight", "width"] as const)
    if (input[key] !== undefined && !(Number.isFinite(input[key]) && (input[key] as number) > 0)) throw new Error(`layoutText() ${key} must be a positive number.`);
  const { width, height } = layoutBoardText({ fontSize: BOARD_TEXT_FONT_SIZE, fontWeight: 500, font: "sans", lineHeight: 4 / 3, ...input });
  return { width, height };
}

export const BOARD_SCRIPT_EXPORT_CALLS: Readonly<Record<string, (input: unknown) => unknown>> = {
  "board.emit": () => undefined,
  "board.broadcast": () => undefined,
  "board.commit": () => false,
  "board.layoutText": layoutBoardScriptText,
};
