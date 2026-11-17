import type {
	CaptureQuality,
	CaptureResult,
	FrameSource,
	FrozenFrame,
} from "../types.ts";
import {
	detectCaptureCapabilities,
	iframeCaptureSupportedMessage,
} from "./capabilities.ts";
import { cssRectToPixelRect } from "./geometry.ts";

type VideoWithFrameCallback = HTMLVideoElement & {
	requestVideoFrameCallback?: (callback: () => void) => number;
};

/**
 * Fail fast. Element Capture / ImageCapture are intentionally skipped — on
 * macOS Chrome they commonly hang forever after a successful tab share.
 * Full-tab grab + geometry crop is the reliable path.
 */
const METADATA_TIMEOUT_MS = 2_500;
const PLAY_TIMEOUT_MS = 2_500;
const FRAME_TIMEOUT_MS = 3_500;
const TOTAL_GRAB_TIMEOUT_MS = 6_000;

function waitFrame(): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
	});
}

function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`${label} timed out`));
		}, ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function stopStream(stream: MediaStream | null) {
	if (!stream) return;
	for (const track of stream.getTracks()) track.stop();
}

/**
 * Must be called in the same user-gesture turn as the click.
 * Do not await anything (or write reactive state) before this.
 */
export function requestDisplayMedia(): Promise<MediaStream> {
	return navigator.mediaDevices.getDisplayMedia({
		video: true,
		audio: false,
		// Chromium hints — ignored by browsers that don't support them.
		preferCurrentTab: true,
		selfBrowserSurface: "include",
		surfaceSwitching: "exclude",
		systemAudio: "exclude",
	} as DisplayMediaStreamOptions);
}

function mountHiddenVideo(): HTMLVideoElement {
	const video = document.createElement("video");
	video.playsInline = true;
	video.muted = true;
	video.autoplay = true;
	video.setAttribute("playsinline", "");
	video.setAttribute("muted", "");
	video.setAttribute("autoplay", "");
	// Visible to the compositor (1×1 offscreen) so Chromium decodes frames.
	Object.assign(video.style, {
		position: "fixed",
		left: "0",
		top: "0",
		width: "1px",
		height: "1px",
		opacity: "0.01",
		pointerEvents: "none",
		zIndex: "-1",
	});
	document.documentElement.appendChild(video);
	return video;
}

function waitForMetadata(video: HTMLVideoElement): Promise<void> {
	if (
		video.readyState >= HTMLMediaElement.HAVE_METADATA &&
		video.videoWidth > 0
	) {
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		const onMeta = () => {
			cleanup();
			resolve();
		};
		const onError = () => {
			cleanup();
			reject(new Error("Capture video failed to load"));
		};
		const cleanup = () => {
			video.removeEventListener("loadedmetadata", onMeta);
			video.removeEventListener("error", onError);
		};
		video.addEventListener("loadedmetadata", onMeta);
		video.addEventListener("error", onError);
	});
}

function waitForVideoFrame(video: HTMLVideoElement): Promise<void> {
	const withCallback = video as VideoWithFrameCallback;
	const rVFC = withCallback.requestVideoFrameCallback?.bind(withCallback);

	if (video.videoWidth > 0 && video.videoHeight > 0 && rVFC) {
		return new Promise((resolve) => {
			rVFC(() => resolve());
		});
	}

	return new Promise((resolve, reject) => {
		let attempts = 0;
		const tick = () => {
			if (video.videoWidth > 0 && video.videoHeight > 0) {
				if (rVFC) {
					rVFC(() => resolve());
				} else {
					// One paint after dimensions appear is enough for createImageBitmap.
					requestAnimationFrame(() => resolve());
				}
				return;
			}
			attempts += 1;
			if (attempts > 90) {
				reject(new Error("Capture stream has no video frames"));
				return;
			}
			requestAnimationFrame(tick);
		};
		tick();
	});
}

async function grabFrameViaVideo(
	stream: MediaStream,
): Promise<{ bitmap: ImageBitmap; width: number; height: number }> {
	const video = mountHiddenVideo();
	try {
		video.srcObject = stream;

		// Kick playback immediately alongside metadata wait.
		void video.play().catch(() => {
			// Autoplay may already be running; retry after metadata if still paused.
		});

		await withTimeout(
			waitForMetadata(video),
			METADATA_TIMEOUT_MS,
			"Capture metadata",
		);

		if (video.paused) {
			await withTimeout(video.play(), PLAY_TIMEOUT_MS, "Capture playback");
		}

		await withTimeout(
			waitForVideoFrame(video),
			FRAME_TIMEOUT_MS,
			"Capture frame",
		);

		if (video.videoWidth <= 0 || video.videoHeight <= 0) {
			throw new Error("Capture stream has no video frames");
		}

		// Prefer VideoFrame when available — more reliable than createImageBitmap(video)
		// for display-media on some Chromium builds.
		const bitmap = await grabBitmapFromVideo(video);
		return { bitmap, width: bitmap.width, height: bitmap.height };
	} finally {
		try {
			video.pause();
		} catch {
			// ignore
		}
		video.srcObject = null;
		video.remove();
	}
}

async function grabBitmapFromVideo(
	video: HTMLVideoElement,
): Promise<ImageBitmap> {
	const VideoFrameCtor = (
		window as unknown as {
			VideoFrame?: new (
				source: CanvasImageSource,
			) => {
				displayWidth: number;
				displayHeight: number;
				close: () => void;
			};
		}
	).VideoFrame;

	if (typeof VideoFrameCtor === "function") {
		let frame: {
			displayWidth: number;
			displayHeight: number;
			close: () => void;
		} | null = null;
		try {
			frame = new VideoFrameCtor(video);
			const bitmap = await createImageBitmap(
				frame as unknown as ImageBitmapSource,
			);
			return bitmap;
		} catch {
			// Fall through to createImageBitmap(video) / canvas.
		} finally {
			try {
				frame?.close();
			} catch {
				// ignore
			}
		}
	}

	try {
		return await createImageBitmap(video);
	} catch {
		// Last resort: paint into a canvas.
		const canvas = document.createElement("canvas");
		canvas.width = video.videoWidth;
		canvas.height = video.videoHeight;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Failed to create capture canvas");
		ctx.drawImage(video, 0, 0);
		return createImageBitmap(canvas);
	}
}

async function grabVideoFrame(
	stream: MediaStream,
): Promise<{ bitmap: ImageBitmap; width: number; height: number }> {
	return withTimeout(
		grabFrameViaVideo(stream),
		TOTAL_GRAB_TIMEOUT_MS,
		"Capture frame",
	);
}

async function cropBitmap(
	bitmap: ImageBitmap,
	rect: { x: number; y: number; width: number; height: number },
): Promise<ImageBitmap> {
	return createImageBitmap(bitmap, rect.x, rect.y, rect.width, rect.height);
}

function maybeGeometryCrop(
	bitmap: ImageBitmap,
	rect: DOMRect,
	quality: CaptureQuality,
): Promise<{
	bitmap: ImageBitmap;
	width: number;
	height: number;
	quality: CaptureQuality;
}> {
	const width = bitmap.width;
	const height = bitmap.height;
	if (quality !== "full") {
		return Promise.resolve({ bitmap, width, height, quality });
	}

	const dpr = window.devicePixelRatio || 1;
	const viewportW = Math.round(window.innerWidth * dpr);
	const viewportH = Math.round(window.innerHeight * dpr);
	// Tab share may include Chrome's "Sharing this tab" banner, so allow a looser match.
	const looksLikeCurrentTab =
		Math.abs(width - viewportW) / Math.max(width, viewportW) < 0.2 &&
		Math.abs(height - viewportH) / Math.max(height, viewportH) < 0.25;
	if (!looksLikeCurrentTab) {
		return Promise.resolve({ bitmap, width, height, quality });
	}

	const pixelRect = cssRectToPixelRect(rect, {
		dpr,
		frameWidth: width,
		frameHeight: height,
	});
	const areaRatio =
		(pixelRect.width * pixelRect.height) / Math.max(1, width * height);
	if (areaRatio >= 0.98 || pixelRect.width <= 8 || pixelRect.height <= 8) {
		return Promise.resolve({ bitmap, width, height, quality });
	}

	return cropBitmap(bitmap, pixelRect)
		.then((cropped) => {
			bitmap.close();
			return {
				bitmap: cropped,
				width: cropped.width,
				height: cropped.height,
				quality: "cropped-window" as const,
			};
		})
		.catch(() => ({ bitmap, width, height, quality }));
}

function captureFailureMessage(error: unknown): string {
	if (error instanceof Error && /timed out/i.test(error.message)) {
		return "Capture stalled after sharing. Prefer this tab, then try again.";
	}
	if (error instanceof Error && error.message) return error.message;
	return "Failed to capture preview.";
}

function mapCaptureError(error: unknown): CaptureResult {
	const name =
		error && typeof error === "object" && "name" in error
			? String((error as { name?: string }).name)
			: "";
	if (name === "NotAllowedError" || name === "PermissionDeniedError") {
		return {
			ok: false,
			reason: "permission-denied",
			message: "Capture cancelled or permission denied.",
		};
	}
	if (name === "NotSupportedError" || name === "NotFoundError") {
		return {
			ok: false,
			reason: "unsupported",
			message: "Screen capture isn’t supported in this browser.",
		};
	}
	if (name === "AbortError") {
		return {
			ok: false,
			reason: "permission-denied",
			message: "Capture cancelled.",
		};
	}
	return {
		ok: false,
		reason: "capture-failed",
		message: captureFailureMessage(error),
	};
}

/**
 * Capture an iframe preview from an already-granted display-media stream.
 * Call {@link requestDisplayMedia} first in the click gesture turn.
 */
export async function captureIframeElementFromStream(input: {
	stream: MediaStream;
	element: HTMLIFrameElement;
	source: Extract<FrameSource, { kind: "html" | "port" }>;
}): Promise<CaptureResult> {
	let stream: MediaStream | null = input.stream;
	const readyRect = input.element.getBoundingClientRect();
	if (readyRect.width < 2 || readyRect.height < 2) {
		stopStream(stream);
		return {
			ok: false,
			reason: "iframe-not-ready",
			message: "Preview isn’t ready to capture yet.",
		};
	}

	try {
		const track = stream.getVideoTracks()[0];
		if (!track) {
			stopStream(stream);
			stream = null;
			return {
				ok: false,
				reason: "capture-failed",
				message: "No video track from screen capture.",
			};
		}

		// Give the compositor one beat after the share picker closes.
		await waitFrame();

		// Re-measure after the picker closes — layout can shift while sharing.
		const rect = input.element.getBoundingClientRect();

		// Skip Element Capture (restrictTo/cropTo) and ImageCapture entirely.
		// On macOS Chrome those APIs often hang after a successful tab share.
		// Full tab + geometry crop is fast and reliable.
		const grabbed = await grabVideoFrame(stream);

		stopStream(stream);
		stream = null;

		const cropRect = rect.width >= 2 && rect.height >= 2 ? rect : readyRect;
		const cropped = await maybeGeometryCrop(grabbed.bitmap, cropRect, "full");
		const frame: FrozenFrame = {
			bitmap: cropped.bitmap,
			width: cropped.width,
			height: cropped.height,
			dpr: window.devicePixelRatio || 1,
			capturedAt: Date.now(),
			quality: cropped.quality,
			source: input.source,
		};
		return { ok: true, frame };
	} catch (error) {
		stopStream(stream);
		return mapCaptureError(error);
	}
}

/**
 * Capture the full shared tab / window (no iframe crop).
 * Used by the global mark hotkey when no preview target is active.
 */
export async function captureViewportFromStream(input: {
	stream: MediaStream;
}): Promise<CaptureResult> {
	let stream: MediaStream | null = input.stream;
	try {
		const track = stream.getVideoTracks()[0];
		if (!track) {
			stopStream(stream);
			stream = null;
			return {
				ok: false,
				reason: "capture-failed",
				message: "No video track from screen capture.",
			};
		}

		await waitFrame();
		const grabbed = await grabVideoFrame(stream);
		stopStream(stream);
		stream = null;

		const frame: FrozenFrame = {
			bitmap: grabbed.bitmap,
			width: grabbed.width,
			height: grabbed.height,
			dpr: window.devicePixelRatio || 1,
			capturedAt: Date.now(),
			quality: "full",
			source: { kind: "viewport" },
		};
		return { ok: true, frame };
	} catch (error) {
		stopStream(stream);
		return mapCaptureError(error);
	}
}

export async function captureIframeElement(input: {
	element: HTMLIFrameElement;
	source: Extract<FrameSource, { kind: "html" | "port" }>;
	/** Pre-started stream from {@link requestDisplayMedia} (preferred). */
	stream?: MediaStream;
}): Promise<CaptureResult> {
	const caps = detectCaptureCapabilities();
	const unsupported = iframeCaptureSupportedMessage(caps);
	if (unsupported) {
		return { ok: false, reason: "unsupported", message: unsupported };
	}

	const readyRect = input.element.getBoundingClientRect();
	if (readyRect.width < 2 || readyRect.height < 2) {
		return {
			ok: false,
			reason: "iframe-not-ready",
			message: "Preview isn’t ready to capture yet.",
		};
	}

	let stream: MediaStream | null = input.stream ?? null;
	try {
		if (!stream) {
			// Fallback path — may fail if not in a user-gesture turn.
			stream = await requestDisplayMedia();
		}
		return await captureIframeElementFromStream({
			stream,
			element: input.element,
			source: input.source,
		});
	} catch (error) {
		stopStream(stream);
		return mapCaptureError(error);
	}
}
