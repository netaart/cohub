import type { BoardSessionIssue, BoardSessionSnapshot } from "./board-model.js";

export const BOARD_SESSION_SOURCE_PREFIX = "cohub-session:";
export const boardSessionSource = (sessionId: string) =>
	`${BOARD_SESSION_SOURCE_PREFIX}${sessionId}`;

const BOARD_SESSION_EXCERPT_LIMIT = 480;
const BOARD_SESSION_ERROR_LIMIT = 240;

const FENCED_CODE_RE = /```[\s\S]*?(?:```|$)/g;
const LINE_MARKER_RE = /^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm;
const LINK_RE = /!?\[([^\]]*)\]\([^)]*\)/g;
// Paired emphasis only, so `snake_case`, `~/path` and `2 * 3` survive.
const EMPHASIS_RE = /(\*\*|__|~~|\*)(?=\S)([\s\S]*?\S)\1/g;

export function stripSessionMarkdown(value: string): string {
	return value
		.replace(FENCED_CODE_RE, " ")
		.replace(LINE_MARKER_RE, "")
		.replace(LINK_RE, "$1")
		.replace(EMPHASIS_RE, "$2")
		.replace(/`/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function truncateSessionText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const head = text
		.slice(0, Math.max(0, limit - 1))
		.replace(/[\uD800-\uDBFF]$/, "");
	return `${head.trimEnd()}…`;
}

function plain(value: string | null | undefined, limit: number): string | undefined {
	const text = value ? stripSessionMarkdown(value.slice(0, limit * 4)) : "";
	return text ? truncateSessionText(text, limit) : undefined;
}

export type BoardSessionTurnIssue = {
	status: "failed" | "interrupted";
	reason: string | null;
	errorMessage: string | null;
};

export function boardSessionIssue(
	issue: BoardSessionTurnIssue | null | undefined,
): BoardSessionIssue | undefined {
	if (issue?.status === "failed") return "failed";
	return issue?.reason === "stale_active_recovered" ? "lost" : undefined;
}

export type BoardSessionRecord = {
	title: string | null;
	source: string | null;
	latestMessageText: string | null;
	lastMessageAt: string | null;
	createdAt: string | null;
	activeTurn?: unknown;
	lastTurnIssue?: BoardSessionTurnIssue | null;
	spaceId?: string | null;
};

export function sessionToBoardSessionSnapshot(
	session: BoardSessionRecord,
): BoardSessionSnapshot {
	const title = session.title?.replace(/\s+/g, " ").trim().slice(0, 255) ?? "";
	const excerpt = plain(session.latestMessageText, BOARD_SESSION_EXCERPT_LIMIT);
	const source = session.source?.trim().slice(0, 120);
	const issue = session.activeTurn ? undefined : boardSessionIssue(session.lastTurnIssue);
	const errorExcerpt =
		issue === "failed" ? plain(session.lastTurnIssue?.errorMessage, BOARD_SESSION_ERROR_LIMIT) : undefined;
	const activityAt = session.lastMessageAt ?? session.createdAt;
	return {
		title,
		...(excerpt ? { excerpt } : {}),
		...(source ? { source } : {}),
		...(issue ? { issue } : {}),
		...(errorExcerpt ? { errorExcerpt } : {}),
		...(activityAt ? { activityAt } : {}),
		...(session.spaceId ? { spaceId: session.spaceId } : {}),
	};
}
