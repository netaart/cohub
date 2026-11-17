import { batchUploadEntries } from "@cohub/protocol";
import type { SpaceFsUploadDestination } from "@neta-art/cohub";
import { sdk } from "#lib/sdk.ts";
import {
	type LocalUploadEntry,
	sanitizeRelativePath,
} from "#lib/upload-entries.ts";
import { UploadTransferError } from "#lib/upload-errors.ts";
import { isBrowserManagedUploadHeader } from "#lib/upload-headers.ts";

export type SpaceUploadStage = "preparing" | "uploading" | "importing" | "done";

export type SpaceUploadProgress = {
	stage: SpaceUploadStage;
	uploadedBytes: number;
	totalBytes: number;
	completedFiles: number;
	activeFileIndex?: number;
	activeFileUploadedBytes: number;
	importedFiles: number;
	totalFiles: number;
};

export type SpaceUploadedFile = {
	path: string;
	name: string;
	size: number;
	mimeType: string | null;
};

export type UploadSpaceEntriesOptions = {
	spaceId: string;
	destination?: SpaceFsUploadDestination;
	targetDir?: string;
	entries: LocalUploadEntry[];
	onProgress?: (progress: SpaceUploadProgress) => void;
	signal?: AbortSignal;
};

export function joinUploadPath(...parts: string[]) {
	return parts
		.flatMap((part) => part.split("/"))
		.map((part) => part.trim())
		.filter(Boolean)
		.join("/");
}

function createAbortError() {
	const error = new Error("Upload cancelled");
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal?: AbortSignal) {
	if (signal?.aborted) throw createAbortError();
}

function putWithProgress(
	file: File,
	uploadUrl: string,
	headers: Record<string, string> | undefined,
	onProgress?: (uploaded: number) => void,
	signal?: AbortSignal,
) {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(createAbortError());
			return;
		}
		const xhr = new XMLHttpRequest();
		let settled = false;
		const handleAbort = () => xhr.abort();
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", handleAbort);
			callback();
		};
		try {
			xhr.open("PUT", uploadUrl);
			for (const [key, value] of Object.entries(headers ?? {})) {
				if (isBrowserManagedUploadHeader(key)) continue;
				// Skip empty / control-char values — Safari throws
				// "The string did not match the expected pattern."
				if (/[\r\n\0]/.test(value)) continue;
				xhr.setRequestHeader(key, value);
			}
		} catch (error) {
			finish(() =>
				reject(
					error instanceof Error
						? error
						: new Error("Upload failed: invalid request headers"),
				),
			);
			return;
		}
		xhr.upload.onprogress = (event) => {
			if (!event.lengthComputable) return;
			onProgress?.(event.loaded);
		};
		xhr.onload = () => {
			if (xhr.status >= 200 && xhr.status < 300) finish(resolve);
			else finish(() => reject(new UploadTransferError(xhr.status)));
		};
		xhr.onerror = () => finish(() => reject(new UploadTransferError(0)));
		xhr.onabort = () => finish(() => reject(createAbortError()));
		signal?.addEventListener("abort", handleAbort, { once: true });
		xhr.send(file);
	});
}

function normalizeDestination(input: {
	destination?: SpaceFsUploadDestination;
	targetDir?: string;
}): SpaceFsUploadDestination {
	if (input.destination) {
		if (input.destination.kind === "workspace") {
			return {
				kind: "workspace",
				targetDir: input.destination.targetDir
					? sanitizeRelativePath(input.destination.targetDir)
					: "",
			};
		}
		return input.destination;
	}
	return {
		kind: "workspace",
		targetDir: input.targetDir ? sanitizeRelativePath(input.targetDir) : "",
	};
}

export type MaterializeSpaceEntry = {
	name: string;
	relativePath: string;
	size: number;
	mimeType?: string | null;
	downloadUrl: string;
};

export type MaterializeSpaceEntriesOptions = {
	spaceId: string;
	destination?: SpaceFsUploadDestination;
	targetDir?: string;
	entries: MaterializeSpaceEntry[];
};

const toUploadedFile = (file: {
	path: string;
	name: string;
	size: number;
	mimeType: string | null;
}): SpaceUploadedFile => ({
	path: file.path,
	name: file.name,
	size: file.size,
	mimeType: file.mimeType,
});

/**
 * Materialize already-uploaded durable public URLs into sandbox/workspace.
 * Uses the same createUpload/complete pipeline with entry.downloadUrl (no client PUT).
 */
export async function materializeSpaceEntries({
	spaceId,
	destination,
	targetDir = "",
	entries,
}: MaterializeSpaceEntriesOptions): Promise<SpaceUploadedFile[]> {
	if (entries.length === 0) return [];
	const uploadDestination = normalizeDestination({ destination, targetDir });
	const safeEntries = entries.map((entry) => ({
		...entry,
		relativePath: sanitizeRelativePath(entry.relativePath),
	}));
	const ids = safeEntries.map(() => crypto.randomUUID());
	const plan = await sdk.space(spaceId).files.createUpload({
		destination: uploadDestination,
		entries: safeEntries.map((entry, index) => ({
			id: ids[index],
			name: entry.name,
			relativePath: entry.relativePath,
			size: entry.size,
			mimeType: entry.mimeType ?? null,
			downloadUrl: entry.downloadUrl,
		})),
	});
	// Remote entries have no uploadUrl; complete immediately.
	const complete = await sdk
		.space(spaceId)
		.files.completeUpload(plan.uploadId, {
			entries: ids.map((id) => ({ id })),
		});
	return complete.uploaded.map(toUploadedFile);
}

export async function uploadSpaceEntries({
	spaceId,
	destination,
	targetDir = "",
	entries,
	onProgress,
	signal,
}: UploadSpaceEntriesOptions): Promise<SpaceUploadedFile[]> {
	if (entries.length === 0) return [];
	const uploadDestination = normalizeDestination({ destination, targetDir });
	const safeEntries = entries.map((entry) => ({
		...entry,
		relativePath: sanitizeRelativePath(entry.relativePath),
	}));
	const totalFiles = safeEntries.length;
	const totalBytes = safeEntries.reduce(
		(sum, entry) => sum + entry.file.size,
		0,
	);
	const ids = safeEntries.map(() => crypto.randomUUID());
	const batches = batchUploadEntries(safeEntries, (entry) => entry.file.size);

	let completedFiles = 0;
	let completedBytes = 0;
	let importedFiles = 0;
	const report = (info: {
		stage: SpaceUploadStage;
		activeIndex?: number;
		activeFileUploadedBytes?: number;
	}) => {
		const activeFileUploadedBytes = info.activeFileUploadedBytes ?? 0;
		onProgress?.({
			stage: info.stage,
			uploadedBytes: Math.min(
				totalBytes,
				completedBytes + activeFileUploadedBytes,
			),
			totalBytes,
			completedFiles,
			activeFileIndex: info.activeIndex,
			activeFileUploadedBytes,
			importedFiles,
			totalFiles,
		});
	};

	report({ stage: "preparing" });
	throwIfAborted(signal);

	const uploaded: SpaceUploadedFile[] = [];

	for (const batch of batches) {
		const batchIds = ids.slice(importedFiles, importedFiles + batch.length);
		const plan = await sdk.space(spaceId).files.createUpload(
			{
				destination: uploadDestination,
				entries: batch.map((entry, index) => ({
					id: batchIds[index],
					name: entry.file.name,
					relativePath: entry.relativePath,
					size: entry.file.size,
					mimeType: entry.file.type || null,
					lastModified: entry.file.lastModified,
				})),
			},
			{ signal },
		);
		throwIfAborted(signal);
		const planById = new Map(plan.entries.map((entry) => [entry.id, entry]));

		for (const [index, entry] of batch.entries()) {
			throwIfAborted(signal);
			const globalIndex = importedFiles + index;
			const planned = planById.get(batchIds[index]);
			if (!planned) throw new Error("Upload plan missing file");
			report({ stage: "uploading", activeIndex: globalIndex });
			if (planned.uploadUrl) {
				await putWithProgress(
					entry.file,
					planned.uploadUrl,
					planned.headers,
					(loaded) => {
						report({
							stage: "uploading",
							activeIndex: globalIndex,
							activeFileUploadedBytes: Math.min(entry.file.size, loaded),
						});
					},
					signal,
				);
			}
			completedFiles += 1;
			completedBytes += entry.file.size;
			report({ stage: "uploading" });
		}

		throwIfAborted(signal);
		report({ stage: "importing" });
		const complete = await sdk
			.space(spaceId)
			.files.completeUpload(plan.uploadId, {
				entries: batchIds.map((id) => ({ id })),
			});
		uploaded.push(...complete.uploaded.map(toUploadedFile));
		importedFiles += batch.length;
		report({ stage: "importing" });
	}

	report({ stage: "done" });
	return uploaded;
}
