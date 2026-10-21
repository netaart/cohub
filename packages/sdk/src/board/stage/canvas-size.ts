import { getBoardResolution } from "../render/text-resolution.js";

export type BoardCanvasBox = {
	width: number;
	height: number;
	density: number;
	device: { width: number; height: number } | null;
};

export function measureBoardCanvasBox(entry: ResizeObserverEntry, density: number): BoardCanvasBox {
	const css = entry.contentBoxSize?.[0];
	const device = entry.devicePixelContentBoxSize?.[0];
	return {
		width: css?.inlineSize ?? entry.contentRect.width,
		height: css?.blockSize ?? entry.contentRect.height,
		density,
		device: device ? { width: device.inlineSize, height: device.blockSize } : null,
	};
}

export function boardCanvasSize(box: BoardCanvasBox, density: number) {
	const resolution = getBoardResolution(box, density);
	const { device } = box;
	if (device && box.density === density && resolution === density) {
		return { width: device.width / density, height: device.height / density, resolution };
	}
	return { width: box.width, height: box.height, resolution };
}
