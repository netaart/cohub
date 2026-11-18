import { and, eq, inArray, sql } from "drizzle-orm";
import { accessPolicies, boardItems, boards, spaceSessions } from "@cohub/db";
import {
	type BoardItem,
	type BoardPatch,
	type BoardSessionSnapshot,
	boardSessionSource,
	diffMergePatch,
	isUuid,
	sessionToBoardSessionSnapshot,
} from "@cohub/protocol";
import { readSessionActiveTurns } from "../sessions/snapshot.js";
import type { BoardDatabase } from "./store.js";
import { systemMayShow, unclaimed } from "./system-access.js";

type Executor = Parameters<Parameters<BoardDatabase["transaction"]>[0]>[0] | BoardDatabase;
type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const BOARD_SESSION_SYNC_LIMIT = 100;

export type BoardSessionViewer = (session: { id: string; spaceId: string }) => boolean | Promise<boolean>;

export async function readBoardSessionSnapshots(
	db: Executor,
	ids: Iterable<string>,
): Promise<Map<string, BoardSessionSnapshot & { spaceId: string }>> {
	const wanted = [...new Set(ids)].filter((id) => isUuid(id));
	if (!wanted.length) return new Map();
	const rows = await db
		.select({
			id: spaceSessions.id,
			spaceId: spaceSessions.spaceId,
			title: spaceSessions.title,
			source: spaceSessions.source,
			latestMessageText: sql<string | null>`left(${spaceSessions.latestMessageText}, 2000)`,
			lastMessageAt: spaceSessions.lastMessageAt,
			createdAt: spaceSessions.createdAt,
			restricted: sql<boolean>`${accessPolicies.id} IS NOT NULL`,
		})
		.from(spaceSessions)
		.leftJoin(accessPolicies, and(eq(accessPolicies.resourceType, "session"), eq(accessPolicies.resourceId, spaceSessions.id)))
		.where(inArray(spaceSessions.id, wanted));
	if (!rows.length) return new Map();
	const turns = await readSessionActiveTurns(db, rows.map((row) => row.id));
	return new Map(rows.map(({ restricted, ...row }) => {
		const turn = turns.get(row.id);
		const snapshot = sessionToBoardSessionSnapshot({
			...row,
			latestMessageText: restricted ? null : row.latestMessageText,
			lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
			createdAt: row.createdAt?.toISOString() ?? null,
			activeTurn: turn?.activeTurn,
			lastTurnIssue: turn?.lastTurnIssue && restricted ? { ...turn.lastTurnIssue, errorMessage: null } : turn?.lastTurnIssue,
		});
		return [row.id, { ...snapshot, spaceId: row.spaceId }];
	}));
}

export type BoardSessionResolution =
	| { ok: true; patch: BoardPatch }
	| { ok: false; status: 403 | 404; code: "SESSION_FORBIDDEN" | "SESSION_NOT_FOUND"; path: string; message: string };

export async function resolveBoardSessionSnapshots(
	tx: Executor,
	input: {
		home: string;
		patch: BoardPatch;
		current: (id: string) => BoardItem | undefined;
		viewer?: BoardSessionViewer;
		whole?: boolean;
	},
): Promise<BoardSessionResolution> {
	type Candidate = {
		id: string;
		value: JsonRecord;
		props: JsonRecord;
		sessionId: string;
		whole: boolean;
		previous?: BoardSessionSnapshot;
		base?: BoardSessionSnapshot;
	};
	const candidates: Candidate[] = [];
	for (const [id, value] of Object.entries(input.patch.items ?? {})) {
		if (!isRecord(value)) continue;
		const current = input.current(id);
		const whole = Boolean(input.whole) || !current || (typeof value.type === "string" && value.type !== current.type);
		const props = isRecord(value.props) ? value.props : undefined;
		if (whole ? value.type !== "session" : current.type !== "session" || !props) continue;
		const existing = current?.type === "session" ? current.props : undefined;
		const sessionId = typeof props?.sessionId === "string" ? props.sessionId : whole ? undefined : existing?.sessionId;
		if (!sessionId) continue;
		candidates.push({
			id,
			value,
			props: props ?? {},
			sessionId,
			whole,
			previous: existing?.sessionId === sessionId ? existing.snapshot : undefined,
			base: whole ? undefined : existing?.snapshot,
		});
	}
	if (!candidates.length) return { ok: true, patch: input.patch };

	const snapshots = await readBoardSessionSnapshots(tx, candidates.map((candidate) => candidate.sessionId));
	const decisions = new Map<string, Promise<boolean>>();
	const visible = (id: string, spaceId: string, previous: BoardSessionSnapshot | undefined) => {
		if (!input.viewer) return Promise.resolve(systemMayShow(input.home, spaceId, previous));
		let decision = decisions.get(id);
		if (!decision) {
			decision = Promise.resolve(input.viewer({ id, spaceId }));
			decisions.set(id, decision);
		}
		return decision;
	};

	const items: NonNullable<BoardPatch["items"]> = { ...input.patch.items };
	for (const candidate of candidates) {
		const fresh = snapshots.get(candidate.sessionId);
		const path = `items.${candidate.id}.props.sessionId`;
		const { snapshot: supplied, ...props } = candidate.props;
		const keep = () => {
			items[candidate.id] = { ...candidate.value, props: candidate.whole ? { ...props, snapshot: candidate.previous } : props };
		};
		if (!fresh) {
			if (supplied !== undefined) continue;
			if (!candidate.previous) return { ok: false, status: 404, code: "SESSION_NOT_FOUND", path, message: `Session ${candidate.sessionId} does not exist; write its snapshot to show it as is.` };
			keep();
			continue;
		}
		if (!(await visible(candidate.sessionId, fresh.spaceId, candidate.previous))) {
			if (candidate.previous) keep();
			else if (!input.viewer && isRecord(supplied)) items[candidate.id] = { ...candidate.value, props: { ...props, snapshot: unclaimed(supplied) } };
			else return { ok: false, status: 403, code: "SESSION_FORBIDDEN", path, message: `You cannot view session ${candidate.sessionId}.` };
			continue;
		}
		const change = candidate.base ? diffMergePatch(candidate.base, fresh) : fresh;
		items[candidate.id] = { ...candidate.value, props: change === undefined ? props : { ...props, snapshot: change } };
	}
	return { ok: true, patch: { ...input.patch, items } };
}

export function staleSessionCards(sessionId: string, snapshot: BoardSessionSnapshot & { spaceId: string }) {
	return and(
		eq(boardItems.type, "session"),
		eq(boardItems.src, boardSessionSource(sessionId)),
		sql`${boardItems.data}->'props'->'snapshot' IS DISTINCT FROM ${JSON.stringify(snapshot)}::jsonb`,
		sql`(${boardItems.data}->'props'->'snapshot'->>'spaceId' = ${snapshot.spaceId}
			OR EXISTS (SELECT 1 FROM ${boards} WHERE ${boards.id} = ${boardItems.boardId} AND ${boards.spaceId} = ${snapshot.spaceId}))`,
	);
}

export async function listStaleSessionBoards(
	db: Executor,
	input: { sessionId: string; snapshot: BoardSessionSnapshot & { spaceId: string }; limit?: number },
): Promise<string[]> {
	const rows = await db
		.selectDistinct({ boardId: boardItems.boardId })
		.from(boardItems)
		.where(staleSessionCards(input.sessionId, input.snapshot))
		.limit(input.limit ?? BOARD_SESSION_SYNC_LIMIT);
	return rows.map((row) => row.boardId);
}

export async function isSessionOnBoards(db: Executor, sessionId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: boardItems.id })
		.from(boardItems)
		.where(and(eq(boardItems.type, "session"), eq(boardItems.src, boardSessionSource(sessionId))))
		.limit(1);
	return Boolean(row);
}
