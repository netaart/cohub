import { Container, Graphics, Text } from "pixi.js";
import type { BoardTextItem } from "@cohub/protocol";
import { layoutBoardText } from "@cohub/protocol";
import { boardFontFamily } from "../../core/text-metrics.js";
import type { SceneItem } from "../../core/scene.js";
import { itemColor } from "../palette.js";
import { BOARD_FONT_STACKS } from "../text-measurement.js";
import { syncTextResolution, textResolutionForZoom } from "../text-resolution.js";
import { positionShell } from "./base-card-renderer.js";
import type { BoardCardRenderer, BoardRenderContext } from "./board-renderer-registry.js";
import { drawFarPlate } from "./far-plate.js";

type TextParts = {
  root: Container;
  body: Text;
  caret: Graphics;
  resolution: number;
  contentSig: string;
};

const partsByContainer = new WeakMap<Container, TextParts>();

function revealed(text: string, reveal: number): string {
  if (reveal >= 1) return text;
  return [...text].slice(0, Math.round(text.length * Math.max(0, reveal))).join("");
}

function syncCaret(parts: TextParts, item: SceneItem<BoardTextItem>, context: BoardRenderContext) {
  const { props } = item;
  const visible = props.caret && props.reveal < 1 && Math.floor(context.time / 500) % 2 === 0;
  parts.caret.visible = visible;
  if (!visible) return;
  const anchorX = props.align === "center" ? 0.5 : props.align === "right" ? 1 : 0;
  const x = parts.body.position.x + parts.body.width * (1 - anchorX) + 2;
  parts.caret.clear().rect(x, 1, Math.max(1, 1.5 / Math.max(0.25, context.zoom)), Math.max(12, parts.body.height - 2)).fill({ color: itemColor(context, item.style.fill, "neutral") });
}

function sync(container: Container, item: SceneItem<BoardTextItem>, context: BoardRenderContext) {
  const parts = partsByContainer.get(container);
  if (!parts) return;
  positionShell(parts.root, item);
  const { props } = item;
  const layout = layoutBoardText(props);
  const previewScale = Math.max(0.0001, item.frame.width / Math.max(0.0001, layout.width));
  parts.body.scale.set(previewScale);
  const anchorX = props.align === "center" ? 0.5 : props.align === "right" ? 1 : 0;
  parts.body.anchor.set(anchorX, 0);
  parts.body.position.set(item.frame.width * anchorX, 0);
  syncTextResolution(parts.body, parts, context.zoom * Math.max(1, previewScale));

  const ink = itemColor(context, item.style.fill, "neutral");
  const text = revealed(props.text, props.reveal);
  const contentSig = [text, ink, props.fontSize, props.fontWeight, props.font, props.align, props.lineHeight, props.width ?? ""].join("|");
  if (contentSig !== parts.contentSig) {
    parts.contentSig = contentSig;
    parts.body.text = text;
    Object.assign(parts.body.style, {
      fill: ink,
      fontSize: props.fontSize,
      fontWeight: String(Math.round(props.fontWeight / 100) * 100),
      fontFamily: boardFontFamily(props.font, BOARD_FONT_STACKS),
      align: props.align,
      lineHeight: layout.lineHeight,
      wordWrap: Boolean(props.width),
      wordWrapWidth: props.width ?? 0,
      breakWords: true,
    });
  }
  syncCaret(parts, item, context);
}

export const textCardRenderer: BoardCardRenderer = {
  id: "text-card",
  canRender: (item) => item.type === "text",
  create: (item, context) => {
    const root = new Container();
    const resolution = textResolutionForZoom(context.zoom);
    const body = new Text({ text: "", style: { fontFamily: BOARD_FONT_STACKS.sans }, resolution, roundPixels: true });
    const caret = new Graphics();
    root.addChild(body, caret);
    partsByContainer.set(root, { root, body, caret, resolution, contentSig: "" });
    if (item.type === "text") sync(root, item as SceneItem<BoardTextItem>, context);
    return root;
  },
  update: (container, item, context) => {
    if (item.type === "text") sync(container, item as SceneItem<BoardTextItem>, context);
  },
  renderFar: (graphics, item, context) => {
    if (item.type !== "text") return;
    drawFarPlate(graphics, item.frame, { fill: itemColor(context, item.style.fill, "neutral"), fillAlpha: 0.35 });
  },
  destroy: (container) => {
    partsByContainer.get(container)?.root.destroy({ children: true });
    partsByContainer.delete(container);
  },
};
