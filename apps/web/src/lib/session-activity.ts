import type { SessionRecord } from "@neta-art/cohub";
import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";

export type SessionRowStatusKind =
	| "running"
	| "queued"
	| "stopping"
	| "failed"
	| "lost"
	| "unread"
	| "idle";

export type SessionRowStatus = {
	kind: SessionRowStatusKind;
	live: boolean;
	label: string;
	errorMessage: string | null;
	startedAt: string | null;
};

export function getSessionRowStatus(
	session: Pick<SessionRecord, "activeTurn" | "lastTurnIssue">,
	unread: boolean,
	locale: Locale,
): SessionRowStatus {
	const turn = session.activeTurn;
	if (turn) {
		const kind =
			turn.status === "queued"
				? "queued"
				: turn.status === "abort_requested"
					? "stopping"
					: "running";
		const label =
			kind === "queued"
				? m.session_activity_queued({}, { locale })
				: kind === "stopping"
					? m.session_activity_stopping({}, { locale })
					: m.session_activity_running({}, { locale });
		return {
			kind,
			live: true,
			label,
			errorMessage: null,
			startedAt: kind === "running" ? (turn.startedAt ?? null) : null,
		};
	}
	const issue = session.lastTurnIssue;
	// Stops, steers, and local CLI interruptions are the user's own, not issues.
	const issueKind =
		issue?.status === "failed"
			? "failed"
			: issue?.reason === "stale_active_recovered"
				? "lost"
				: null;
	if (issue && issueKind) {
		return {
			kind: issueKind,
			live: false,
			label:
				issueKind === "failed"
					? m.session_activity_failed({}, { locale })
					: m.session_activity_run_lost({}, { locale }),
			errorMessage: issue.errorMessage?.replace(/\s+/g, " ").trim() || null,
			startedAt: null,
		};
	}
	if (unread) {
		return {
			kind: "unread",
			live: false,
			label: m.sidebar_unread({}, { locale }),
			errorMessage: null,
			startedAt: null,
		};
	}
	return {
		kind: "idle",
		live: false,
		label: "",
		errorMessage: null,
		startedAt: null,
	};
}
