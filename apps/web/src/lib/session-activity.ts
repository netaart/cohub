import type { SessionRecord } from "@neta-art/cohub";
import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";

export type SessionActivity = {
	phase: "idle" | "queued" | "running" | "stopping" | "failed" | "interrupted";
	active: boolean;
	label: string;
	detail: string | null;
};

export function getSessionActivity(
	session: Pick<SessionRecord, "activeTurn" | "lastTurnIssue">,
	locale: Locale,
): SessionActivity {
	const turn = session.activeTurn;
	if (turn) {
		const phase =
			turn.status === "queued"
				? "queued"
				: turn.status === "abort_requested"
					? "stopping"
					: "running";
		const label =
			phase === "queued"
				? m.session_activity_queued({}, { locale })
				: phase === "stopping"
					? m.session_activity_stopping({}, { locale })
					: m.session_activity_running({}, { locale });
		return { phase, active: true, label, detail: null };
	}
	const issue = session.lastTurnIssue;
	if (issue) {
		const label =
			issue.status === "failed"
				? m.session_activity_failed({}, { locale })
				: issue.reason === "abort"
					? m.session_activity_stopped({}, { locale })
					: issue.reason === "stale_active_recovered"
						? m.session_activity_run_lost({}, { locale })
						: m.session_activity_interrupted({}, { locale });
		return {
			phase: issue.status,
			active: false,
			label,
			detail: issue.errorMessage,
		};
	}
	return { phase: "idle", active: false, label: "", detail: null };
}
