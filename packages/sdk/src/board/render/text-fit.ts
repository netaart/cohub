import { CanvasTextMetrics, fontStringFromTextStyle, type Text } from "pixi.js";
import { fitLineWithEllipsis, layoutTextLines } from "./text-measurement.js";

export function fitTextToLines(
	text: Text,
	value: string,
	maxLines: number,
	wrapWidth: number,
): void {
	text.style.wordWrap = false;
	const { lines } = layoutTextLines(value, fontStringFromTextStyle(text.style), Math.max(1, wrapWidth), { maxLines });
	const fitted = lines.join("\n");
	if (text.text !== fitted) text.text = fitted;
}

export function fitTextToWidth(text: Text, value: string, width: number): void {
	text.style.wordWrap = false;
	const measure = (candidate: string) => CanvasTextMetrics.measureText(candidate, text.style).width;
	const fitted = !value || measure(value) <= width ? value : fitLineWithEllipsis(value, width, measure);
	if (text.text !== fitted) text.text = fitted;
}
