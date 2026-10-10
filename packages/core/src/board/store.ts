
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { AnyPgColumn, PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { boardAnimations, boardItems, boardTracks, boardTransactions, boards } from "@cohub/db";
import {
	BOARD_CAMERA_TARGET,
	type BoardAnimation,
	type BoardAnimationHeader,
	BoardAnimationHeaderSchema,
	type BoardApplyInput,
	BoardApplyInputSchema,
	type BoardApplyResult,
	type BoardDelta,
	type BoardDiagnostic,
	type BoardDocument,
	type BoardHistoryInput,
	BoardHistoryInputSchema,
	type BoardHistoryPage,
	type BoardItem,
	type BoardPatch,
	type BoardPlaybackCommand,
	type BoardPlaybackSnapshot,
	type BoardReadInput,
	BoardReadInputSchema,
	type BoardReadResult,
	type BoardSettings,
	BoardSettingsSchema,
	type BoardSnapshot,
	type BoardState,
	type BoardTrack,
	BoardTrackSchema,
	type BoardTransactionRecord,
	BOARD_PROTOCOL_VERSION,
	BOARD_SNAPSHOT_KIND,
	type RequestSource,
	applyBoardPatch,
	arrowBindings,
	boardJsonEquals,
	boardPatchTouches,
	createBoardLayout,
	diffBoardDocuments,
	diffMergePatch,
	isEmptyBoardDelta,
	parseBoardDocument,
	parseBoardItem,
	summarizeBoardDelta,
	trackReferences,
} from "@cohub/protocol";

// biome-ignore lint/suspicious/noExplicitAny: any Postgres driver (postgres-js in production, PGlite in tests).
export type BoardDatabase = PgDatabase<PgQueryResultHKT, any, any>;
type Tx = Parameters<Parameters<BoardDatabase["transaction"]>[0]>[0];
type Executor = BoardDatabase | Tx;

export class BoardError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly diagnostics: BoardDiagnostic[] = [],
	) {
		super(message);
		this.name = "BoardError";
	}
}

const WRITE_CHUNK = 500;

const textArray = (values: readonly string[]) => sql`${sql.param(values)}::text[]`;

async function rowsOf<T>(result: Promise<unknown>): Promise<T[]> {
	const value = (await result) as T[] | { rows: T[] };
	return Array.isArray(value) ? value : value.rows;
}
const MAX_DEPTH = 64;
type JsonRecord = Record<string, unknown>;


function readItem(id: string, data: unknown): BoardItem {
	const parsed = parseBoardItem(data, `items.${id}`);
	if (!parsed.ok) throw new BoardError(500, "INVALID_STORED_ITEM", `items.${id}: invalid stored item`, parsed.diagnostics);
	return parsed.item;
}

function readHeader(data: unknown): BoardAnimationHeader {
	return BoardAnimationHeaderSchema.parse(data);
}

function readTrack(data: unknown): BoardTrack {
	return BoardTrackSchema.parse(data);
}

function readSettings(data: unknown): BoardSettings {
	return BoardSettingsSchema.parse(data);
}

function itemData(item: BoardItem): JsonRecord {
	return item;
}

const headerData = (header: BoardAnimationHeader) => header as JsonRecord;
const trackData = (track: BoardTrack) => track as JsonRecord;


type Loaded = {
	items: Map<string, BoardItem>;
	parents: Map<string, string | undefined>;
};

async function loadWithAncestors(db: Executor, boardId: string, ids: Iterable<string>, loaded: Loaded) {
	const candidates = new Set(ids);
	for (const id of candidates) {
		const parent = loaded.items.get(id)?.parent;
		if (parent) candidates.add(parent);
	}
	const missing = [...candidates].filter((id) => !loaded.items.has(id) && !loaded.parents.has(id));
	if (!missing.length) return;
	const rows = await rowsOf<{ id: string; data: unknown; parent_id: string | null }>(db.execute(sql`
		WITH RECURSIVE up(id, depth) AS (
			SELECT i.id, 0 FROM ${boardItems} i WHERE i.board_id = ${boardId} AND i.id = ANY(${textArray(missing)})
			UNION
			SELECT i.parent_id, up.depth + 1 FROM ${boardItems} i JOIN up ON i.board_id = ${boardId} AND i.id = up.id
			WHERE i.parent_id IS NOT NULL AND up.depth < ${MAX_DEPTH}
		)
		SELECT i.id, i.data, i.parent_id FROM ${boardItems} i WHERE i.board_id = ${boardId} AND i.id IN (SELECT id FROM up)
	`));
	for (const id of missing) loaded.parents.set(id, undefined);
	for (const row of rows) {
		const item = readItem(row.id, row.data);
		if (item) loaded.items.set(row.id, item);
		loaded.parents.set(row.id, row.parent_id ?? undefined);
	}
}

async function loadDescendants(db: Executor, boardId: string, ids: string[]): Promise<Map<string, BoardItem>> {
	const result = new Map<string, BoardItem>();
	if (!ids.length) return result;
	const rows = await rowsOf<{ id: string; data: unknown }>(db.execute(sql`
		WITH RECURSIVE down(id, depth) AS (
			SELECT i.id, 1 FROM ${boardItems} i WHERE i.board_id = ${boardId} AND i.parent_id = ANY(${textArray(ids)})
			UNION
			SELECT i.id, down.depth + 1 FROM ${boardItems} i JOIN down ON i.board_id = ${boardId} AND i.parent_id = down.id
			WHERE down.depth < ${MAX_DEPTH}
		)
		SELECT i.id, i.data FROM ${boardItems} i WHERE i.board_id = ${boardId} AND i.id IN (SELECT id FROM down)
	`));
	for (const row of rows) {
		const item = readItem(row.id, row.data);
		if (item) result.set(row.id, item);
	}
	return result;
}

async function loadBinders(db: Executor, boardId: string, ids: string[]): Promise<Map<string, BoardItem>> {
	const result = new Map<string, BoardItem>();
	if (!ids.length) return result;
	const rows = await db
		.select({ id: boardItems.id, data: boardItems.data })
		.from(boardItems)
		.where(and(eq(boardItems.boardId, boardId), sql`${boardItems.binds} && ${textArray(ids)}`));
	for (const row of rows) {
		const item = readItem(row.id, row.data);
		if (item) result.set(row.id, item);
	}
	return result;
}


async function findBoard(db: Executor, spaceId: string, boardId: string, lock = false) {
	const query = db.select().from(boards).where(and(eq(boards.id, boardId), eq(boards.spaceId, spaceId))).limit(1);
	const [board] = lock ? await query.for("update") : await query;
	if (!board) throw new BoardError(404, "BOARD_NOT_FOUND", "Board not found.");
	return board;
}

function playbackOf(value: unknown): BoardPlaybackSnapshot | null {
	return value && typeof value === "object" ? (value as BoardPlaybackSnapshot) : null;
}

export async function readBoard(
	db: BoardDatabase,
	input: { spaceId: string; boardId: string; read?: BoardReadInput },
): Promise<BoardReadResult> {
	return db.transaction((tx) => readBoardInTransaction(tx, input), { isolationLevel: "repeatable read" });
}

async function readBoardInTransaction(
	db: Executor,
	input: { spaceId: string; boardId: string; read?: BoardReadInput },
): Promise<BoardReadResult> {
	const read = BoardReadInputSchema.parse(input.read ?? {});
	const board = await findBoard(db, input.spaceId, input.boardId);
	const sections = new Set(read.only ?? ["items", "animations"]);
	const result: BoardReadResult = {
		id: board.id,
		title: board.title,
		version: board.version,
		updatedAt: board.updatedAt.toISOString(),
		board: readSettings(board.settings),
		playback: playbackOf(board.playback),
	};
	if (sections.has("items")) {
		const filters = [eq(boardItems.boardId, board.id)];
		if (read.items?.length) filters.push(inArray(boardItems.id, read.items));
		if (read.rect) {
			const { x, y, width, height } = read.rect;
			filters.push(sql`box(point(${boardItems.minX}, ${boardItems.minY}), point(${boardItems.maxX}, ${boardItems.maxY})) && box(point(${x}, ${y}), point(${x + width}, ${y + height}))`);
		}
		if (read.within) {
			filters.push(sql`${boardItems.id} IN (
				WITH RECURSIVE down(id, depth) AS (
					SELECT ${read.within}::text, 0
					UNION
					SELECT i.id, down.depth + 1 FROM ${boardItems} i JOIN down ON i.board_id = ${board.id} AND i.parent_id = down.id
					WHERE down.depth < ${MAX_DEPTH}
				) SELECT id FROM down)`);
		}
		if (read.cursor) filters.push(gt(boardItems.id, read.cursor));
		const query = db.select({ id: boardItems.id, data: boardItems.data }).from(boardItems).where(and(...filters)).orderBy(asc(boardItems.id));
		const rows = read.limit ? await query.limit(read.limit + 1) : await query;
		const page = read.limit ? rows.slice(0, read.limit) : rows;
		result.items = Object.fromEntries(page.map((row) => [row.id, readItem(row.id, row.data)]));
		if (read.limit && rows.length > read.limit) result.next = page.at(-1)?.id;
	}
	if (sections.has("animations")) {
		const animationFilter = read.animations?.length
			? and(eq(boardAnimations.boardId, board.id), inArray(boardAnimations.id, read.animations))
			: eq(boardAnimations.boardId, board.id);
		const trackFilter = read.animations?.length
			? and(eq(boardTracks.boardId, board.id), inArray(boardTracks.animationId, read.animations))
			: eq(boardTracks.boardId, board.id);
		const [animations, tracks] = await Promise.all([
			db.select({ id: boardAnimations.id, data: boardAnimations.data }).from(boardAnimations).where(animationFilter).orderBy(asc(boardAnimations.id)),
			db.select({ animationId: boardTracks.animationId, id: boardTracks.id, data: boardTracks.data }).from(boardTracks).where(trackFilter).orderBy(asc(boardTracks.animationId), asc(boardTracks.id)),
		]);
		const byAnimation = new Map<string, JsonRecord>();
		for (const track of tracks) {
			const entry = byAnimation.get(track.animationId) ?? {};
			entry[track.id] = readTrack(track.data);
			byAnimation.set(track.animationId, entry);
		}
		result.animations = Object.fromEntries(animations.map((row) => [row.id, { ...readHeader(row.data), tracks: byAnimation.get(row.id) ?? {} }]));
	}
	return result;
}

async function readDocument(db: Executor, boardId: string, settings: unknown): Promise<BoardDocument> {
	const [items, animations, tracks] = await Promise.all([
		db.select({ id: boardItems.id, data: boardItems.data }).from(boardItems).where(eq(boardItems.boardId, boardId)),
		db.select({ id: boardAnimations.id, data: boardAnimations.data }).from(boardAnimations).where(eq(boardAnimations.boardId, boardId)),
		db.select({ animationId: boardTracks.animationId, id: boardTracks.id, data: boardTracks.data }).from(boardTracks).where(eq(boardTracks.boardId, boardId)),
	]);
	const document: BoardDocument = { board: readSettings(settings), items: {}, animations: {} };
	for (const row of items) {
		const item = readItem(row.id, row.data);
		if (item) document.items[row.id] = item;
	}
	for (const row of animations) {
		const header = readHeader(row.data);
		if (header) document.animations[row.id] = { ...header, tracks: {} };
	}
	for (const row of tracks) {
		const track = readTrack(row.data);
		const animation = document.animations[row.animationId];
		if (track && animation) animation.tracks[row.id] = track;
	}
	return document;
}

function storedDelta(value: unknown): BoardDelta | null {
	return value && typeof value === "object" ? (value as BoardDelta) : null;
}


export type BoardApplyOutcome = {
	result: BoardApplyResult;
	written?: { baseVersion: number; after: BoardDelta; playback?: BoardPlaybackSnapshot | null };
};

export async function applyBoard(
	db: BoardDatabase,
	input: { spaceId: string; boardId: string; actorId: string; apply: BoardApplyInput; source?: RequestSource | null },
): Promise<BoardApplyOutcome> {
	const parsed = BoardApplyInputSchema.safeParse(input.apply);
	if (!parsed.success) {
		throw new BoardError(400, "INVALID_PATCH", "Board patch is invalid.", parsed.error.issues.slice(0, 32).map((issue) => ({
			severity: "error",
			code: "INVALID_PATCH",
			path: issue.path.map(String).join("."),
			message: issue.message,
		})));
	}
	return db.transaction((tx) => applyBoardInTransaction(tx, { ...input, apply: parsed.data }));
}

type ParsedApply = ReturnType<typeof BoardApplyInputSchema.parse>;

function reportedPatch(apply: ParsedApply): JsonRecord {
	return { ...(apply.patch as JsonRecord), ...(apply.replace ? { $replace: true } : {}), ...(apply.cascade ? { $cascade: true } : {}) };
}

export async function applyBoardInTransaction(
	tx: Tx,
	input: { spaceId: string; boardId: string; actorId: string; apply: ParsedApply; source?: RequestSource | null },
): Promise<BoardApplyOutcome> {
	const { apply } = input;
	const mutationId = apply.mutationId ?? randomUUID();
	const board = await findBoard(tx, input.spaceId, input.boardId, true);

	const [existing] = await tx
		.select({ receipt: boardTransactions.receipt })
		.from(boardTransactions)
		.where(and(eq(boardTransactions.boardId, board.id), eq(boardTransactions.txId, mutationId)))
		.limit(1);
	if (existing) return { result: { ...(existing.receipt as BoardApplyResult), replayed: true } };

	if (apply.baseVersion !== undefined && apply.baseVersion !== board.version) {
		throw new BoardError(409, "VERSION_CONFLICT", `Board is at version ${board.version}, not ${apply.baseVersion}.`);
	}

	let patch = apply.patch as BoardPatch;
	if (apply.replace) {
		const target = parseBoardDocument(patch);
		if (!target.ok) throw new BoardError(400, "INVALID_PATCH", "Board document is invalid.", target.diagnostics);
		patch = diffBoardDocuments(await readDocument(tx, board.id, board.settings), target.document);
	}

	const state = await preloadState(tx, board.id, board.settings, patch, apply.cascade);
	const applied = applyBoardPatch(state.state, patch, {
		cascade: apply.cascade,
		resolveArrowEnd: (arrowId, which) => state.layout.arrowEnd(arrowId, which),
	});
	if (!applied.ok) {
		const first = applied.diagnostics[0];
		const status = first?.code.endsWith("_NOT_FOUND") ? 404 : first?.code.endsWith("_REFERENCED") || first?.code === "ID_CONFLICT" ? 409 : 400;
		throw new BoardError(status, first?.code ?? "INVALID_PATCH", first ? `${first.path}: ${first.message}` : "Board patch is invalid.", applied.diagnostics);
	}

	const changed = summarizeBoardDelta(applied.after);
	if (apply.dryRun) {
		return { result: { mutationId, status: "validated", replayed: false, version: board.version, changed, diagnostics: [] } };
	}

	const now = new Date();
	if (isEmptyBoardDelta(applied.after)) {
		const result: BoardApplyResult = { mutationId, status: "unchanged", replayed: false, version: board.version, changed, diagnostics: [] };
		await tx.insert(boardTransactions).values({
			boardId: board.id,
			txId: mutationId,
			baseVersion: board.version,
			resultVersion: null,
			actorId: input.actorId,
			clientId: apply.clientId ?? null,
			patch: reportedPatch(apply),
			changes: null,
			receipt: result as unknown as JsonRecord,
			metadata: input.source ? { source: input.source } : {},
			createdAt: now,
		});
		return { result };
	}

	const version = board.version + 1;
	await writeDelta(tx, board.id, applied.after, state, version, now);

	let playback = playbackOf(board.playback);
	let playbackChanged = false;
	if (playback && changed.animations.includes(playback.animationId)) {
		playback = applied.after.animations?.[playback.animationId] === null ? null : { ...playback, status: "stopped", revision: playback.revision + 1, effectiveAt: now.getTime(), commandId: `write:${mutationId}` };
		playbackChanged = true;
	}

	const result: BoardApplyResult = { mutationId, status: "applied", replayed: false, version, changed, diagnostics: [] };
	await tx.insert(boardTransactions).values({
		boardId: board.id,
		txId: mutationId,
		baseVersion: board.version,
		resultVersion: version,
		actorId: input.actorId,
		clientId: apply.clientId ?? null,
		patch: reportedPatch(apply),
		changes: { before: applied.before, after: applied.after },
		receipt: result as unknown as JsonRecord,
		metadata: input.source ? { source: input.source } : {},
		createdAt: now,
	});
	await tx
		.update(boards)
		.set({
			version,
			updatedAt: now,
			...(applied.after.board ? { settings: applied.after.board, title: applied.after.board.title ?? board.title } : {}),
			...(playbackChanged ? { playback: playback as unknown as JsonRecord | null } : {}),
		})
		.where(eq(boards.id, board.id));
	return {
		result,
		written: { baseVersion: board.version, after: applied.after, ...(playbackChanged ? { playback } : {}) },
	};
}

type Preloaded = {
	state: BoardState;
	layout: ReturnType<typeof createBoardLayout>;
	loaded: Loaded;
	animations: Map<string, BoardAnimationHeader>;
	tracks: Map<string, Map<string, BoardTrack>>;
	revisions: Map<string, number>;
	children: Map<string, Set<string>>;
	binders: Map<string, Set<string>>;
	refs: Map<string, Array<{ animation: string; track: string }>>;
	maxZ: Map<string, number>;
};

async function preloadState(tx: Tx, boardId: string, settingsData: unknown, patch: BoardPatch, cascade: boolean): Promise<Preloaded> {
	const touches = boardPatchTouches(patch);
	const loaded: Loaded = { items: new Map(), parents: new Map() };
	await loadWithAncestors(tx, boardId, [...touches.items, ...touches.animations, ...touches.parents, ...touches.references], loaded);
	await loadWithAncestors(tx, boardId, [...loaded.items.values()].flatMap(arrowBindings), loaded);

	const deleted = new Set(touches.deletedItems);
	const typeChanges = touches.items.filter((id) => {
		const current = loaded.items.get(id);
		const next = patch.items?.[id];
		return current && typeof next?.type === "string" && current.type !== next.type;
	});
	const parentChanges = touches.items.filter((id) => {
		const current = loaded.items.get(id);
		const next = patch.items?.[id];
		return current?.type === "frame" && next && Object.hasOwn(next, "parent") && next.parent !== current.parent;
	});
	const dependencyRoots = [...new Set([...deleted, ...typeChanges, ...parentChanges])];
	const descendants = await loadDescendants(tx, boardId, dependencyRoots);
	const subtree = [...dependencyRoots, ...descendants.keys()];
	for (const [id, item] of descendants) {
		loaded.items.set(id, item);
		loaded.parents.set(id, item.parent);
	}
	if (descendants.size) await loadWithAncestors(tx, boardId, [...loaded.items.values()].flatMap(arrowBindings), loaded);
	const children = new Map<string, Set<string>>();
	for (const [id, item] of loaded.items) {
		if (!item.parent) continue;
		const set = children.get(item.parent) ?? new Set<string>();
		set.add(id);
		children.set(item.parent, set);
	}
	const bindersById = new Map<string, Set<string>>();
	const binderItems = await loadBinders(tx, boardId, cascade ? subtree : dependencyRoots);
	for (const [id, item] of binderItems) {
		loaded.items.set(id, item);
		for (const bound of arrowBindings(item)) {
			const set = bindersById.get(bound) ?? new Set<string>();
			set.add(id);
			bindersById.set(bound, set);
		}
	}
	await loadWithAncestors(tx, boardId, [...binderItems.values()].flatMap(arrowBindings), loaded);
	await loadWithAncestors(tx, boardId, [...binderItems.keys()], loaded);

	const animationIds = new Set([...touches.animations, ...touches.items, ...touches.references]);
	const refIds = [...subtree, ...touches.deletedAnimations];
	const hasTimeTracks = Object.values(patch.animations ?? {}).some((value) => value && Object.values(value.tracks ?? {}).some((track) => track && (track.property === "time" || track.property === undefined)));
	const trackFilters = [
		...(touches.tracks.length ? [sql`(${boardTracks.animationId}, ${boardTracks.id}) IN (${sql.join(touches.tracks.map((ref) => sql`(${ref.animation}, ${ref.track})`), sql`, `)})`] : []),
		...(touches.deletedAnimations.length ? [inArray(boardTracks.animationId, touches.deletedAnimations)] : []),
		...(refIds.length ? [sql`${boardTracks.refs} && ${textArray(refIds)}`] : []),
		...(hasTimeTracks ? [sql`${boardTracks.data}->>'property' = 'time'`] : []),
	];
	const trackRows = trackFilters.length
		? await tx
				.select({ animationId: boardTracks.animationId, id: boardTracks.id, data: boardTracks.data })
				.from(boardTracks)
				.where(and(eq(boardTracks.boardId, boardId), sql.join(trackFilters.map((filter) => sql`(${filter})`), sql` OR `)))
		: [];
	const tracks = new Map<string, Map<string, BoardTrack>>();
	const refs = new Map<string, Array<{ animation: string; track: string }>>();
	for (const row of trackRows) {
		const track = readTrack(row.data);
		if (!track) continue;
		const map = tracks.get(row.animationId) ?? new Map<string, BoardTrack>();
		map.set(row.id, track);
		tracks.set(row.animationId, map);
		animationIds.add(row.animationId);
		if (track.property === "time") animationIds.add(track.target);
		for (const ref of trackReferences(track)) refs.set(ref, [...(refs.get(ref) ?? []), { animation: row.animationId, track: row.id }]);
	}
	const fullTrackAnimations = [...new Set([...touches.deletedAnimations, ...(hasTimeTracks ? [...tracks.keys()] : [])])];
	if (fullTrackAnimations.length) {
		const rows = await tx
			.select({ animationId: boardTracks.animationId, id: boardTracks.id, data: boardTracks.data })
			.from(boardTracks)
			.where(and(eq(boardTracks.boardId, boardId), inArray(boardTracks.animationId, fullTrackAnimations)));
		for (const row of rows) {
			const track = readTrack(row.data);
			if (!track) continue;
			const map = tracks.get(row.animationId) ?? new Map<string, BoardTrack>();
			map.set(row.id, track);
			tracks.set(row.animationId, map);
		}
	}
	const inheritedRefs = [...tracks.values()].flatMap((map) => [...map.values()].flatMap(trackReferences));
	await loadWithAncestors(tx, boardId, inheritedRefs, loaded);
	for (const id of inheritedRefs) animationIds.add(id);
	const animations = new Map<string, BoardAnimationHeader>();
	const revisions = new Map<string, number>();
	const ids = [...animationIds].filter((id) => id !== BOARD_CAMERA_TARGET);
	if (ids.length) {
		const rows = await tx
			.select({ id: boardAnimations.id, data: boardAnimations.data, revision: boardAnimations.revision })
			.from(boardAnimations)
			.where(and(eq(boardAnimations.boardId, boardId), inArray(boardAnimations.id, ids)));
		for (const row of rows) {
			const header = readHeader(row.data);
			if (header) animations.set(row.id, header);
			revisions.set(row.id, row.revision);
		}
	}

	const maxZ = new Map<string, number>();
	const newParents = new Set<string>();
	for (const [id, value] of Object.entries(patch.items ?? {})) {
		if (value && value.z === undefined && !loaded.items.has(id)) newParents.add(typeof value.parent === "string" ? value.parent : "");
	}
	if (newParents.size) {
		const rows = await tx
			.select({ parent: boardItems.parentId, z: sql<number | null>`max(${boardItems.z})` })
			.from(boardItems)
			.where(and(eq(boardItems.boardId, boardId), or(
				newParents.has("") ? isNull(boardItems.parentId) : undefined,
				inArray(boardItems.parentId, [...newParents].filter(Boolean)),
			)))
			.groupBy(boardItems.parentId);
		for (const row of rows) maxZ.set(row.parent ?? "", Number(row.z ?? 0));
	}

	const settings = readSettings(settingsData);
	const layout = createBoardLayout((id) => loaded.items.get(id));
	const state: BoardState = {
		settings: () => settings,
		item: (id) => loaded.items.get(id),
		animation: (id) => animations.get(id),
		track: (animationId, trackId) => tracks.get(animationId)?.get(trackId),
		trackIds: (animationId) => [...(tracks.get(animationId)?.keys() ?? [])],
		children: (id) => [...(children.get(id) ?? [])],
		binders: (id) => [...(bindersById.get(id) ?? [])],
		trackRefs: (id) => refs.get(id) ?? [],
		maxZ: (parent) => maxZ.get(parent ?? "") ?? 0,
	};
	return { state, layout, loaded, animations, tracks, revisions, children, binders: bindersById, refs, maxZ };
}

const TRANSFORM_KEYS = ["position", "size", "rotation", "scale", "origin", "parent", "props"] as const;

function transformChanged(before: BoardItem | null | undefined, after: BoardItem | null | undefined): boolean {
	if (!before || !after) return true;
	return TRANSFORM_KEYS.some((key) => !boardJsonEquals((before as JsonRecord)[key], (after as JsonRecord)[key]));
}

async function writeDelta(tx: Tx, boardId: string, after: BoardDelta, preloaded: Preloaded, version: number, now: Date) {
	const { loaded } = preloaded;
	const before = new Map(loaded.items);
	for (const [id, item] of Object.entries(after.items ?? {})) {
		if (item) loaded.items.set(id, item);
		else loaded.items.delete(id);
	}

	const moved = Object.entries(after.items ?? {})
		.filter(([id, item]) => transformChanged(before.get(id), item))
		.map(([id]) => id);
	const descendants = await loadDescendants(tx, boardId, moved.filter((id) => loaded.items.get(id)?.type === "frame" || before.get(id)?.type === "frame"));
	for (const [id, item] of descendants) if (!(after.items && id in after.items)) loaded.items.set(id, item);
	const affected = new Set([...moved, ...descendants.keys()]);
	const binders = await loadBinders(tx, boardId, [...affected]);
	for (const [id, item] of binders) {
		if (!(after.items && id in after.items)) loaded.items.set(id, item);
		affected.add(id);
	}
	await loadWithAncestors(tx, boardId, [...binders.keys(), ...[...binders.values()].flatMap(arrowBindings)], loaded);
	for (const id of Object.keys(after.items ?? {})) affected.add(id);
	const layout = createBoardLayout((id) => loaded.items.get(id));

	const upserts: Array<typeof boardItems.$inferInsert> = [];
	const deletes: string[] = [];
	const boundsOnly: Array<{ id: string; minX: number; minY: number; maxX: number; maxY: number }> = [];
	for (const id of affected) {
		const item = loaded.items.get(id);
		if (!item) {
			deletes.push(id);
			continue;
		}
		const bounds = layout.bounds(id);
		const box = { minX: bounds.x, minY: bounds.y, maxX: bounds.x + bounds.width, maxY: bounds.y + bounds.height };
		if (after.items && id in after.items) {
			upserts.push({
				boardId,
				id,
				type: item.type,
				parentId: item.parent ?? null,
				z: item.z ?? 0,
				...box,
				src: "src" in item.props && typeof item.props.src === "string" ? item.props.src : null,
				binds: arrowBindings(item),
				data: itemData(item),
				version,
				createdAt: now,
				updatedAt: now,
			});
		} else boundsOnly.push({ id, ...box });
	}
	for (let offset = 0; offset < deletes.length; offset += WRITE_CHUNK) {
		await tx.delete(boardItems).where(and(eq(boardItems.boardId, boardId), inArray(boardItems.id, deletes.slice(offset, offset + WRITE_CHUNK))));
	}
	for (let offset = 0; offset < upserts.length; offset += WRITE_CHUNK) {
		await tx
			.insert(boardItems)
			.values(upserts.slice(offset, offset + WRITE_CHUNK))
			.onConflictDoUpdate({
				target: [boardItems.boardId, boardItems.id],
				set: {
					type: sql`excluded.type`,
					parentId: sql`excluded.parent_id`,
					z: sql`excluded.z`,
					minX: sql`excluded.min_x`,
					minY: sql`excluded.min_y`,
					maxX: sql`excluded.max_x`,
					maxY: sql`excluded.max_y`,
					src: sql`excluded.src`,
					binds: sql`excluded.binds`,
					data: sql`excluded.data`,
					version: sql`excluded.version`,
					updatedAt: sql`excluded.updated_at`,
				},
			});
	}
	for (let offset = 0; offset < boundsOnly.length; offset += WRITE_CHUNK) {
		const chunk = boundsOnly.slice(offset, offset + WRITE_CHUNK);
		await tx.execute(sql`
			UPDATE ${boardItems} AS i SET min_x = v.min_x, min_y = v.min_y, max_x = v.max_x, max_y = v.max_y, version = ${version}, updated_at = ${now.toISOString()}::timestamptz
			FROM (VALUES ${sql.join(chunk.map((row) => sql`(${row.id}, ${row.minX}::float8, ${row.minY}::float8, ${row.maxX}::float8, ${row.maxY}::float8)`), sql`, `)}) AS v(id, min_x, min_y, max_x, max_y)
			WHERE i.board_id = ${boardId} AND i.id = v.id
		`);
	}

	const touchedAnimations = new Set([...Object.keys(after.animations ?? {}), ...Object.keys(after.tracks ?? {})]);
	const deletedAnimations = Object.entries(after.animations ?? {}).filter(([, value]) => value === null).map(([id]) => id);
	if (deletedAnimations.length) {
		await tx.delete(boardTracks).where(and(eq(boardTracks.boardId, boardId), inArray(boardTracks.animationId, deletedAnimations)));
		await tx.delete(boardAnimations).where(and(eq(boardAnimations.boardId, boardId), inArray(boardAnimations.id, deletedAnimations)));
	}
	for (const [id, header] of Object.entries(after.animations ?? {})) {
		if (!header) continue;
		const revision = (preloaded.revisions.get(id) ?? 0) + 1;
		await tx
			.insert(boardAnimations)
			.values({ boardId, id, data: headerData(header), revision, createdAt: now, updatedAt: now })
			.onConflictDoUpdate({ target: [boardAnimations.boardId, boardAnimations.id], set: { data: headerData(header), revision, updatedAt: now } });
	}
	const trackUpserts: Array<typeof boardTracks.$inferInsert> = [];
	const trackDeletes: Array<{ animation: string; track: string }> = [];
	for (const [animationId, tracks] of Object.entries(after.tracks ?? {})) {
		if (deletedAnimations.includes(animationId)) continue;
		for (const [id, track] of Object.entries(tracks)) {
			if (track) trackUpserts.push({ boardId, animationId, id, target: track.target, refs: trackReferences(track), data: trackData(track) });
			else trackDeletes.push({ animation: animationId, track: id });
		}
	}
	for (let offset = 0; offset < trackDeletes.length; offset += WRITE_CHUNK) {
		const chunk = trackDeletes.slice(offset, offset + WRITE_CHUNK);
		await tx.delete(boardTracks).where(and(eq(boardTracks.boardId, boardId), sql`(${boardTracks.animationId}, ${boardTracks.id}) IN (${sql.join(chunk.map((ref) => sql`(${ref.animation}, ${ref.track})`), sql`, `)})`));
	}
	for (let offset = 0; offset < trackUpserts.length; offset += WRITE_CHUNK) {
		await tx
			.insert(boardTracks)
			.values(trackUpserts.slice(offset, offset + WRITE_CHUNK))
			.onConflictDoUpdate({
				target: [boardTracks.boardId, boardTracks.animationId, boardTracks.id],
				set: { target: sql`excluded.target`, refs: sql`excluded.refs`, data: sql`excluded.data` },
			});
	}
	const trackOnly = [...touchedAnimations].filter((id) => !(after.animations && id in after.animations) && !deletedAnimations.includes(id));
	if (trackOnly.length) {
		await tx
			.update(boardAnimations)
			.set({ revision: sql`${boardAnimations.revision} + 1`, updatedAt: now })
			.where(and(eq(boardAnimations.boardId, boardId), inArray(boardAnimations.id, trackOnly)));
	}
}


export async function createBoard(
	db: BoardDatabase,
	input: { spaceId: string; boardId?: string; title: string; actorId: string; document?: BoardPatch; mutationId?: string; source?: RequestSource | null },
): Promise<{ boardId: string; result: BoardApplyResult }> {
	const boardId = input.boardId ?? randomUUID();
	return db.transaction(async (tx) => {
		const now = new Date();
		await tx.insert(boards).values({ id: boardId, spaceId: input.spaceId, title: input.title, version: 0, settings: {}, createdAt: now, updatedAt: now }).onConflictDoNothing();
		const apply = BoardApplyInputSchema.parse({ patch: input.document ?? {}, mutationId: input.mutationId ?? `create:${boardId}` });
		const { result } = await applyBoardInTransaction(tx, { spaceId: input.spaceId, boardId, actorId: input.actorId, apply, source: input.source });
		return { boardId, result };
	});
}

export async function deleteBoard(db: BoardDatabase, input: { spaceId: string; boardId: string }): Promise<void> {
	await db.transaction(async (tx) => {
		await findBoard(tx, input.spaceId, input.boardId, true);
		const ownedBy = (table: { boardId: AnyPgColumn }) => eq(table.boardId, input.boardId);
		await tx.delete(boardTracks).where(ownedBy(boardTracks));
		await tx.delete(boardAnimations).where(ownedBy(boardAnimations));
		await tx.delete(boardItems).where(ownedBy(boardItems));
		await tx.delete(boardTransactions).where(ownedBy(boardTransactions));
		await tx.delete(boards).where(and(eq(boards.id, input.boardId), eq(boards.spaceId, input.spaceId)));
	});
}


export function boardPlaybackPosition(playback: BoardPlaybackSnapshot, header: BoardAnimationHeader | undefined, now: number): number {
	const duration = header?.duration ?? 0;
	if (playback.status !== "playing") return playback.position;
	let position = playback.position + Math.max(0, now - playback.effectiveAt) * playback.timeScale;
	const pause = header?.markers.find((marker) => marker.pause && marker.at > playback.position && marker.at <= position);
	if (pause) return pause.at;
	if (header?.loop || header?.play === "always") return duration > 0 ? position % duration : 0;
	position = Math.min(position, duration);
	return position;
}

export async function applyBoardPlayback(
	db: BoardDatabase,
	input: { spaceId: string; boardId: string; command: BoardPlaybackCommand },
): Promise<BoardPlaybackSnapshot | null> {
	return db.transaction(async (tx) => {
		const board = await findBoard(tx, input.spaceId, input.boardId, true);
		const current = playbackOf(board.playback);
		const { command } = input;
		if (current?.commandId === command.commandId) return current;
		const now = Date.now();
		const loadAnimation = async (id: string) => {
			const [row] = await tx.select({ data: boardAnimations.data, revision: boardAnimations.revision }).from(boardAnimations).where(and(eq(boardAnimations.boardId, board.id), eq(boardAnimations.id, id))).limit(1);
			if (!row) throw new BoardError(404, "ANIMATION_NOT_FOUND", `Animation ${id} does not exist.`);
			return { header: readHeader(row.data), revision: row.revision };
		};
		let next: BoardPlaybackSnapshot | null;
		if (command.type === "play") {
			const { header, revision } = await loadAnimation(command.animationId);
			next = {
				playbackId: randomUUID(),
				animationId: command.animationId,
				animationRevision: revision,
				revision: (current?.revision ?? 0) + 1,
				status: "playing",
				position: Math.min(command.position ?? 0, header?.duration ?? 0),
				effectiveAt: now,
				timeScale: command.timeScale ?? 1,
				seed: command.seed ?? command.animationId,
				commandId: command.commandId,
			};
		} else {
			if (!current) throw new BoardError(409, "PLAYBACK_NOT_ACTIVE", "Nothing is playing.");
			const { header } = await loadAnimation(current.animationId);
			const position = boardPlaybackPosition(current, header, now);
			const base = { ...current, revision: current.revision + 1, effectiveAt: now, commandId: command.commandId };
			if (command.type === "stop") next = null;
			else if (command.type === "pause") next = { ...base, status: "paused", position };
			else if (command.type === "resume") next = { ...base, status: "playing", position };
			else if (command.type === "seek") next = { ...base, position: Math.min(command.position, header?.duration ?? 0) };
			else {
				const marker = header?.markers.find((entry) => entry.pause && entry.at > position);
				next = { ...base, status: "playing", position: marker && current.status === "paused" && position < marker.at ? marker.at + 1e-3 : position + 1e-3 };
			}
		}
		await tx.update(boards).set({ playback: next as unknown as JsonRecord | null }).where(eq(boards.id, board.id));
		return next;
	});
}


export async function readBoardHistory(
	db: BoardDatabase,
	input: { spaceId: string; boardId: string; history?: BoardHistoryInput },
): Promise<BoardHistoryPage> {
	const history = BoardHistoryInputSchema.parse(input.history ?? {});
	const board = await findBoard(db, input.spaceId, input.boardId);
	const rows = await db
		.select()
		.from(boardTransactions)
		.where(and(
			eq(boardTransactions.boardId, board.id),
			sql`${boardTransactions.resultVersion} IS NOT NULL`,
			...(history.before ? [sql`${boardTransactions.resultVersion} < ${history.before}`] : []),
		))
		.orderBy(sql`${boardTransactions.resultVersion} DESC`)
		.limit(history.limit + 1);
	const page = rows.slice(0, history.limit);
	const transactions: BoardTransactionRecord[] = page.map((row) => {
		const changes = row.changes as { before?: BoardDelta; after?: BoardDelta } | null;
		const metadata = row.metadata as { source?: RequestSource };
		return {
			id: row.id,
			mutationId: row.txId,
			baseVersion: row.baseVersion,
			version: row.resultVersion as number,
			actorId: row.actorId,
			clientId: row.clientId,
			source: metadata.source ?? null,
			createdAt: row.createdAt.toISOString(),
			before: storedDelta(changes?.before),
			after: storedDelta(changes?.after),
		};
	});
	return {
		version: board.version,
		transactions,
		nextBefore: rows.length > history.limit ? (page.at(-1)?.resultVersion ?? null) : null,
	};
}

export async function restoreBoardVersion(
	db: BoardDatabase,
	input: { spaceId: string; boardId: string; actorId: string; version: number; source?: RequestSource | null },
): Promise<BoardApplyOutcome> {
	return db.transaction(async (tx) => {
		const board = await findBoard(tx, input.spaceId, input.boardId, true);
		if (input.version >= board.version) throw new BoardError(400, "INVALID_VERSION", `Board is at version ${board.version}.`);
		const rows = await tx
			.select({ resultVersion: boardTransactions.resultVersion, changes: boardTransactions.changes })
			.from(boardTransactions)
			.where(and(eq(boardTransactions.boardId, board.id), sql`${boardTransactions.resultVersion} > ${input.version}`))
			.orderBy(sql`${boardTransactions.resultVersion} DESC`);
		const target = { board: undefined as BoardDelta["board"], items: {} as NonNullable<BoardDelta["items"]>, animations: {} as NonNullable<BoardDelta["animations"]>, tracks: {} as NonNullable<BoardDelta["tracks"]> };
		for (const row of rows) {
			const changes = row.changes as { before?: BoardDelta } | null;
			const delta = storedDelta(changes?.before);
			if (!delta) throw new BoardError(400, "HISTORY_UNAVAILABLE", `History before version ${row.resultVersion} predates the current Board protocol.`);
			if (delta.board) target.board = delta.board;
			Object.assign(target.items, delta.items);
			Object.assign(target.animations, delta.animations);
			for (const [animationId, tracks] of Object.entries(delta.tracks ?? {})) target.tracks[animationId] = { ...target.tracks[animationId], ...tracks };
		}
		const current = await readDocument(tx, board.id, board.settings);
		const patch: BoardPatch = {};
		const boardValue = target.board ? diffMergePatch(current.board, target.board) : undefined;
		if (boardValue !== undefined) patch.board = boardValue as JsonRecord;
		const items: NonNullable<BoardPatch["items"]> = {};
		for (const [id, item] of Object.entries(target.items)) {
			const existing = current.items[id];
			const value = item ? (existing?.type === item.type ? diffMergePatch(existing, item) : item) : existing ? null : undefined;
			if (value !== undefined) items[id] = value as JsonRecord | null;
		}
		if (Object.keys(items).length) patch.items = items;
		const animations: NonNullable<BoardPatch["animations"]> = {};
		for (const id of new Set([...Object.keys(target.animations), ...Object.keys(target.tracks)])) {
			const header = id in target.animations ? target.animations[id] : undefined;
			const existing = current.animations[id];
			if (header === null) {
				if (existing) animations[id] = null;
				continue;
			}
			const { tracks: currentTracks = {}, ...currentHeader } = existing ?? ({} as Partial<BoardAnimation>);
			const entry: JsonRecord = {};
			if (header) {
				const value = existing ? diffMergePatch(currentHeader, header) : headerData(header);
				if (value && typeof value === "object") Object.assign(entry, value);
			}
			const tracks: Record<string, JsonRecord | null> = {};
			for (const [trackId, track] of Object.entries(target.tracks[id] ?? {})) {
				const value = track ? diffMergePatch(currentTracks[trackId], track) : currentTracks[trackId] ? null : undefined;
				if (value !== undefined) tracks[trackId] = value as JsonRecord | null;
			}
			if (Object.keys(tracks).length) entry.tracks = tracks;
			if (Object.keys(entry).length) animations[id] = entry as NonNullable<BoardPatch["animations"]>[string];
		}
		if (Object.keys(animations).length) patch.animations = animations;
		const apply = BoardApplyInputSchema.parse({ patch, cascade: true, mutationId: `restore:${board.id}:${input.version}:${board.version}` });
		return applyBoardInTransaction(tx, { spaceId: input.spaceId, boardId: board.id, actorId: input.actorId, apply, source: input.source });
	});
}


export async function captureBoardSnapshots(db: BoardDatabase, input: { spaceId: string; boardIds?: string[] }): Promise<BoardSnapshot[]> {
	if (input.boardIds?.length === 0) return [];
	return db.transaction(async (tx) => {
		const rows = await tx
			.select()
			.from(boards)
			.where(input.boardIds ? and(eq(boards.spaceId, input.spaceId), inArray(boards.id, input.boardIds)) : eq(boards.spaceId, input.spaceId))
			.orderBy(boards.id);
		const capturedAt = new Date().toISOString();
		const snapshots: BoardSnapshot[] = [];
		for (const board of rows) {
			const document = await readDocument(tx, board.id, board.settings);
			snapshots.push({
				kind: BOARD_SNAPSHOT_KIND,
				version: BOARD_PROTOCOL_VERSION,
				capturedAt,
				id: board.id,
				title: board.title,
				boardVersion: board.version,
				...document,
			});
		}
		return snapshots;
	}, { isolationLevel: "repeatable read" });
}
