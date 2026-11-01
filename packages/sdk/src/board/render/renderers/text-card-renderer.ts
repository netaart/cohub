import { Container, Graphics, Text } from "pixi.js";
import type { BoardTextItem, BoardTextLayout } from "@cohub/protocol";
import { estimateTextWidth, layoutBoardText } from "@cohub/protocol";
import type { SceneItem } from "../../model/scene.js";
import { itemAlpha, itemColor } from "../palette.js";
import { boardTextSize } from "../lod.js";
import { boardTextStyle, canvasFont, cssBaselineShift, measureTextWidth } from "../text-measurement.js";
import { syncTextResolution } from "../text-resolution.js";
import type { BoardCardRenderer, BoardRenderContext } from "./board-renderer-registry.js";
import { drawFarBars } from "./far-plate.js";
import { positionShell } from "./base-card-renderer.js";

type TextParts = {
  root: Container;
  body: Text;
  caret: Graphics;
  shown: Graphics | null;
  entering: { text: Text; mask: Graphics } | null;
  layout: BoardTextLayout | null;
  sig: string;
  baseline: number;
};

type RevealUnit = { line: number; start: number; end: number };

const partsByContainer = new WeakMap<Container, TextParts>();
const ALIGN = { left: 0, center: 0.5, right: 1 } as const;
const FAR_MAX_LINES = 64;

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;

function boundaries(line: string, by: "char" | "word" | "line"): number[] {
  if (by === "line") return [0, line.length];
  if (by === "char") {
    const ends = [0];
    for (const glyph of line) ends.push((ends.at(-1) ?? 0) + glyph.length);
    return ends;
  }
  const ends = [0];
  const segments = segmenter ? [...segmenter.segment(line)].map((part) => ({ text: part.segment, word: part.isWordLike !== false })) : line.split(/(\s+)/).map((text) => ({ text, word: !/^\s*$/.test(text) }));
  for (const { text, word } of segments) {
    const end = (ends.at(-1) ?? 0) + text.length;
    if (word || ends.length === 1) ends.push(end);
    else ends[ends.length - 1] = end;
  }
  return ends;
}

const unitsCache = new Map<string, { units: RevealUnit[]; lineWidths: number[] }>();

function revealUnits(lines: readonly string[], font: string, by: "char" | "word" | "line") {
  const key = `${by}|${font}|${lines.join("\n")}`;
  let cached = unitsCache.get(key);
  if (cached) return cached;
  const units: RevealUnit[] = [];
  const lineWidths = lines.map((line, index) => {
    const ends = boundaries(line, by);
    for (let at = 1; at < ends.length; at += 1) units.push({ line: index, start: ends[at - 1] ?? 0, end: ends[at] ?? 0 });
    return measureTextWidth(line, font);
  });
  if (unitsCache.size > 256) unitsCache.clear();
  cached = { units, lineWidths };
  unitsCache.set(key, cached);
  return cached;
}

function syncReveal(parts: TextParts, item: SceneItem<BoardTextItem>, scale: number, anchor: number): { x: number; line: number } | null {
  const { props } = item;
  const layout = parts.layout;
  if (props.reveal >= 1 || !layout) {
    if (parts.shown) {
      parts.body.mask = null;
      parts.shown.destroy();
      parts.shown = null;
    }
    if (parts.entering) {
      parts.entering.text.destroy();
      parts.entering.mask.destroy();
      parts.entering = null;
    }
    return null;
  }
  const font = canvasFont(boardTextStyle(props));
  const { units, lineWidths } = revealUnits(layout.lines, font, props.revealBy ?? "char");
  const motion = props.revealMotion ?? "cut";
  const progress = units.length * Math.max(0, props.reveal);
  const whole = motion === "cut" ? Math.round(progress) : Math.floor(progress);
  const widest = Math.max(0, ...lineWidths);
  const left = item.frame.width * anchor - widest * scale * anchor;
  const lineLeft = (line: number) => left + (widest - (lineWidths[line] ?? 0)) * anchor * scale;
  const offsetAt = (line: number, end: number) => measureTextWidth((layout.lines[line] ?? "").slice(0, end), font);
  const rect = (graphics: Graphics, line: number, from: number, to: number, offset = 0) =>
    graphics.rect(lineLeft(line) + from * scale, (line * layout.lineHeight + offset) * scale, (to - from) * scale, layout.lineHeight * scale);
  if (!parts.shown) {
    parts.shown = parts.root.addChild(new Graphics());
    parts.body.mask = parts.shown;
  }
  const shown = parts.shown.clear();
  const last = units[whole - 1];
  const end = last ? offsetAt(last.line, last.end) : 0;
  if (last) {
    for (let line = 0; line < last.line; line += 1) rect(shown, line, 0, lineWidths[line] ?? 0);
    rect(shown, last.line, 0, end);
  } else shown.rect(0, 0, 0, 0);
  shown.fill(0xffffff);
  const appearing = motion === "cut" ? undefined : units[whole];
  if (appearing) {
    if (!parts.entering) {
      const text = new Text({ text: "", style: parts.body.style, roundPixels: true });
      const mask = new Graphics();
      text.mask = mask;
      parts.root.addChild(text, mask);
      parts.entering = { text, mask };
    }
    const { text, mask } = parts.entering;
    const t = progress - whole;
    const rise = motion === "rise" ? (1 - t) * 0.35 * layout.lineHeight : 0;
    text.text = parts.body.text;
    if (text.resolution !== parts.body.resolution) text.resolution = parts.body.resolution;
    text.anchor.copyFrom(parts.body.anchor);
    text.scale.copyFrom(parts.body.scale);
    text.position.set(parts.body.position.x, parts.body.position.y + rise * scale);
    text.alpha = t * parts.body.alpha;
    text.visible = parts.body.visible;
    const from = appearing.line === last?.line ? end : offsetAt(appearing.line, appearing.start);
    rect(mask.clear(), appearing.line, from, offsetAt(appearing.line, appearing.end), rise);
    mask.fill(0xffffff);
  } else if (parts.entering) parts.entering.text.visible = false;
  return { x: lineLeft(last?.line ?? 0) + end * scale, line: last?.line ?? 0 };
}

function syncCaret(parts: TextParts, item: SceneItem<BoardTextItem>, context: BoardRenderContext, at: { x: number; line: number } | null) {
  const visible = Boolean(at) && parts.body.visible && item.props.caret && Math.floor(context.time / 500) % 2 === 0;
  parts.caret.visible = visible;
  if (!visible || !at || !parts.layout) return;
  const step = parts.layout.lineHeight * parts.body.scale.x;
  const width = Math.max(1, 1.5 / Math.max(0.25, context.zoom));
  parts.caret.clear().rect(at.x + 2, at.line * step + 1, width, Math.max(12, step - 2)).fill({ color: itemColor(context, item.style.fill, "neutral") });
}

function sync(container: Container, item: SceneItem<BoardTextItem>, context: BoardRenderContext) {
  const parts = partsByContainer.get(container);
  if (!parts) return;
  positionShell(parts.root, item);
  const { props } = item;
  const layout = layoutBoardText(props);
  const scale = Math.max(0.0001, item.frame.width / Math.max(0.0001, layout.width));
  const anchor = ALIGN[props.align] ?? 0;
  parts.body.scale.set(scale);
  parts.body.anchor.set(anchor, 0);
  parts.body.visible = context.editingId !== item.id;
  parts.body.alpha = itemAlpha(context, item.style.fill);
  parts.caret.alpha = parts.body.alpha;

  const ink = itemColor(context, item.style.fill, "neutral");
  const text = layout.lines.join("\n");
  const style = boardTextStyle(props);
  const sig = [text, ink, props.align, layout.lineHeight, style.fontFamily, style.fontSize, style.fontWeight, context.themeKey].join("|");
  parts.layout = layout;
  if (sig !== parts.sig) {
    parts.sig = sig;
    Object.assign(parts.body.style, { ...style, fill: ink, align: props.align, lineHeight: layout.lineHeight, wordWrap: false });
    parts.body.text = text;
    parts.baseline = cssBaselineShift(parts.body.style);
  }
  parts.body.position.set(item.frame.width * anchor, parts.baseline * scale);
  syncTextResolution(parts.body, context.textResolution * scale);
  syncCaret(parts, item, context, syncReveal(parts, item, scale, anchor));
}

function farBars({ frame, props }: SceneItem<BoardTextItem>) {
  const layout = layoutBoardText(props);
  const scale = frame.width / Math.max(0.0001, layout.width);
  const lines = layout.lines.slice(0, FAR_MAX_LINES);
  const widths = lines.map((line) => estimateTextWidth(line.trim(), props.fontSize));
  const widest = Math.max(0.0001, ...widths);
  const step = layout.lineHeight * scale;
  const height = step * 0.45;
  return lines.flatMap((_, index) => {
    const width = (frame.width * (widths[index] ?? 0)) / widest;
    if (width <= 0) return [];
    const x = props.align === "center" ? (frame.width - width) / 2 : props.align === "right" ? frame.width - width : 0;
    return [{ x, y: index * step + (step - height) / 2, width, height }];
  });
}

export const textCardRenderer: BoardCardRenderer = {
  id: "text-card",
  canRender: (item) => item.type === "text",
  create: (item, context) => {
    const root = new Container();
    const body = new Text({ text: "", resolution: context.textResolution, roundPixels: true });
    const caret = new Graphics();
    root.addChild(body, caret);
    partsByContainer.set(root, { root, body, caret, shown: null, entering: null, layout: null, sig: "", baseline: 0 });
    if (item.type === "text") sync(root, item as SceneItem<BoardTextItem>, context);
    return root;
  },
  update: (container, item, context) => {
    if (item.type === "text") sync(container, item as SceneItem<BoardTextItem>, context);
  },
  resolution: (container, _item, context) => {
    const parts = partsByContainer.get(container);
    if (parts) syncTextResolution(parts.body, context.textResolution * parts.body.scale.x);
  },
  lod: { kind: "text", size: boardTextSize },
  renderFar: (graphics, item, context) => {
    if (item.type !== "text") return;
    drawFarBars(graphics, item.frame, farBars(item as SceneItem<BoardTextItem>), {
      color: itemColor(context, item.style.fill, "neutral"),
      alpha: 0.4 * itemAlpha(context, item.style.fill),
    });
  },
  destroy: (container) => {
    partsByContainer.get(container)?.root.destroy({ children: true });
    partsByContainer.delete(container);
  },
};
