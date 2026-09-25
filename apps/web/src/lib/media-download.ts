import { triggerBlobDownload, triggerUrlDownload } from "$lib/browser-download";

export type DownloadableMedia = {
	src: string;
	type: "image" | "video" | "audio";
	filename?: string;
	mimeType?: string;
};

const EXTENSION_BY_MIME: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/avif": "avif",
	"image/svg+xml": "svg",
	"video/mp4": "mp4",
	"video/webm": "webm",
	"video/quicktime": "mov",
	"audio/mpeg": "mp3",
	"audio/mp4": "m4a",
	"audio/aac": "aac",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"audio/ogg": "ogg",
	"audio/flac": "flac",
};
const DEFAULT_EXTENSION = { image: "png", video: "mp4", audio: "mp3" } as const;
const EXTENSION_PATTERN = /\.[a-z0-9]{2,5}$/i;
const UNSAFE_CHARS = /[\\/:*?"<>|]+/g;

function urlBasename(src: string) {
	if (!/^https?:/i.test(src)) return null;
	try {
		const segment = new URL(src).pathname.split("/").filter(Boolean).pop();
		return segment ? decodeURIComponent(segment) : null;
	} catch {
		return null;
	}
}

function dataUrlMime(src: string) {
	return /^data:([^;,]+)/i.exec(src)?.[1] ?? null;
}

/** A safe filename that always carries an extension. */
export function mediaFilename(media: DownloadableMedia): string {
	const base =
		(media.filename ?? urlBasename(media.src) ?? "")
			.replace(UNSAFE_CHARS, "-")
			.trim() || media.type;
	if (EXTENSION_PATTERN.test(base)) return base;
	const mime = (media.mimeType ?? dataUrlMime(media.src))?.toLowerCase();
	const extension =
		(mime && EXTENSION_BY_MIME[mime]) ?? DEFAULT_EXTENSION[media.type];
	return `${base}.${extension}`;
}

/**
 * Fetch as a Blob so `download` is honored; fall back to the URL. `no-store`
 * matters: an `<img>` may have cached this URL without CORS headers, and a
 * cached opaque-origin response fails the fetch's CORS check.
 */
export async function downloadMedia(media: DownloadableMedia) {
	const filename = mediaFilename(media);
	try {
		const response = await fetch(media.src, { cache: "no-store" });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		triggerBlobDownload(await response.blob(), filename);
	} catch {
		triggerUrlDownload(media.src, filename);
	}
}
