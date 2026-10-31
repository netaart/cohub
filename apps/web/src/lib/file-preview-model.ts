import { modelFormatForPath, normalizeMime } from "@cohub/protocol/fs";
import type { SpaceFsFileResponse } from "@neta-art/cohub";
import { isCsvPath, isTextFileResponse } from "$lib/space-file-text";

export type FilePreviewKind =
	| "markdown"
	| "html"
	| "score"
	| "csv"
	| "text"
	| "image"
	| "video"
	| "audio"
	| "pdf"
	| "model3d"
	| "fallback";

export type FilePreviewModel = {
	kind: FilePreviewKind;
	isText: boolean;
	hasRenderedPreview: boolean;
	language: string;
	mediaUrl: string | null;
};

export function isMarkdownPath(path: string) {
	return /\.md$/i.test(path);
}

export function isHtmlPath(path: string) {
	return /\.html?$/i.test(path);
}

export function isScorePath(path: string) {
	return /\.abc$/i.test(path);
}

export function isPdfPath(path: string) {
	return /\.pdf$/i.test(path);
}

export { isCsvPath };

export function isCsvMime(mimeType: string | null | undefined) {
	const mime = normalizeMime(mimeType);
	return (
		mime === "text/csv" ||
		mime === "application/csv" ||
		mime === "text/comma-separated-values"
	);
}

export function filePreviewModel(
	file: SpaceFsFileResponse | null | undefined,
): FilePreviewModel {
	if (!file) {
		return {
			kind: "fallback",
			isText: false,
			hasRenderedPreview: false,
			language: "plaintext",
			mediaUrl: null,
		};
	}
	if (modelFormatForPath(file.path, file.mimeType)) {
		return {
			kind: "model3d",
			isText: false,
			hasRenderedPreview: false,
			language: "plaintext",
			mediaUrl: file.delivery === "url" ? (file.url ?? null) : null,
		};
	}
	const mimeType = normalizeMime(file.mimeType);
	const isText = isTextFileResponse(file);
	const language = isText
		? (file.name.split(".").pop()?.toLowerCase() ?? "plaintext")
		: "plaintext";
	const mediaUrl = isText
		? null
		: file.delivery === "url"
			? (file.url ?? null)
			: `data:${file.mimeType ?? "application/octet-stream"};base64,${file.content}`;
	const kind: FilePreviewKind =
		isText && isMarkdownPath(file.path)
			? "markdown"
			: isText && isHtmlPath(file.path)
				? "html"
				: isText && isScorePath(file.path)
					? "score"
					: isText && (isCsvPath(file.path) || isCsvMime(file.mimeType))
					? "csv"
					: isText
						? "text"
						: mimeType?.startsWith("image/")
							? "image"
							: mimeType?.startsWith("video/")
								? "video"
								: mimeType?.startsWith("audio/")
									? "audio"
									: mimeType === "application/pdf" || isPdfPath(file.path)
										? "pdf"
										: "fallback";
	return {
		kind,
		isText,
		hasRenderedPreview:
			kind === "markdown" ||
			kind === "html" ||
			kind === "score" ||
			kind === "csv",
		language,
		mediaUrl,
	};
}
