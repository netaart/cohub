
import type { BoardColor } from "@cohub/protocol";
import { type BoardColorId, resolveItemColor } from "../core/palette.js";
import { parseBoardCssColor } from "./css-color.js";
import type { BoardRenderContext, BoardRenderPalette } from "./renderers/board-renderer-registry.js";

const DARK: BoardRenderPalette = {
  bg: 0x141414,
  surface: 0x202020,
  hover: 0x2a2a2a,
  border: 0x3a3a3a,
  brand: 0xff5a1f,
  text: 0xf4f4f4,
  muted: 0x8c8c8c,
  rare: 0x38bdf8,
  epic: 0xa78bfa,
  legendary: 0xf59e0b,
};

const LIGHT: BoardRenderPalette = {
  bg: 0xffffff,
  surface: 0xf4f4f5,
  hover: 0xe9e9ec,
  border: 0xd6d6da,
  brand: 0xe8450e,
  text: 0x18181b,
  muted: 0x6b7280,
  rare: 0x2563eb,
  epic: 0x7c3aed,
  legendary: 0xb45309,
};

export function defaultBoardPalette(mode: "dark" | "light"): BoardRenderPalette {
  return { ...(mode === "light" ? LIGHT : DARK) };
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
