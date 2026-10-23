import { clearCache, layoutWithLines, type PreparedTextWithSegments, prepareWithSegments } from "@chenglou/pretext";
import { type BoardTextFont, type BoardTextLines, clampBoardFontSize, setBoardTextLayouter } from "@cohub/protocol";
import { BOARD_FONT_STACK, BOARD_MONO_FONT_STACK } from "@cohub/protocol/board-constants";
import { CanvasTextMetrics, DOMAdapter, fontStringFromTextStyle, type TextStyle } from "pixi.js";
import { boardFontFamily } from "../model/text-metrics.js";

export const BOARD_FONT_STACKS = {
  sans: BOARD_FONT_STACK,
  serif: 'ui-serif, Georgia, "Noto Serif CJK SC", "Songti SC", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Noto Sans Math", "DejaVu Sans", "Noto Sans CJK SC", "FreeSans", "FreeSerif", sans-serif',
  mono: BOARD_MONO_FONT_STACK,
};

export type BoardTextStyle = { fontFamily: string; fontSize: number; fontWeight: string };

const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"]);
const QUOTED = /^(["']).+\1$/;
const familyLists = new Map<string, string>();

export function canvasFontFamily(families: string): string {
  let list = familyLists.get(families);
  if (list === undefined) {
    list = families
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => (QUOTED.test(name) || GENERIC_FAMILIES.has(name) ? name : `"${name}"`))
      .join(", ");
    familyLists.set(families, list);
  }
  return list;
}

export function boardTextStyle({ font, fontSize, fontWeight }: BoardTextFont): BoardTextStyle {
  return {
    fontFamily: canvasFontFamily(boardFontFamily(font, BOARD_FONT_STACKS)),
    fontSize: clampBoardFontSize(fontSize),
    fontWeight: String(Math.round(fontWeight / 100) * 100),
  };
}

export function canvasFont({ fontFamily, fontSize, fontWeight }: BoardTextStyle): string {
  return `${fontWeight} ${fontSize}px ${fontFamily}`;
}

const PREPARED_LIMIT = 256;
const prepared = new Map<string, PreparedTextWithSegments>();
const measuredFonts = new Set<string>();
const measuredFamilies = new Set<string>();
const TRAILING_SPACE = /[ \t]+$/u;
const unquote = (name: string) => name.trim().replace(/^["']|["']$/gu, "");

function prepareText(text: string, font: string, whiteSpace: BoardTextWhiteSpace): PreparedTextWithSegments {
  const key = `${whiteSpace}\n${font}\n${text}`;
  let value = prepared.get(key);
  if (value) {
    prepared.delete(key);
    prepared.set(key, value);
    return value;
  }
  if (!measuredFonts.has(font)) {
    measuredFonts.add(font);
    for (const name of /px\s+(.+)$/u.exec(font)?.[1]?.split(",") ?? []) measuredFamilies.add(unquote(name));
  }
  value = prepareWithSegments(text, font, { whiteSpace });
  if (prepared.size >= PREPARED_LIMIT) prepared.delete(prepared.keys().next().value as string);
  prepared.set(key, value);
  return value;
}

let measureContext: CanvasRenderingContext2D | null | undefined;

export function measureTextWidth(text: string, font: string): number {
  measureContext ??= DOMAdapter.get().createCanvas(1, 1).getContext("2d") as CanvasRenderingContext2D | null;
  if (!measureContext) return 0;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

export type BoardTextWhiteSpace = "normal" | "pre-wrap";

export type BoardTextLineOptions = {
  whiteSpace?: BoardTextWhiteSpace;
  maxLines?: number;
};

export type BoardTextLineLayout = BoardTextLines & { truncated: boolean };

export function layoutTextLines(
  text: string,
  font: string,
  maxWidth = Number.POSITIVE_INFINITY,
  { whiteSpace = "pre-wrap", maxLines = Number.POSITIVE_INFINITY }: BoardTextLineOptions = {},
): BoardTextLineLayout {
  const lines: string[] = [];
  const widths: number[] = [];
  if (maxLines <= 0) return { lines, width: 0, truncated: text.length > 0 };
  let source = whiteSpace === "normal" ? text.replace(/\s+/gu, " ").trim() : text.replace(/\r\n?/gu, "\n").replaceAll("\t", " ");
  const cap = Number.isFinite(maxLines) && Number.isFinite(maxWidth) ? maxLines * (Math.ceil(maxWidth) + 1) : Number.POSITIVE_INFINITY;
  let truncated = source.length > cap;
  if (truncated) source = source.slice(0, cap);
  const paragraphs = whiteSpace === "normal" ? (source ? [source] : []) : source.split("\n");
  for (const paragraph of paragraphs) {
    if (lines.length > maxLines) break;
    if (!paragraph) {
      lines.push("");
      widths.push(0);
      continue;
    }
    const wrapped = layoutWithLines(prepareText(paragraph, font, whiteSpace), maxWidth, 1).lines;
    for (const [index, line] of wrapped.entries()) {
      lines.push(index === wrapped.length - 1 ? line.text : line.text.replace(TRAILING_SPACE, ""));
      widths.push(line.width);
    }
  }
  if (lines.length > maxLines) {
    truncated = true;
    lines.length = maxLines;
    widths.length = maxLines;
  }
  if (truncated && lines.length > 0) {
    const last = lines.length - 1;
    lines[last] = fitLineWithEllipsis(lines[last] as string, maxWidth, (value) => measureTextWidth(value, font));
    widths[last] = measureTextWidth(lines[last] as string, font);
  }
  return { lines, width: widths.reduce((max, width) => Math.max(max, width), 0), truncated };
}

const graphemes = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

export function fitLineWithEllipsis(line: string, width: number, measureWidth: (value: string) => number): string {
  const trimmed = line.replace(/\s+$/u, "");
  if (!trimmed) return "…";
  if (measureWidth(`${trimmed}…`) <= width) return `${trimmed}…`;
  const parts = graphemes ? Array.from(graphemes.segment(trimmed), ({ segment }) => segment) : Array.from(trimmed);
  let lo = 0;
  let hi = parts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measureWidth(`${parts.slice(0, mid).join("")}…`) <= width) lo = mid;
    else hi = mid - 1;
  }
  return `${parts.slice(0, lo).join("")}…`;
}

const baselineShifts = new Map<string, number>();

export function cssBaselineShift(style: TextStyle): number {
  const font = fontStringFromTextStyle(style);
  let shift = baselineShifts.get(font);
  if (shift === undefined) {
    const ink = CanvasTextMetrics.measureFont(font);
    const context = DOMAdapter.get().createCanvas(1, 1).getContext("2d") as CanvasRenderingContext2D | null;
    shift = 0;
    if (context) {
      context.font = font;
      const { fontBoundingBoxAscent: ascent, fontBoundingBoxDescent: descent } = context.measureText("M");
      if (Number.isFinite(ascent) && Number.isFinite(descent)) shift = (ascent - descent - (ink.ascent - ink.descent)) / 2;
    }
    baselineShifts.set(font, shift);
  }
  return shift;
}

const layoutBoardLines = (text: string, font: BoardTextFont, maxWidth: number | undefined) =>
  layoutTextLines(text, canvasFont(boardTextStyle(font)), maxWidth);

const canMeasure = () => typeof OffscreenCanvas !== "undefined" || typeof document !== "undefined";

let installed = false;
let fontsChanged = false;
const fontListeners = new Set<() => void>();

function notifyFontsChanged() {
  fontsChanged = false;
  installBoardTextMeasurement();
  for (const listener of fontListeners) listener();
}

export function installBoardTextMeasurement(): void {
  installed = true;
  prepared.clear();
  baselineShifts.clear();
  clearCache();
  CanvasTextMetrics.clearMetrics();
  setBoardTextLayouter(canMeasure() ? layoutBoardLines : undefined);
}

export function ensureBoardTextMeasurement(): void {
  if (installed) return;
  installBoardTextMeasurement();
  globalThis.document?.fonts?.addEventListener("loadingdone", (event) => {
    if (fontsChanged || !event.fontfaces.some((face) => measuredFamilies.has(unquote(face.family)))) return;
    fontsChanged = true;
    requestAnimationFrame(notifyFontsChanged);
  });
}

export function onBoardTextFontsChange(listener: () => void): () => void {
  fontListeners.add(listener);
  return () => fontListeners.delete(listener);
}
