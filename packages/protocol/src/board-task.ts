import {
	BOARD_TASK_ARTIFACT_LIMIT,
	type BoardTaskArtifact,
	type BoardTaskSnapshot,
} from "./board-model.js";
import { type ModelFormat, modelFormatForPath } from "./fs/mime.js";
import {
	blockDurationMs,
	blockFormat,
	blockIdentity,
	blockMimeType,
	blockNaturalSize,
	blockPreviewUrl,
	blockText,
	blockTitle,
	blockUrl,
	cleanExcerpt,
	generationCovers,
	generationOutput,
	generationPrompt,
	taskData,
	type GenerationRunPayload,
} from "./generation/blocks.js";
import type { TaskRunStatus } from "./task/index.js";

export type BoardTaskRunSource = GenerationRunPayload & {
	taskType: string;
	status: TaskRunStatus;
	errorMessage?: string | null;
	startedAt?: string | null;
	updatedAt: string;
};

export const BOARD_TASK_SOURCE_PREFIX = "cohub-task:";
export const boardTaskSource = (taskRunId: string) =>
	`${BOARD_TASK_SOURCE_PREFIX}${taskRunId}`;

function artifactId(
	base: string,
	used: Set<string>,
	suffix?: string,
): string {
	const stem = cleanExcerpt(base, 220) ?? "output";
	let candidate = suffix ? `${stem}-${suffix}` : stem;
	let sequence = 2;
	while (used.has(candidate)) {
		candidate = `${stem}-${suffix ? `${suffix}-` : ""}${sequence}`;
		sequence += 1;
	}
	used.add(candidate);
	return candidate;
}

export function taskArtifacts(
	blocks: Record<string, unknown>[],
): BoardTaskArtifact[] {
	const covers = new Map(
		[...generationCovers(blocks)].filter(([media]) =>
			Boolean(blockUrl(blocks[media] ?? {})),
		),
	);
	const coverIndexes = new Set(covers.values());
	const coverUrl = (index: number) => {
		const cover = covers.get(index);
		return cover === undefined ? undefined : blockUrl(blocks[cover] ?? {});
	};
	type Entry = { block: Record<string, unknown>; index: number; url?: string };
	const groups = new Map<string, Entry[]>();
	blocks.forEach((block, index) => {
		if (coverIndexes.has(index)) return;
		const key = blockIdentity(block) ?? `output-${index + 1}`;
		const entry = { block, index, url: blockUrl(block) };
		const group = groups.get(key);
		if (group) group.push(entry);
		else groups.set(key, [entry]);
	});
	const withUrl = (entry: Entry): entry is Entry & { url: string } =>
		Boolean(entry.url);

	const artifacts: BoardTaskArtifact[] = [];
	const usedIds = new Set<string>();
	for (const [groupId, blocksInGroup] of groups) {
		const images = blocksInGroup
			.filter(({ block }) => block.type === "image")
			.filter(withUrl);
		const media = blocksInGroup
			.filter(({ block }) => block.type === "video" || block.type === "audio")
			.filter(withUrl);
		const models = blocksInGroup
			.filter(({ block }) => block.type === "3d")
			.filter(withUrl);

		models.forEach(({ block, index, url }, modelIndex) => {
			const title = blockTitle(block);
			const mimeType = blockMimeType(block);
			const format = blockFormat(block);
			const previewUrl = blockPreviewUrl(block) ?? coverUrl(index);
			artifacts.push({
				id: artifactId(
					groupId,
					usedIds,
					models.length > 1 ? `3d-${modelIndex + 1}` : undefined,
				),
				type: "3d",
				url,
				...(title ? { title } : {}),
				...(mimeType ? { mimeType } : {}),
				...(format ? { format } : {}),
				...(previewUrl ? { previewUrl } : {}),
			});
		});

		media.forEach(({ block, index, url }, mediaIndex) => {
			const type = block.type as "video" | "audio";
			const mimeType = blockMimeType(block);
			const title = blockTitle(block);
			const durationMs = blockDurationMs(block);
			const previewUrl = blockPreviewUrl(block) ?? coverUrl(index);
			const id = artifactId(
				groupId,
				usedIds,
				media.length > 1 ? `${type}-${mediaIndex + 1}` : undefined,
			);
			if (type === "video") {
				artifacts.push({
					id,
					type,
					url,
					...(title ? { title } : {}),
					...(previewUrl ? { previewUrl } : {}),
					...(mimeType ? { mimeType } : {}),
					...(durationMs ? { durationMs } : {}),
					...blockNaturalSize(block),
				});
				return;
			}
			artifacts.push({
				id,
				type,
				url,
				...(title ? { title } : {}),
				...(previewUrl ? { previewUrl } : {}),
				...(mimeType ? { mimeType } : {}),
				...(durationMs ? { durationMs } : {}),
			});
		});

		images.forEach(({ block, url }, imageIndex) => {
			const mimeType = blockMimeType(block);
			const title = blockTitle(block);
			artifacts.push({
				id: artifactId(
					groupId,
					usedIds,
					images.length > 1
						? `image-${imageIndex + 1}`
						: undefined,
				),
				type: "image",
				url,
				...(title ? { title } : {}),
				...(mimeType ? { mimeType } : {}),
				...blockNaturalSize(block),
			});
		});

		blocksInGroup
			.filter(({ block }) => block.type === "text")
			.forEach(({ block }, textIndex, texts) => {
				const textExcerpt = blockText(block);
				if (!textExcerpt) return;
				const title = blockTitle(block);
				artifacts.push({
					id: artifactId(
						groupId,
						usedIds,
						texts.length > 1 ? `text-${textIndex + 1}` : undefined,
					),
					type: "text",
					...(title ? { title } : {}),
					textExcerpt,
				});
			});
	}
	return artifacts;
}

/** The format a 3D artifact previews as, or null when the viewer cannot read it. */
export function taskArtifactModelFormat(
	artifact: BoardTaskArtifact | undefined,
): ModelFormat | null {
	if (artifact?.type !== "3d") return null;
	return modelFormatForPath(
		artifact.format ? `model.${artifact.format}` : new URL(artifact.url).pathname,
		artifact.mimeType,
	);
}

function artifactScore(artifact: BoardTaskArtifact): readonly number[] {
	const kind = { text: 1, image: 2, audio: 3, video: 4, "3d": 5 }[artifact.type];
	if (artifact.type === "text") return [kind, artifact.textExcerpt.length];
	if (artifact.type === "image") {
		return [kind, (artifact.naturalWidth ?? 0) * (artifact.naturalHeight ?? 0)];
	}
	if (artifact.type === "3d") {
		return [kind, taskArtifactModelFormat(artifact) ? 1 : 0, artifact.previewUrl ? 1 : 0];
	}
	return [
		kind,
		artifact.previewUrl ? 1 : 0,
		artifact.durationMs ? 1 : 0,
		artifact.durationMs ?? 0,
	];
}

function compareArtifacts(a: BoardTaskArtifact, b: BoardTaskArtifact): number {
	const left = artifactScore(a);
	const right = artifactScore(b);
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const difference = (right[index] ?? 0) - (left[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

export function rankedTaskArtifacts(
	artifacts: readonly BoardTaskArtifact[],
): BoardTaskArtifact[] {
	return artifacts
		.map((artifact, index) => ({ artifact, index }))
		.sort(
			(a, b) => compareArtifacts(a.artifact, b.artifact) || a.index - b.index,
		)
		.map(({ artifact }) => artifact);
}

export function featuredTaskArtifact(
	artifacts: readonly BoardTaskArtifact[],
): BoardTaskArtifact | undefined {
	let featured: BoardTaskArtifact | undefined;
	for (const artifact of artifacts) {
		if (!featured || compareArtifacts(artifact, featured) < 0) {
			featured = artifact;
		}
	}
	return featured;
}

export function taskArtifactPreviewUrl(
	artifact: BoardTaskArtifact | undefined,
): string | undefined {
	if (artifact?.type === "image") return artifact.url;
	if (artifact?.type === "video" || artifact?.type === "audio" || artifact?.type === "3d") {
		return artifact.previewUrl;
	}
	return undefined;
}

function taskTypeTitle(taskType: string): string {
	return taskType
		.replace(/[._-]+/g, " ")
		.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function taskRunArtifacts(run: Pick<BoardTaskRunSource, "taskType" | "result">): BoardTaskArtifact[] {
	return run.taskType === "generation" ? rankedTaskArtifacts(taskArtifacts(generationOutput(run))) : [];
}

export function taskRunToBoardTaskSnapshot(
	run: BoardTaskRunSource,
): BoardTaskSnapshot {
	const data = taskData(run);
	const promptExcerpt =
		run.taskType === "generation"
			? generationPrompt(run)
			: cleanExcerpt(data?.command ?? data?.prompt ?? data?.title);
	const model = typeof data?.model === "string" ? data.model : undefined;
	const allArtifacts = taskRunArtifacts(run);
	const artifacts = allArtifacts.slice(0, BOARD_TASK_ARTIFACT_LIMIT);
	const errorExcerpt =
		run.status === "failed" ? cleanExcerpt(run.errorMessage, 240) : undefined;
	return {
		taskType: run.taskType,
		status: run.status,
		title: promptExcerpt ?? taskTypeTitle(run.taskType),
		...(model ? { model } : {}),
		...(promptExcerpt ? { promptExcerpt } : {}),
		...(errorExcerpt ? { errorExcerpt } : {}),
		artifactCount: allArtifacts.length,
		artifacts,
		...(run.startedAt ? { startedAt: run.startedAt } : {}),
		updatedAt: run.updatedAt,
	};
}

export function withObservedArtifactFacts(
	snapshot: BoardTaskSnapshot,
	observed: BoardTaskSnapshot | undefined,
): BoardTaskSnapshot {
	if (!observed?.artifacts.length) return snapshot;
	let changed = false;
	const artifacts = snapshot.artifacts.map((artifact) => {
		if (artifact.type !== "image" && artifact.type !== "video") return artifact;
		if (artifact.naturalWidth && artifact.naturalHeight) return artifact;
		const match = observed.artifacts.find(
			(candidate) =>
				candidate.id === artifact.id &&
				candidate.type === artifact.type &&
				candidate.url === artifact.url,
		);
		if (
			!match ||
			(match.type !== "image" && match.type !== "video") ||
			!match.naturalWidth ||
			!match.naturalHeight
		)
			return artifact;
		changed = true;
		return {
			...artifact,
			naturalWidth: match.naturalWidth,
			naturalHeight: match.naturalHeight,
		};
	});
	return changed ? { ...snapshot, artifacts } : snapshot;
}
