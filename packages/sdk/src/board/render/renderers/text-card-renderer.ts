import { Container, Graphics, Text } from "pixi.js";
import type { BoardTextItem, BoardTextLayout } from "@cohub/protocol";
import { estimateTextWidth, layoutBoardText } from "@cohub/protocol";
import type { SceneItem } from "../../model/scene.js";
import { itemAlpha, itemColor } from "../palette.js";
import { boardTextSize } from "../lod.js";
import { boardTextStyle, canvasFont, cssBaselineShift, layoutTextLines } from "../text-measurement.js";
import { syncTextResolution } from "../text-resolution.js";
import type { BoardCardRenderer, BoardRenderContext } from "./board-renderer-registry.js";
import { drawFarBars } from "./far-plate.js";
import { positionShell } from "./base-card-renderer.js";

type TextParts = {
  root: Container;
  body: Text;
  caret: Graphics;
  layout: BoardTextLayout | null;
  lines: readonly string[];
  sig: string;
  baseline: number;
};

const partsByContainer = new WeakMap<Container, TextParts>();
const ALIGN = { left: 0, center: 0.5, right: 1 } as const;
const FAR_MAX_LINES = 64;

function revealed(lines: readonly string[], reveal: number): readonly string[] {
  if (reveal >= 1) return lines;
  const glyphs = lines.map((line) => [...line]);
  let budget = Math.round(glyphs.reduce((sum, line) => sum + line.length, 0) * Math.max(0, reveal));
  const shown: string[] = [];
  for (const line of glyphs) {
    shown.push(line.slice(0, budget).join(""));
    budget -= line.length;
    if (budget <= 0) break;
  }
  return shown;
}

function syncCaret(parts: TextParts, item: SceneItem<BoardTextItem>, context: BoardRenderContext, anchor: number) {
  const { props } = item;
  const visible = parts.body.visible && props.caret && props.reveal < 1 && Math.floor(context.time / 500) % 2 === 0;
  parts.caret.visible = visible;
  if (!visible || !parts.layout) return;
  const scale = parts.body.scale.x;
  const lastWidth = layoutTextLines(parts.lines.at(-1) ?? "", canvasFont(boardTextStyle(props))).width;
  const x = parts.body.position.x + lastWidth * (1 - anchor) * scale + 2;
  const y = Math.max(0, parts.lines.length - 1) * parts.layout.lineHeight * scale;
  const width = Math.max(1, 1.5 / Math.max(0.25, context.zoom));
  const height = Math.max(12, parts.layout.lineHeight * scale - 2);
  parts.caret.clear().rect(x, y + 1, width, height).fill({ color: itemColor(context, item.style.fill, "neutral") });
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
  const lines = revealed(layout.lines, props.reveal);
  const text = lines.join("\n");
  const style = boardTextStyle(props);
  const sig = [text, ink, props.align, layout.lineHeight, style.fontFamily, style.fontSize, style.fontWeight, context.themeKey].join("|");
  parts.layout = layout;
  parts.lines = lines;
  if (sig !== parts.sig) {
    parts.sig = sig;
    Object.assign(parts.body.style, { ...style, fill: ink, align: props.align, lineHeight: layout.lineHeight, wordWrap: false });
    parts.body.text = text;
    parts.baseline = cssBaselineShift(parts.body.style);
  }
  parts.body.position.set(item.frame.width * anchor, parts.baseline * scale);
  syncTextResolution(parts.body, context.textResolution * scale);
  syncCaret(parts, item, context, anchor);
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
    partsByContainer.set(root, { root, body, caret, layout: null, lines: [], sig: "", baseline: 0 });
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
