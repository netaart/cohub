import type { Texture } from "pixi.js";
import { BoardBitmapTexture } from "../render/bitmap-texture.js";

// HTML-in-Canvas (https://github.com/WICG/html-in-canvas) is still moving; only this file touches it.
type DrawableCanvas = HTMLCanvasElement & {
	onpaint: ((event: Event) => void) | null;
	requestPaint(): void;
	updateElementGeometry(element: Element, options: { canvasTransform: DOMMatrixInit }): void;
};
type DrawableContext = CanvasRenderingContext2D & {
	drawElementImage(element: Element, dx: number, dy: number, dw: number, dh: number): unknown;
};

export function boardViewDrawingSupported(): boolean {
	return (
		typeof HTMLCanvasElement !== "undefined" &&
		typeof CanvasRenderingContext2D !== "undefined" &&
		"requestPaint" in HTMLCanvasElement.prototype &&
		"updateElementGeometry" in HTMLCanvasElement.prototype &&
		"drawElementImage" in CanvasRenderingContext2D.prototype
	);
}

export type BoardViewSurface = {
	readonly element: HTMLCanvasElement;
	readonly texture: Texture | null;
	readonly scale: number;
	resize(width: number, height: number, scale: number): void;
	destroy(): void;
};

export function createBoardViewSurface(
	content: HTMLElement,
	callbacks: {
		allow(): boolean;
		raster(ms: number): void;
		texture(): void;
		error(error: unknown): void;
	},
): BoardViewSurface {
	const canvas = content.ownerDocument.createElement("canvas") as DrawableCanvas;
	canvas.setAttribute("layoutsubtree", "");
	canvas.setAttribute("content", "drawable");
	content.setAttribute("drawable", "");
	canvas.appendChild(content);
	const context = canvas.getContext("2d") as DrawableContext | null;
	const bitmap = new BoardBitmapTexture();
	let scale = 0;
	let revision = 0;
	let destroyed = false;

	canvas.onpaint = () => {
		if (!context || scale === 0) return;
		if (!callbacks.allow()) {
			canvas.requestPaint();
			return;
		}
		const start = performance.now();
		const { width, height } = canvas;
		try {
			context.clearRect(0, 0, width, height);
			context.drawElementImage(content, 0, 0, width, height);
		} catch (error) {
			callbacks.error(error);
			return;
		}
		const copy = createImageBitmap(canvas);
		context.clearRect(0, 0, width, height);
		const current = ++revision;
		callbacks.raster(performance.now() - start);
		copy.then(
			(image) => {
				if (destroyed || current !== revision) return image.close();
				bitmap.update(image);
				callbacks.texture();
			},
			(error: unknown) => {
				if (!destroyed) callbacks.error(error);
			},
		);
	};

	return {
		element: canvas,
		get texture() {
			return bitmap.current;
		},
		get scale() {
			return scale;
		},
		resize(width, height, next) {
			const pixelWidth = Math.max(1, Math.round(width * next));
			const pixelHeight = Math.max(1, Math.round(height * next));
			if (next === scale && pixelWidth === canvas.width && pixelHeight === canvas.height) return;
			scale = next;
			canvas.width = pixelWidth;
			canvas.height = pixelHeight;
			canvas.updateElementGeometry(content, {
				canvasTransform: new DOMMatrix([pixelWidth / Math.max(1, width), 0, 0, pixelHeight / Math.max(1, height), 0, 0]),
			});
			canvas.requestPaint();
		},
		destroy() {
			destroyed = true;
			canvas.onpaint = null;
			bitmap.destroy();
			canvas.width = 0;
			canvas.height = 0;
		},
	};
}
