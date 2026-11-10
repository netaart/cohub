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

export function boardCanvasSize(box: BoardCanvasBox | null, host: { width: number; height: number }, density: number) {
	const fresh = box && box.width > 0 && box.height > 0 && box.density === density ? box : null;
	const { width, height } = fresh ?? host;
	const scale = fresh?.device && fresh.device.width > 0 ? fresh.device.width / width : density;
	return { width, height, resolution: getBoardResolution({ width, height }, scale) };
}
