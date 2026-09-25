import type { SpaceFsFileResponse } from "@neta-art/cohub";
import { PUBLIC_API_ORIGIN } from "$env/static/public";
import { triggerBlobDownload, triggerUrlDownload } from "$lib/browser-download";
import { sdk } from "$lib/sdk";

export function buildSpaceFileDownloadUrl(spaceId: string, path: string) {
	const directUrl = sdk.space(spaceId).files.getDownloadUrl(path);
	const baseUrl = PUBLIC_API_ORIGIN ?? "";
	return `${baseUrl}${directUrl}`;
}

function base64ToBlob(content: string, mimeType: string) {
	const binary = atob(content);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return new Blob([bytes], { type: mimeType });
}

export async function downloadFileResponse(
	file: SpaceFsFileResponse,
	filename?: string,
): Promise<boolean> {
	const resolvedFilename = filename ?? file.name ?? "download";

	if (file.delivery === "url" && file.url) {
		triggerUrlDownload(file.url, resolvedFilename);
		return true;
	}

	if (file.kind === "text") {
		triggerBlobDownload(
			new Blob([file.content], {
				type: file.mimeType ?? "text/plain;charset=utf-8",
			}),
			resolvedFilename,
		);
		return true;
	}

	if (file.content) {
		triggerBlobDownload(
			base64ToBlob(file.content, file.mimeType ?? "application/octet-stream"),
			resolvedFilename,
		);
		return true;
	}

	return false;
}

export async function downloadSpaceFile(
	spaceId: string,
	path: string,
	filename?: string,
	knownFile?: SpaceFsFileResponse | null,
) {
	try {
		if (knownFile && (await downloadFileResponse(knownFile, filename))) return;
	} catch (error) {
		console.debug(
			"Falling back from known space file response download",
			error,
		);
	}

	try {
		const file = await sdk.space(spaceId).files.read(path);
		if ("content" in file && (await downloadFileResponse(file, filename)))
			return;
	} catch (error) {
		// Keep the legacy download endpoint as a fallback for files that cannot be
		// represented by the preview/read API, e.g. oversized non-CDN artifacts.
		console.debug("Falling back to space file download endpoint", error);
	}

	triggerUrlDownload(
		buildSpaceFileDownloadUrl(spaceId, path),
		filename ?? "download",
	);
}
