import {
	type BoardHistoryPage,
	type BoardSessionSnapshot,
	sessionToBoardSessionSnapshot,
} from "@cohub/protocol";
import type { SessionRecord } from "@neta-art/cohub";
import type {
	BoardSessionLive,
	BoardSessionStatus,
} from "@neta-art/cohub/board/render";
import type { Locale } from "#lib/i18n/locale.ts";
import { m } from "#lib/paraglide/messages.js";
import { getSessionRowStatus } from "#lib/session-activity.ts";
import { getSessionListTitle } from "#lib/session-fork-tree.ts";
import {
	getSessionPreview,
	getSessionPreviewText,
} from "#lib/session-preview.ts";
import { getSessionActivityAt } from "#lib/session-sort.ts";
import { sessionAttributionName } from "#lib/stores/chats-filter.ts";
import { formatCompactAbsoluteTime } from "#lib/time-format.ts";

const EXCERPT_LIMIT = 360;

export function boardSessionLive(
	session: SessionRecord,
	unread: boolean,
	locale: Locale,
): BoardSessionLive {
	const row = getSessionRowStatus(session, unread, locale);
	const status: BoardSessionStatus = row.kind === "unread" ? "idle" : row.kind;
	const title =
		getSessionListTitle(session) ?? m.sidebar_new_chat({}, { locale });
	const attribution = sessionAttributionName(session, locale);
	const excerpt =
		row.errorMessage ??
		(attribution
			? getSessionPreview(session, title, EXCERPT_LIMIT)
			: getSessionPreviewText(session, EXCERPT_LIMIT));
	const startedAt = row.startedAt ? Date.parse(row.startedAt) : Number.NaN;
	return {
		title,
		excerpt,
		meta: [
			attribution ?? "",
			formatCompactAbsoluteTime(getSessionActivityAt(session)),
		]
			.filter(Boolean)
			.join(" · "),
		status,
		label: row.kind === "idle" || row.kind === "unread" ? "" : row.label,
		startedAt: Number.isFinite(startedAt) ? startedAt : null,
		model: status === "running" ? (session.activeTurn?.model ?? null) : null,
		unread,
	};
}

export function boardSessionDropSnapshot(
	session: SessionRecord | undefined,
	title: string | undefined,
): BoardSessionSnapshot {
	return session
		? sessionToBoardSessionSnapshot(session)
		: { title: title ?? "" };
}

export function sessionChangedItems(
	pages: readonly BoardHistoryPage[],
	sessionId: string,
): string[] {
	const ids = new Set<string>();
	for (const page of pages)
		for (const transaction of page.transactions)
			if (transaction.source?.sessionId === sessionId)
				for (const id of Object.keys(transaction.after?.items ?? {}))
					ids.add(id);
	return [...ids];
}
