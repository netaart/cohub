import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { boardItems, boards, taskRuns } from "@cohub/db";
import {
	type Actor,
	type BoardChangedEvent,
	type BoardItem,
	type BoardPatch,
	type BoardTaskSnapshot,
	BoardTaskSnapshotSchema,
	BOARD_REALTIME_DELTA_MAX_BYTES,
	type RequestSource,
	type TaskRunStatus,
	boardTaskSource,
	diffMergePatch,
	featuredTaskArtifact,
	fitBoardMediaSize,
	isUuid,
	mergePatch,
	taskRunToBoardTaskSnapshot,
	withObservedArtifactFacts,
} from "@cohub/protocol";
import type { BoardApplyOutcome, BoardDatabase } from "./store.js";

type Executor = Parameters<Parameters<BoardDatabase["transaction"]>[0]>[0] | BoardDatabase;
type JsonRecord = Record<string, unknown>;

export type BoardTaskRunAccess = { id: string; sessionId: string | null; userUuid: string | null };

export type BoardTaskViewer = (run: BoardTaskRunAccess) => boolean | Promise<boolean>;

const isRecord = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const TASK_STATUSES: ReadonlySet<string> = new Set<TaskRunStatus>(["pending", "running", "completed", "failed"]);

/**
 * Write ids of task syncs. Reserved: a client claiming one could make the
 * server replay instead of write, so the apply route refuses them.
 */
export const BOARD_TASK_MUTATION_PREFIX = "task:";

export const BOARD_TASK_SYNC_LIMIT = 100;

type TaskRow = BoardTaskRunAccess & {
	taskType: string;
	status: string;
	errorMessage: string | null;
	startedAt: Date | null;
	updatedAt: Date | null;
	payload: unknown;
	result: unknown;
};

// Only what a snapshot reads, so inline media never leaves the database; output
// keeps every block in place because artifact ids derive from positions.
const data = sql`coalesce(${taskRuns.payload}->'data', ${taskRuns.payload})`;
const snapshotPayload = sql`jsonb_build_object('data', jsonb_strip_nulls(jsonb_build_object(
	'model', ${data}->'model',
	'command', ${data}->'command',
	'prompt', ${data}->'prompt',
	'title', ${data}->'title',
	'content', (
		SELECT jsonb_agg(block ORDER BY position) FROM jsonb_array_elements(
			CASE WHEN jsonb_typeof(${data}->'content') = 'array' THEN ${data}->'content' ELSE '[]'::jsonb END
		) WITH ORDINALITY AS input(block, position) WHERE block->>'type' = 'text'
	)
)))`;
const snapshotResult = sql`CASE WHEN jsonb_typeof(${taskRuns.result}->'output') = 'array' THEN jsonb_build_object('output', (
	SELECT coalesce(jsonb_agg(
		CASE WHEN block->'source'->>'type' = 'base64' THEN block - 'source' ELSE block END ORDER BY position
	), '[]'::jsonb) FROM jsonb_array_elements(${taskRuns.result}->'output') WITH ORDINALITY AS output(block, position)
)) END`;

/**
 * The runs a write shows, from the Board's Space only. The share lock orders a
 * write against the run finishing: the write either reads the final state, or
 * commits first so the completion sync sees its item.
 */
async function loadTaskRuns(tx: Executor, spaceId: string, ids: Iterable<string>): Promise<Map<string, TaskRow>> {
	const wanted = [...new Set(ids)].filter((id) => isUuid(id));
	if (!wanted.length) return new Map();
	const rows = await tx
		.select({
			id: taskRuns.id,
			sessionId: taskRuns.sessionId,
			userUuid: taskRuns.userUuid,
			taskType: taskRuns.taskType,
			status: taskRuns.status,
			errorMessage: taskRuns.errorMessage,
			startedAt: taskRuns.startedAt,
			updatedAt: taskRuns.updatedAt,
			payload: snapshotPayload,
			result: snapshotResult,
		})
		.from(taskRuns)
		.where(and(eq(taskRuns.spaceId, spaceId), sql`${taskRuns.id} = ANY(${sql.param(wanted)}::uuid[])`))
		.for("share");
	return new Map(rows.map((row) => [row.id, row as TaskRow]));
}

function snapshotOf(row: TaskRow): BoardTaskSnapshot {
	return taskRunToBoardTaskSnapshot({
		taskType: row.taskType,
		status: TASK_STATUSES.has(row.status) ? (row.status as TaskRunStatus) : "pending",
		payload: row.payload,
		result: row.result,
		errorMessage: row.errorMessage,
		startedAt: row.startedAt?.toISOString() ?? null,
		updatedAt: (row.updatedAt ?? new Date()).toISOString(),
	});
}

export type BoardTaskResolution =
	| { ok: true; patch: BoardPatch }
	| { ok: false; status: 403 | 404; code: "TASK_FORBIDDEN" | "TASK_NOT_FOUND"; path: string; message: string };

export async function resolveBoardTaskSnapshots(
	tx: Executor,
	input: {
		spaceId: string;
		patch: BoardPatch;
		current: (id: string) => BoardItem | undefined;
		viewer?: BoardTaskViewer;
		whole?: boolean;
	},
): Promise<BoardTaskResolution> {
	type Candidate = {
		id: string;
		value: JsonRecord;
		props: JsonRecord;
		taskRunId: string;
		whole: boolean;
		previous?: BoardTaskSnapshot;
		base?: BoardTaskSnapshot;
	};
	const candidates: Candidate[] = [];
	for (const [id, value] of Object.entries(input.patch.items ?? {})) {
		if (!isRecord(value)) continue;
		const current = input.current(id);
		const whole = Boolean(input.whole) || !current || (typeof value.type === "string" && value.type !== current.type);
		const props = isRecord(value.props) ? value.props : undefined;
		if (whole ? value.type !== "task" : current.type !== "task" || !props) continue;
		const existing = current?.type === "task" ? current.props : undefined;
		const taskRunId = typeof props?.taskRunId === "string" ? props.taskRunId : whole ? undefined : existing?.taskRunId;
		if (!taskRunId) continue;
		candidates.push({
			id,
			value,
			props: props ?? {},
			taskRunId,
			whole,
			previous: existing?.taskRunId === taskRunId ? existing.snapshot : undefined,
			base: whole ? undefined : existing?.snapshot,
		});
	}
	if (!candidates.length) return { ok: true, patch: input.patch };

	const runs = await loadTaskRuns(tx, input.spaceId, candidates.map((candidate) => candidate.taskRunId));
	const decisions = new Map<string, Promise<boolean>>();
	const visible = (run: TaskRow) => {
		if (!input.viewer) return Promise.resolve(true);
		let decision = decisions.get(run.id);
		if (!decision) {
			decision = Promise.resolve(input.viewer({ id: run.id, sessionId: run.sessionId, userUuid: run.userUuid }));
			decisions.set(run.id, decision);
		}
		return decision;
	};

	const items: NonNullable<BoardPatch["items"]> = { ...input.patch.items };
	for (const candidate of candidates) {
		const run = runs.get(candidate.taskRunId);
		const path = `items.${candidate.id}.props.taskRunId`;
		const { snapshot: supplied, ...props } = candidate.props;
		const keep = () => {
			items[candidate.id] = { ...candidate.value, props: candidate.whole ? { ...props, snapshot: candidate.previous } : props };
		};
		if (!run) {
			if (supplied !== undefined) continue;
			if (!candidate.previous) return { ok: false, status: 404, code: "TASK_NOT_FOUND", path, message: `Task ${candidate.taskRunId} is not in this Space; write its snapshot to show it as is.` };
			keep();
			continue;
		}
		if (!(await visible(run))) {
			if (!candidate.previous) return { ok: false, status: 403, code: "TASK_FORBIDDEN", path, message: `You cannot view task ${candidate.taskRunId}.` };
			keep();
			continue;
		}
		const observed = supplied === undefined ? undefined : BoardTaskSnapshotSchema.safeParse(mergePatch(candidate.previous ?? {}, supplied));
		const snapshot = withObservedArtifactFacts(snapshotOf(run), observed?.success ? observed.data : candidate.previous);
		const change = candidate.base ? diffMergePatch(candidate.base, snapshot) : snapshot;
		const size = candidate.value.size === undefined ? fittedSize(input.current(candidate.id), candidate.previous, snapshot) : undefined;
		items[candidate.id] = {
			...candidate.value,
			...(size ? { size } : {}),
			props: change === undefined ? props : { ...props, snapshot: change },
		};
	}
	return { ok: true, patch: { ...input.patch, items } };
}

function visual(snapshot: BoardTaskSnapshot | undefined) {
	const artifact = snapshot ? featuredTaskArtifact(snapshot.artifacts) : undefined;
	return artifact && (artifact.type === "image" || artifact.type === "video") ? artifact : undefined;
}

function fittedSize(item: BoardItem | undefined, before: BoardTaskSnapshot | undefined, after: BoardTaskSnapshot) {
	const next = visual(after);
	if (item?.type !== "task" || !next?.naturalWidth || !next.naturalHeight || visual(before)?.url === next.url) return undefined;
	const size = fitBoardMediaSize({ width: next.naturalWidth, height: next.naturalHeight }, Math.max(item.size.width, item.size.height));
	return size && (size.width !== item.size.width || size.height !== item.size.height) ? size : undefined;
}

export async function listTaskBoards(db: Executor, input: { spaceId: string; taskRunId: string; limit?: number }) {
	const rows = await db
		.select({ id: boards.id, title: boards.title, items: sql<string[]>`array_agg(${boardItems.id} ORDER BY ${boardItems.id})` })
		.from(boardItems)
		.innerJoin(boards, eq(boards.id, boardItems.boardId))
		.where(and(eq(boardItems.type, "task"), eq(boardItems.src, boardTaskSource(input.taskRunId)), eq(boards.spaceId, input.spaceId)))
		.groupBy(boards.id)
		.orderBy(sql`max(${boards.updatedAt}) DESC`, boards.id)
		.limit(input.limit ?? BOARD_TASK_SYNC_LIMIT);
	return rows.map((row) => ({ boardId: row.id, title: row.title, itemIds: row.items }));
}

export function boardChangedEvent(input: {
	spaceId: string;
	boardId: string;
	actorId: string;
	actor: Actor;
	outcome: BoardApplyOutcome;
	source?: RequestSource | null;
}): BoardChangedEvent | null {
	const { written, result } = input.outcome;
	if (!written) return null;
	const inline = Buffer.byteLength(JSON.stringify(written.after), "utf8") <= BOARD_REALTIME_DELTA_MAX_BYTES;
	return {
		id: randomUUID(),
		timestamp: Date.now(),
		domain: "space",
		type: "board.changed",
		spaceId: input.spaceId,
		sessionId: null,
		payload: {
			boardId: input.boardId,
			actorId: input.actorId,
			actor: input.actor,
			mutationId: result.mutationId,
			baseVersion: written.baseVersion,
			version: result.version,
			changed: result.changed,
			...(inline ? { after: written.after } : {}),
			...(input.source ? { source: input.source } : {}),
		},
	};
}
