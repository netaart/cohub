import { parseBoardMediaSource } from "@cohub/protocol/board-model";
import { featuredTaskArtifact, taskArtifactModelFormat } from "@cohub/protocol";
import { type ModelFormat, modelFormatForPath } from "@cohub/protocol/fs";
import type { BoardSceneItem } from "./scene.js";
import { fileStem } from "./file-snapshot.js";

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
	if (!/^[a-z][a-z\d+.-]*:/i.test(value)) {
		return value.split("/").filter(Boolean).pop() || value;
	}
	try {
		const url = new URL(value);
		const title = url.pathname.split("/").filter(Boolean).pop() || url.hostname;
		try {
			return decodeURIComponent(title);
		} catch {
			return title;
		}
	} catch {
		return value.split("/").filter(Boolean).pop() || value;
	}
}

export function boardModelFormat(
	src: string,
	mimeType?: string | null,
): ModelFormat | null {
	const source = parseBoardMediaSource(src);
	if (!source) return null;
	const path =
		source.kind === "url" ? (source.value.split(/[?#]/, 1)[0] ?? "") : source.value;
	return modelFormatForPath(path, mimeType);
}

export function isBoardModelItem(
	item: BoardSceneItem | null | undefined,
): boolean {
	return (
		item?.type === "file" &&
		boardModelFormat(item.props.src, item.props.snapshot?.mimeType) !== null
	);
}

/** A 3D model a Board item shows: its own file, or a generation result it features. */
export type BoardModelTarget = {
	/** Stable identity for asset caches. */
	key: string;
	src: string;
	format: ModelFormat;
	title: string;
	size?: number;
};

/** The model an item shows in place, or null when it shows none. */
export function boardModelTarget(
	item: BoardSceneItem | null | undefined,
): BoardModelTarget | null {
	if (item?.type === "file") {
		const { src, snapshot } = item.props;
		const format = boardModelFormat(src, snapshot?.mimeType);
		if (!format) return null;
		return {
			key: `${src}:${snapshot?.mtimeMs ?? ""}`,
			src,
			format,
			title: snapshot?.title || fileStem(src),
			...(snapshot?.size === undefined ? {} : { size: snapshot.size }),
		};
	}
	if (item?.type !== "task") return null;
	const artifact = featuredTaskArtifact(item.props.snapshot.artifacts);
	const format = taskArtifactModelFormat(artifact);
	if (artifact?.type !== "3d" || !format) return null;
	return {
		key: artifact.url,
		src: artifact.url,
		format,
		title: artifact.title || fileStem(artifact.url),
	};
}
