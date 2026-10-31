import { asRecord, contentBlocks, taskData } from "@cohub/protocol";
import type { ContentBlock } from "@cohub/protocol/core";
import type { SessionTurnRecord } from "@cohub/protocol/model";
import type { TaskRunRecord } from "@neta-art/cohub";
import {
	generationBlockSource,
	generationOutputBlocks,
} from "$lib/resource-kit/task-run";

/** The `meta.role` that tags the ABC score of a song. */
const SCORE_ROLE = "abc";

/** A song output carries one score; the first non-blank abc text block is that score. */
function roleBlock(
	blocks: readonly Record<string, unknown>[],
	role: string,
): { index: number; text: string } | null {
	const index = blocks.findIndex(
		(block) =>
			block.type === "text" &&
			asRecord(block.meta)?.role === role &&
			typeof block.text === "string" &&
			block.text.trim() !== "",
	);
	if (index < 0) return null;
	const text = blocks[index]?.text;
	return typeof text === "string" ? { index, text } : null;
}

/** The output's block first, then the request's: one precedence for both readers. */
function scoreSource(
	outputBlocks: readonly Record<string, unknown>[],
	requestBlocks: readonly Record<string, unknown>[],
): { text: string; outputBlock: number | null } | null {
	const output = roleBlock(outputBlocks, SCORE_ROLE);
	if (output) return { text: output.text, outputBlock: output.index };
	const requested = roleBlock(requestBlocks, SCORE_ROLE);
	return requested ? { text: requested.text, outputBlock: null } : null;
}

/** Whether an output block is a score text block, blank or not. */
export function isTaskScoreBlock(block: Record<string, unknown>): boolean {
	return block.type === "text" && asRecord(block.meta)?.role === SCORE_ROLE;
}

function taskRunScoreSource(
	run: Pick<TaskRunRecord, "taskType" | "payload" | "result">,
): { text: string; outputBlock: number | null } | null {
	return scoreSource(
		generationOutputBlocks(run),
		contentBlocks(taskData(run)?.content),
	);
}

export type TaskScoreEntry = { taskRunId: string; score: string };

export type TaskScoreItem = TaskScoreEntry & {
	/** The output block whose raw text the item replaces; `null` when only the request has it. */
	outputBlock: number | null;
};

/** The score item of a generation, with the block it replaces. */
export function taskScoreItem(
	run: Pick<TaskRunRecord, "id" | "taskType" | "payload" | "result">,
): TaskScoreItem | null {
	if (run.taskType !== "generation") return null;
	const source = taskRunScoreSource(run);
	return source
		? {
				taskRunId: run.id,
				score: source.text,
				outputBlock: source.outputBlock,
			}
		: null;
}

type GenerationTurn = Pick<
	SessionTurnRecord,
	| "executionKind"
	| "status"
	| "model"
	| "meta"
	| "userContent"
	| "assistantContent"
>;

/** The JSON a direct-generation turn stores in its request or result message. */
function storedGenerationMessage(
	content: readonly ContentBlock[] | null,
	attachmentKind: "generation-input" | "generation-output",
): Record<string, unknown> | null {
	for (const block of content ?? []) {
		if (block.type !== "text" || block._meta?.attachmentKind !== attachmentKind)
			continue;
		try {
			return asRecord(JSON.parse(block.text));
		} catch {
			return null;
		}
	}
	return null;
}

/**
 * The score entry of a create-mode result bubble, decided from the turn alone: the request and
 * the result are stored in it as messages, so no task needs fetching to know there is a score.
 */
export function generationTurnScoreItem(
	turn: GenerationTurn,
): TaskScoreEntry | null {
	if (turn.executionKind !== "direct_generation") return null;
	const taskRunId = turn.meta?.generationTaskId;
	if (typeof taskRunId !== "string" || !taskRunId) return null;
	const request = storedGenerationMessage(turn.userContent, "generation-input");
	const result = storedGenerationMessage(
		turn.assistantContent,
		"generation-output",
	);
	const score = scoreSource(
		contentBlocks(result?.result),
		contentBlocks(request?.content),
	);
	return score === null ? null : { taskRunId, score: score.text };
}

/** The audio block a generation's score sits under, if it has one. */
export type TaskScoreAudio = { index: number; src: string };

/** The score of a generation, with the audio it belongs to: the last playable audio output. */
export type TaskScorePlacement = {
	score: TaskScoreItem;
	audio: TaskScoreAudio | null;
};

function taskRunAudio(
	run: Pick<TaskRunRecord, "taskType" | "result">,
): TaskScoreAudio | null {
	const blocks = generationOutputBlocks(run);
	for (let index = blocks.length - 1; index >= 0; index -= 1) {
		const block = blocks[index];
		if (block?.type !== "audio") continue;
		const src = generationBlockSource(block);
		if (src) return { index, src };
	}
	return null;
}

/** The score item of a generation and the audio block it is drawn under. */
export function taskScorePlacement(
	run: Pick<TaskRunRecord, "id" | "taskType" | "payload" | "result">,
): TaskScorePlacement | null {
	const score = taskScoreItem(run);
	return score ? { score, audio: taskRunAudio(run) } : null;
}
