import type {
	SpaceFsEntry,
	SpaceFsFileResponse,
	SpaceFsPreparingFile,
	SpaceFsSymlink,
} from "@neta-art/cohub";
import { saveFile } from "$lib/downloads.svelte";
import { sdk } from "$lib/sdk";
import { spaceFileSource } from "$lib/space-file-save";
import { type DirectoryListing, readDirectoryPages } from "$lib/space-fs-list";

export type ActiveFsSource =
	| { kind: "live" }
	| { kind: "checkpoint"; checkpointId: string };

export type ActiveFsClient = {
	readonly source: ActiveFsSource;
	readonly sourceKey: string;
	readonly readonly: boolean;
	list: (
		path: string,
		onFirstPage?: (entries: SpaceFsEntry[]) => void,
	) => Promise<DirectoryListing>;
	read: (
		path: string,
		signal?: AbortSignal,
	) => Promise<SpaceFsFileResponse | SpaceFsPreparingFile | SpaceFsSymlink>;
	save: (path: string, knownFile?: SpaceFsFileResponse | null) => Promise<void>;
};

function filenameFromPath(path: string) {
	return path.split("/").pop() ?? "download";
}

function sourceKey(source: ActiveFsSource) {
	return source.kind === "checkpoint"
		? `checkpoint:${source.checkpointId}`
		: "live";
}

export function createActiveFsClient(input: {
	spaceId: string;
	source: ActiveFsSource;
}): ActiveFsClient {
	const { spaceId, source } = input;
	const isCheckpoint = source.kind === "checkpoint";
	const list: ActiveFsClient["list"] = (path, onFirstPage) => {
		const files =
			source.kind === "checkpoint"
				? sdk.space(spaceId).checkpoints(source.checkpointId).files
				: sdk.space(spaceId).files;
		return readDirectoryPages(
			(cursor) => files.list(path, { pagination: true, cursor }),
			onFirstPage,
		);
	};
	const read: ActiveFsClient["read"] = (path, signal) => {
		if (source.kind === "checkpoint") {
			return sdk
				.space(spaceId)
				.checkpoints(source.checkpointId)
				.files.read(path);
		}
		return sdk.space(spaceId).files.read(path, undefined, signal);
	};
	const save: ActiveFsClient["save"] = (path, knownFile) => {
		const files =
			source.kind === "checkpoint"
				? sdk.space(spaceId).checkpoints(source.checkpointId).files
				: sdk.space(spaceId).files;
		// Checkpoint URLs are signed and may have expired since the file was opened.
		const known = source.kind === "live" ? knownFile : null;
		return saveFile({
			key: `${spaceId}:${sourceKey(source)}:${path}`,
			name: filenameFromPath(path),
			mimeType: knownFile?.mimeType,
			source: () => spaceFileSource(files, path, known),
		});
	};
	return {
		source,
		sourceKey: sourceKey(source),
		readonly: isCheckpoint,
		list,
		read,
		save,
	};
}
