import type { ContentBlock } from "@cohub/protocol/core";
import { isUuidLike } from "@cohub/protocol/identifiers";
import type {
	SessionFileChangeKind,
	SessionFileRecord,
} from "@cohub/protocol/model";
import type { TaskRunRecord } from "@neta-art/cohub";

export type LiveFileChange = {
	path: string;
	kind: Extract<SessionFileChangeKind, "write" | "edit">;
	at: number;
	turnId: string | null;
	active: boolean;
};

export type SessionFileEntry = Omit<
	SessionFileRecord,
	"lastTurnId" | "lastTurnSequence"
> & {
	lastTurnId: string | null;
	lastTurnSequence: number | null;
	live: boolean;
	active: boolean;
};

const WORKSPACE_ROOT = "workspace";
const MAX_PATH_LENGTH = 1024;

const FILE_CHANGE_TOOLS: Record<string, LiveFileChange["kind"]> = {
	write: "write",
	edit: "edit",
};

/** Mirrors `normalizeFilePath` in `@cohub/core/references`; keep in step. */
export function workspacePathFromToolPath(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const value = raw.trim().replace(/\\/g, "/");
	if (!value || value.includes("\0")) return null;
	const segments: string[] = [];
	const absolute = value.startsWith("/")
		? value
		: `/${WORKSPACE_ROOT}/${value}`;
	for (const segment of absolute.split("/")) {
		if (segment === "..") segments.pop();
		else if (segment && segment !== ".") segments.push(segment);
	}
	if (segments.join("/").length + 1 > MAX_PATH_LENGTH) return null;
	if (segments[0] !== WORKSPACE_ROOT || segments.length < 2) return null;
	return segments.slice(1).join("/");
}

export function fileToolBlocks(content: readonly ContentBlock[]) {
	return content.filter(
		(block) =>
			block.type === "tool_result" ||
			(block.type === "tool_use" &&
				Object.hasOwn(FILE_CHANGE_TOOLS, block.name)),
	);
}

function runTime(run: Pick<TaskRunRecord, "createdAt">) {
	return Date.parse(run.createdAt) || 0;
}

function updateTime(run: Pick<TaskRunRecord, "updatedAt">) {
	return Date.parse(run.updatedAt) || 0;
}

/** A late list response must not replace a newer realtime row. */
export function upsertTaskRuns(
	byId: Map<string, TaskRunRecord>,
	runs: Iterable<TaskRunRecord>,
) {
	for (const run of runs) {
		const existing = byId.get(run.id);
		if (!existing || updateTime(run) >= updateTime(existing))
			byId.set(run.id, run);
	}
	return byId;
}

export function sortTaskRuns(runs: TaskRunRecord[]) {
	return runs.sort(
		(a, b) =>
			runTime(b) - runTime(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
	);
}

/**
 * A page is authoritative for the span between its request cursor and its
 * last row; rows in that span it no longer carries are removed. Boundaries
 * are exclusive because wire timestamps are rounded to milliseconds.
 */
export function mergeTaskRunPage(
	current: readonly TaskRunRecord[],
	page: readonly TaskRunRecord[],
	options: {
		cursor: string | null;
		complete: boolean;
		keepIds?: ReadonlySet<string>;
	},
): { runs: TaskRunRecord[]; removedIds: string[] } {
	const after =
		options.cursor === null
			? Number.POSITIVE_INFINITY
			: Date.parse(options.cursor.split("|")[0] ?? "");
	const last = page.at(-1);
	const until = options.complete
		? Number.NEGATIVE_INFINITY
		: last
			? runTime(last)
			: Number.POSITIVE_INFINITY;
	const pageIds = new Set(page.map((run) => run.id));
	const byId = new Map<string, TaskRunRecord>();
	const removedIds: string[] = [];
	for (const run of current) {
		const time = runTime(run);
		const covered = time > until && time < after;
		if (covered && !pageIds.has(run.id) && !options.keepIds?.has(run.id)) {
			removedIds.push(run.id);
		} else {
			byId.set(run.id, run);
		}
	}
	upsertTaskRuns(byId, page);
	return { runs: sortTaskRuns([...byId.values()]), removedIds };
}

export function patchTaskRun(
	existing: TaskRunRecord | undefined,
	task: {
		id: string;
		type: string;
		status: TaskRunRecord["status"];
		jobId: string;
		cronJobId: string | null;
		spaceId: string | null;
		sessionId: string | null;
		turnId: string | null;
		userId: string | null;
		attemptCount: number;
		scheduledAt: string | null;
		startedAt: string | null;
		finishedAt: string | null;
		errorMessage: string | null;
		createdAt: string;
		updatedAt: string;
	},
): TaskRunRecord {
	return {
		payload: null,
		result: null,
		userProfile: undefined,
		...existing,
		id: task.id,
		jobId: task.jobId,
		cronJobId: task.cronJobId,
		taskType: task.type,
		status: task.status,
		errorMessage: task.errorMessage,
		attemptCount: task.attemptCount,
		spaceId: task.spaceId,
		sessionId: task.sessionId,
		turnId: task.turnId,
		userUuid: task.userId,
		scheduledAt: task.scheduledAt,
		startedAt: task.startedAt,
		finishedAt: task.finishedAt,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
	};
}

/** Write/edit tool calls of a live stream; active until their result arrives. */
export function extractLiveFileChanges(input: {
	spaceId: string;
	liveBlocks: readonly ContentBlock[];
	archivedBlocks: readonly ContentBlock[];
	streaming: boolean;
	turnId: string | null;
	previous: ReadonlyMap<string, LiveFileChange>;
	now: number;
}): Map<string, LiveFileChange> {
	const finished = new Set<string>();
	for (const block of [...input.archivedBlocks, ...input.liveBlocks]) {
		if (block.type === "tool_result") finished.add(block.tool_use_id);
	}
	const next = new Map(input.previous);
	const visit = (block: ContentBlock, live: boolean) => {
		if (block.type !== "tool_use") return;
		const kind = FILE_CHANGE_TOOLS[block.name];
		const targetSpaceId = block.input.spaceId ?? block.input.space_id;
		if (!kind || (isUuidLike(targetSpaceId) && targetSpaceId !== input.spaceId))
			return;
		const path = workspacePathFromToolPath(block.input.path);
		if (!path) return;
		const previous = next.get(path);
		const turnId = input.turnId ?? previous?.turnId ?? null;
		next.set(path, {
			path,
			kind,
			at: previous && previous.turnId === turnId ? previous.at : input.now,
			turnId,
			active: input.streaming && live && !finished.has(block.id),
		});
	};
	for (const block of input.archivedBlocks) visit(block, false);
	for (const block of input.liveBlocks) visit(block, true);
	if (!input.streaming) {
		for (const [path, change] of next) {
			if (change.active) next.set(path, { ...change, active: false });
		}
	}
	return next;
}

export function sameLiveFileChanges(
	a: ReadonlyMap<string, LiveFileChange>,
	b: ReadonlyMap<string, LiveFileChange>,
) {
	if (a.size !== b.size) return false;
	for (const [path, change] of a) {
		const other = b.get(path);
		if (
			!other ||
			other.kind !== change.kind ||
			other.active !== change.active ||
			other.at !== change.at ||
			other.turnId !== change.turnId
		)
			return false;
	}
	return true;
}

function coversLiveChange(
	record: { lastTurnId: string | null } | undefined,
	change: LiveFileChange,
) {
	if (!record) return false;
	return change.turnId === null || record.lastTurnId === change.turnId;
}

export function pruneCoveredLiveChanges(
	live: ReadonlyMap<string, LiveFileChange>,
	server: readonly SessionFileRecord[],
) {
	const byPath = new Map(server.map((file) => [file.path, file]));
	const next = new Map<string, LiveFileChange>();
	for (const [path, change] of live) {
		if (change.active || !coversLiveChange(byPath.get(path), change))
			next.set(path, change);
	}
	return next;
}

export function mergeSessionFiles(
	server: readonly SessionFileRecord[],
	live: ReadonlyMap<string, LiveFileChange>,
): SessionFileEntry[] {
	const entries = new Map<string, SessionFileEntry>(
		server.map((file) => [file.path, { ...file, live: false, active: false }]),
	);
	for (const change of live.values()) {
		const record = entries.get(change.path);
		if (coversLiveChange(record, change) && !change.active) continue;
		const changedAt = new Date(change.at).toISOString();
		entries.set(change.path, {
			path: change.path,
			lastKind: change.kind,
			kinds: record?.kinds.includes(change.kind)
				? record.kinds
				: [...(record?.kinds ?? []), change.kind],
			changeCount: (record?.changeCount ?? 0) + 1,
			firstChangedAt: record?.firstChangedAt ?? changedAt,
			lastChangedAt: changedAt,
			lastTurnId: change.turnId,
			lastTurnSequence: null,
			live: true,
			active: change.active,
		});
	}
	// Live times are client clock; only compare them with each other.
	return [...entries.values()].sort(
		(a, b) =>
			Number(b.live) - Number(a.live) ||
			(a.live
				? b.lastChangedAt.localeCompare(a.lastChangedAt)
				: (b.lastTurnSequence ?? 0) - (a.lastTurnSequence ?? 0)) ||
			a.path.localeCompare(b.path),
	);
}

export function withAncestorPaths(paths: Iterable<string>) {
	const marked = new Set<string>();
	for (const path of paths) {
		marked.add(path);
		let index = path.lastIndexOf("/");
		while (index > 0) {
			const dir = path.slice(0, index);
			if (marked.has(dir)) break;
			marked.add(dir);
			index = dir.lastIndexOf("/");
		}
	}
	return marked;
}

export function formatElapsed(ms: number) {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = String(total % 60).padStart(2, "0");
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
		: `${minutes}:${seconds}`;
}
