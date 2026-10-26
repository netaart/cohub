import { batchUploadEntries } from "@cohub/protocol";
import type { UploadGroup, UploadConfig, SpaceFsUploadDestination, SpaceFsCreateUploadResponse, UploadTask } from "@neta-art/cohub";
import { sdk } from "$lib/sdk";
import {
	type LocalUploadEntry,
	sanitizeRelativePath,
} from "$lib/upload-entries";

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
	upload?: Partial<UploadConfig> | UploadGroup;
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
	upload?: Partial<UploadConfig> | UploadGroup;
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
	upload,
}: MaterializeSpaceEntriesOptions): Promise<SpaceUploadedFile[]> {
	if (entries.length === 0) return [];
	const group = sdk.createUploadGroup(upload);
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
	}, { upload: group });
	// Remote entries have no uploadUrl; complete immediately.
	const complete = await sdk
		.space(spaceId)
		.files.completeUpload(plan.uploadId, {
			entries: ids.map((id) => ({ id })),
		}, { upload: group });
	return complete.uploaded.map(toUploadedFile);
}

export type SpaceUploadTask = {
	run(options?: Pick<UploadSpaceEntriesOptions, "onProgress" | "signal">): Promise<SpaceUploadedFile[]>;
	cancel(): Promise<void>;
};

export function createSpaceUploadTask({
	spaceId,
	destination,
	targetDir = "",
	entries,
	upload,
}: Omit<UploadSpaceEntriesOptions, "onProgress" | "signal">): SpaceUploadTask {
	const files = sdk.space(spaceId).files;
	const group = sdk.createUploadGroup(upload);
	const uploadDestination = normalizeDestination({ destination, targetDir });
	const safeEntries = entries.map((entry) => ({
		...entry,
		id: crypto.randomUUID(),
		relativePath: sanitizeRelativePath(entry.relativePath),
	}));
	const totalBytes = safeEntries.reduce((sum, entry) => sum + entry.file.size, 0);
	const batches = batchUploadEntries(safeEntries, (entry) => entry.file.size).map((entries) => ({
		entries,
		requestId: crypto.randomUUID(),
		plan: undefined as SpaceFsCreateUploadResponse | undefined,
	}));
	const transfers = new Map<string, UploadTask<void>>();
	const transferred = new Set<string>();
	const uploaded: SpaceUploadedFile[] = [];
	let completedBytes = 0;
	let importedFiles = 0;
	let batchIndex = 0;
	let cancelled = false;
	let running: Promise<SpaceUploadedFile[]> | undefined;
	let controller: AbortController | undefined;

	async function run({ onProgress, signal }: Pick<UploadSpaceEntriesOptions, "onProgress" | "signal"> = {}) {
		if (cancelled) throw createAbortError();
		controller = new AbortController();
		const abort = () => controller?.abort();
		if (signal?.aborted) controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		const runSignal = controller.signal;
		const report = (stage: SpaceUploadStage, activeIndex?: number, activeFileUploadedBytes = 0) => {
			onProgress?.({
				stage,
				uploadedBytes: Math.min(totalBytes, completedBytes + activeFileUploadedBytes),
				totalBytes,
				completedFiles: transferred.size,
				activeFileIndex: activeIndex,
				activeFileUploadedBytes,
				importedFiles,
				totalFiles: safeEntries.length,
			});
		};
		try {
			report("preparing");
			for (; batchIndex < batches.length; batchIndex += 1) {
				throwIfAborted(runSignal);
				const batch = batches[batchIndex];
				batch.plan ??= await files.createUpload({
					uploadRequestId: batch.requestId,
					destination: uploadDestination,
					entries: batch.entries.map((entry) => ({
						id: entry.id,
						name: entry.file.name,
						relativePath: entry.relativePath,
						size: entry.file.size,
						mimeType: entry.file.type || null,
						lastModified: entry.file.lastModified,
					})),
				}, { signal: runSignal, upload: group });
				const planById = new Map(batch.plan.entries.map((entry) => [entry.id, entry]));
				for (const entry of batch.entries) {
					const planned = planById.get(entry.id);
					if (!planned) throw new Error("Upload plan missing file");
					if (!transfers.has(entry.id)) transfers.set(entry.id, files.createUploadTask(planned, entry.file, { upload: group }));
				}
				for (const [index, entry] of batch.entries.entries()) {
					throwIfAborted(runSignal);
					if (transferred.has(entry.id)) continue;
					const transfer = transfers.get(entry.id);
					if (!transfer) throw new Error("Upload task missing file");
					await transfer.run({
						signal: runSignal,
						onProgress: ({ loadedBytes }) => report("uploading", importedFiles + index, loadedBytes),
					});
					transferred.add(entry.id);
					completedBytes += entry.file.size;
					report("uploading");
				}
				throwIfAborted(runSignal);
				report("importing");
				const complete = await files.completeUpload(batch.plan.uploadId, {
					entries: batch.entries.map(({ id }) => ({ id })),
				}, { upload: group });
				uploaded.push(...complete.uploaded.map(toUploadedFile));
				importedFiles += batch.entries.length;
				report("importing");
			}
			report("done");
			return uploaded;
		} finally {
			signal?.removeEventListener("abort", abort);
			controller = undefined;
		}
	}

	return {
		run(options) {
			running ??= run(options).finally(() => { running = undefined; });
			return running;
		},
		async cancel() {
			cancelled = true;
			controller?.abort();
			await running?.catch(() => {});
			await Promise.allSettled([...transfers.values()].map((transfer) => transfer.cancel()));
		},
	};
}

export function uploadSpaceEntries(options: UploadSpaceEntriesOptions): Promise<SpaceUploadedFile[]> {
	return createSpaceUploadTask(options).run(options);
}
