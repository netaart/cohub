import type { CaptureResult, FrameSource } from "../types.ts";

export async function captureImageSource(input: {
	src: string;
	path: string;
}): Promise<CaptureResult> {
	try {
		const bitmap = await loadBitmap(input.src);
		const source: FrameSource = { kind: "image", path: input.path };
		return {
			ok: true,
			frame: {
				bitmap,
				width: bitmap.width,
				height: bitmap.height,
				dpr: 1,
				capturedAt: Date.now(),
				quality: "image",
				source,
			},
		};
	} catch {
		return {
			ok: false,
			reason: "capture-failed",
			message: "Could not load this image for marking.",
		};
	}
}

async function loadBitmap(src: string): Promise<ImageBitmap> {
	if (src.startsWith("blob:") || src.startsWith("data:")) {
		const response = await fetch(src);
		if (!response.ok) throw new Error("Failed to fetch image");
		const blob = await response.blob();
		return createImageBitmap(blob);
	}
	const image = await loadHtmlImage(src);
	return createImageBitmap(image);
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.crossOrigin = "anonymous";
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error("Failed to decode image"));
		image.src = src;
	});
}
