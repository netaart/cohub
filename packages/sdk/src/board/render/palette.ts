
import type { BoardColor } from "@cohub/protocol";
import { type BoardColorId, resolveItemColor } from "../model/palette.js";
import { BOARD_THEME_DATA } from "../model/themes.js";
import { parseBoardCssColor, parseBoardCssPaint } from "./css-color.js";
import type { BoardRenderContext, BoardRenderPalette } from "./renderers/board-renderer-registry.js";

export function defaultBoardPalette(mode: "dark" | "light"): BoardRenderPalette {
  return { ...BOARD_THEME_DATA[mode].palette };
}

export function itemAlpha(context: Pick<BoardRenderContext, "colorScheme">, color: BoardColor | undefined): number {
  const value = typeof color === "object" && color ? color[context.colorScheme] : color;
  return value ? (parseBoardCssPaint(value)?.alpha ?? 1) : 1;
}

export function itemColor(
  context: Pick<BoardRenderContext, "colors" | "colorScheme" | "palette">,
  color: BoardColor | undefined,
  fallback: BoardColorId,
  part: "stroke" | "fill" | "label" = "stroke",
): number {
  const value = typeof color === "object" && color ? color[context.colorScheme] : color;
  if ((value ?? fallback) === "neutral" && part !== "fill") return context.palette.text;
  return resolveItemColor(color, fallback, context.colors, context.colorScheme, parseBoardCssColor, part);
}
