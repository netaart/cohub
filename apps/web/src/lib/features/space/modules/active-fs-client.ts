import type {
	SpaceFsEntry,
	SpaceFsFileResponse,
	SpaceFsPreparingFile,
	SpaceFsSymlink,
} from "@neta-art/cohub";
import { sdk } from "$lib/sdk";
import {
	buildSpaceFileDownloadUrl,
	downloadFileResponse,
	downloadSpaceFile,
} from "$lib/space-file-download";
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
	download: (
		path: string,
		knownFile?: SpaceFsFileResponse | null,
	) => Promise<void>;
	getDownloadUrl: (
		path: string,
		knownFile?: SpaceFsFileResponse | null,
	) => string;
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
	const download: ActiveFsClient["download"] = async (path, knownFile) => {
		const filename = filenameFromPath(path);
		if (source.kind === "live") {
			await downloadSpaceFile(spaceId, path, filename, knownFile);
			return;
		}
		if (knownFile && (await downloadFileResponse(knownFile, filename))) return;
		const file = await read(path);
		if ("content" in file && (await downloadFileResponse(file, filename)))
			return;
		throw new Error("Checkpoint file download is not available for this file.");
	};
	const getDownloadUrl: ActiveFsClient["getDownloadUrl"] = (
		path,
		knownFile,
	) => {
		if (source.kind === "checkpoint") {
			return knownFile?.delivery === "url" ? (knownFile.url ?? "") : "";
		}
		return buildSpaceFileDownloadUrl(spaceId, path);
	};
	return {
		source,
		sourceKey: sourceKey(source),
		readonly: isCheckpoint,
		list,
		read,
		download,
		getDownloadUrl,
	};
}
