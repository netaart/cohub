import type {
	SpaceFsFileResponse,
	SpaceFsPreparingFile,
} from "@neta-art/cohub";
import { parseBoardManifest } from "@neta-art/cohub/board";
import { tryResolveTextFileResponse } from "$lib/space-file-text";

/**
 * Extract UTF-8 manifest text from a Space FS response.
 * Prefers `kind: "text"`, and recovers JSON text from base64 binary payloads
 * for .board reads that were misclassified despite the extension MIME
 * was registered as application/json.
 */
export function resolveBoardManifestText(
	file: SpaceFsFileResponse,
): string | null {
	if (file.kind === "text" && typeof file.content === "string") {
		return file.content;
	}
	if (file.encoding !== "base64" || !file.content) return null;
	try {
		const binary = atob(file.content);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) {
			bytes[i] = binary.charCodeAt(i);
		}
		// Reject obvious binary (NUL).
		for (let i = 0; i < bytes.length; i += 1) {
			if ((bytes[i] ?? 0) === 0) return null;
		}
		const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
		const trimmed = text.trimStart();
		if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
		return text;
	} catch {
		return null;
	}
}

export async function readBoardManifestId(
	rawFile: SpaceFsFileResponse | SpaceFsPreparingFile,
): Promise<string> {
	if (!rawFile || typeof rawFile !== "object" || !("content" in rawFile))
		throw new Error("Board manifest is being prepared. Retry in a moment.");
	const { file, error } = await tryResolveTextFileResponse(rawFile);
	if (error) throw new Error(error);
	const content = resolveBoardManifestText(file);
	if (content == null) throw new Error("Board manifest must be a text file.");
	const manifest = parseBoardManifest(content);
	if (!manifest) throw new Error("Board manifest is invalid.");
	return manifest.boardId;
}
