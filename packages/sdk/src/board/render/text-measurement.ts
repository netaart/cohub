
import { BOARD_FONT_STACK, BOARD_MONO_FONT_STACK } from "@cohub/protocol/board-constants";
import { DOMAdapter } from "pixi.js";
import { setBoardTextMeasurer } from "@cohub/protocol";
import { boardFontFamily } from "../model/text-metrics.js";

export const BOARD_FONT_STACKS = {
  sans: BOARD_FONT_STACK,
  serif: 'ui-serif, Georgia, "Noto Serif CJK SC", "Songti SC", serif',
  mono: BOARD_MONO_FONT_STACK,
};

type MeasureContext = {
  font: string;
  measureText: (text: string) => { width: number };
};

let measureContext: MeasureContext | null | undefined;
let installed = false;

function getMeasureContext(): MeasureContext | null {
  if (measureContext !== undefined) return measureContext;
  try {
    const canvas = DOMAdapter.get().createCanvas(1, 1);
    measureContext = (canvas.getContext("2d") as MeasureContext | null) ?? null;
  } catch {
    measureContext = null;
  }
  return measureContext;
}

function measureText(text: string, fontSize: number, fontWeight: number, font: string): number | null {
  const context = getMeasureContext();
  if (!context) return null;
  context.font = `${fontWeight} ${fontSize}px ${boardFontFamily(font, BOARD_FONT_STACKS)}`;
  return context.measureText(text).width;
}

export function installBoardTextMeasurement(): void {
  measureContext = undefined;
  installed = true;
  setBoardTextMeasurer(measureText);
}

export function ensureBoardTextMeasurement(): void {
  if (installed) return;
  installBoardTextMeasurement();
}
