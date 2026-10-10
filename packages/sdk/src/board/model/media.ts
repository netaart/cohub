const IMAGE_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"avif",
	"svg",
]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v"]);
const AUDIO_EXTENSIONS = new Set([
	"mp3",
	"wav",
	"ogg",
	"m4a",
	"aac",
	"flac",
	"opus",
]);
const TEXT_EXTENSIONS = new Set([
	"txt",
	"md",
	"json",
	"yaml",
	"yml",
	"csv",
	"ts",
	"tsx",
	"js",
	"jsx",
	"css",
	"html",
	"xml",
	"py",
	"sh",
]);

export type BoardMediaKind = "image" | "video" | "audio" | "text" | "file";

export function getMediaExtension(value: string) {
	const clean = value.split(/[?#]/, 1)[0] ?? value;
	const name = clean.split("/").pop() ?? clean;
	const index = name.lastIndexOf(".");
	return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}

export function inferBoardMediaKind(
	value: string,
	mimeType?: string | null,
): BoardMediaKind {
	if (mimeType?.startsWith("image/")) return "image";
	if (mimeType?.startsWith("video/")) return "video";
	if (mimeType?.startsWith("audio/")) return "audio";
	if (mimeType?.startsWith("text/") || mimeType === "application/json")
		return "text";
	const extension = getMediaExtension(value);
	if (IMAGE_EXTENSIONS.has(extension)) return "image";
	if (VIDEO_EXTENSIONS.has(extension)) return "video";
	if (AUDIO_EXTENSIONS.has(extension)) return "audio";
	if (TEXT_EXTENSIONS.has(extension)) return "text";
	return "file";
}

export function getMediaResourceTitle(value: string) {
	try {
		const url = new URL(value);
		return decodeURIComponent(
			url.pathname.split("/").filter(Boolean).pop() || url.hostname,
		);
	} catch {
		return value.split("/").filter(Boolean).pop() || value;
	}
}
