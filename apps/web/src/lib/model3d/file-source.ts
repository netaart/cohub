import { modelFormatForPath } from "@cohub/protocol/fs";
import type { SpaceFsFileResponse } from "@neta-art/cohub";
import {
	fetchModelBytes,
	type ModelSource,
	spaceModelReferences,
} from "@neta-art/cohub/board/render";
import type { ResolveWorkspaceAsset } from "$lib/workspace-assets";

function decodeBase64(value: string): Uint8Array {
	const native = (Uint8Array as { fromBase64?: (value: string) => Uint8Array })
		.fromBase64;
	if (native) return native(value);
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

/** A Space file as a model source; its sidecar files resolve beside it. */
export function fileModelSource(
	file: SpaceFsFileResponse,
	resolve: ResolveWorkspaceAsset | undefined,
): ModelSource | null {
	const format = modelFormatForPath(file.path, file.mimeType);
	if (!format) return null;
	return {
		key: `${file.path}:${file.size}:${file.mtimeMs}:${file.url ?? ""}`,
		name: file.name,
		format,
		size: file.size,
		async read(options) {
			if (file.delivery !== "url")
				return file.encoding === "base64"
					? decodeBase64(file.content)
					: new TextEncoder().encode(file.content);
			if (!file.url) throw new Error("Model URL is missing");
			return fetchModelBytes(file.url, { ...options, expectedSize: file.size });
		},
		references: spaceModelReferences(file.path, async (path, signal) =>
			resolve ? (await resolve(path, { signal })).src : null,
		),
	};
}
