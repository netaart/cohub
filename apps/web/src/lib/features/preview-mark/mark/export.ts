import type { FrozenFrame, Stroke } from "../types.ts";
import { drawStroke } from "./draw.ts";

const FILE_FORMATS: Array<{
	mimeType: "image/webp" | "image/jpeg";
	extension: "webp" | "jpg";
	quality: number;
}> = [
	{ mimeType: "image/webp", extension: "webp", quality: 0.9 },
	{ mimeType: "image/jpeg", extension: "jpg", quality: 0.9 },
];

const MAX_EDGE = 2560;

function canvasToBlob(
	canvas: HTMLCanvasElement,
	mimeType: string,
	quality?: number,
): Promise<Blob | null> {
	return new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
}

function renderMarkedCanvas(input: {
	frame: FrozenFrame;
	strokes: Stroke[];
}): HTMLCanvasElement {
	const longest = Math.max(input.frame.width, input.frame.height);
	const scale = longest > MAX_EDGE ? MAX_EDGE / longest : 1;
	const width = Math.max(1, Math.round(input.frame.width * scale));
	const height = Math.max(1, Math.round(input.frame.height * scale));

	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Canvas is not available.");

	ctx.drawImage(input.frame.bitmap, 0, 0, width, height);
	for (const stroke of input.strokes) {
		drawStroke(ctx, stroke, { scale });
	}
	return canvas;
}

export async function exportMarkedFrame(input: {
	frame: FrozenFrame;
	strokes: Stroke[];
	filename: string;
}): Promise<File> {
	const canvas = renderMarkedCanvas(input);

	for (const format of FILE_FORMATS) {
		const blob = await canvasToBlob(canvas, format.mimeType, format.quality);
		if (!blob || blob.type !== format.mimeType) continue;
		const base = input.filename.replace(/\.[^.]+$/, "") || "preview-marked";
		return new File([blob], `${base}.${format.extension}`, {
			type: format.mimeType,
			lastModified: Date.now(),
		});
	}
	throw new Error("Failed to encode marked image.");
}

/** PNG blob for clipboard (widely supported by ClipboardItem). */
export async function exportMarkedPngBlob(input: {
	frame: FrozenFrame;
	strokes: Stroke[];
}): Promise<Blob> {
	const canvas = renderMarkedCanvas(input);
	const blob = await canvasToBlob(canvas, "image/png");
	if (blob?.type !== "image/png") {
		throw new Error("Failed to encode marked image as PNG.");
	}
	return blob;
}

/**
 * Copy the marked frame to the system clipboard as an image.
 * Passes a Promise into ClipboardItem so browsers keep user activation across
 * the encode step.
 */
export async function copyMarkedFrameToClipboard(input: {
	frame: FrozenFrame;
	strokes: Stroke[];
}): Promise<void> {
	if (typeof navigator === "undefined" || !navigator.clipboard?.write) {
		throw new Error("Clipboard image copy isn’t supported in this browser.");
	}
	if (typeof ClipboardItem === "undefined") {
		throw new Error("Clipboard image copy isn’t supported in this browser.");
	}

	const pngPromise = exportMarkedPngBlob(input);
	try {
		await navigator.clipboard.write([
			new ClipboardItem({ "image/png": pngPromise }),
		]);
	} catch (error) {
		// Some browsers reject Promise values; retry with a resolved blob.
		const blob = await pngPromise;
		try {
			await navigator.clipboard.write([
				new ClipboardItem({ "image/png": blob }),
			]);
		} catch {
			throw error instanceof Error
				? error
				: new Error("Failed to copy image to clipboard.");
		}
	}
}
