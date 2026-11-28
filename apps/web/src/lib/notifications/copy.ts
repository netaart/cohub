import { isNotificationKind, type Notice } from "@neta-art/cohub";
import type { Locale } from "#lib/i18n/locale.ts";
import { m } from "#lib/paraglide/messages.js";
import {
	buildSpaceRootRoute,
	buildSpaceSessionRoute,
} from "#lib/space-routes.ts";

export function notificationCopy(notice: Notice, locale: Locale) {
	if (!isNotificationKind(notice.kind)) return null;
	const options = { locale };
	const where = notice.payload.sessionTitle || notice.payload.spaceTitle;
	switch (notice.kind) {
		case "mention": {
			const actor =
				notice.actors[0]?.displayName ?? m.notif_someone({}, options);
			return {
				title: where
					? m.notif_mentioned_you_in({ actor, where }, options)
					: m.notif_mentioned_you({ actor }, options),
				body: notice.payload.preview ?? "",
			};
		}
		case "turn.finished": {
			const subject = where || m.notif_your_task({}, options);
			return {
				title:
					notice.payload.status === "failed"
						? m.notif_turn_failed({ subject }, options)
						: m.notif_turn_finished({ subject }, options),
				body: notice.payload.preview ?? "",
			};
		}
	}
}

export function notificationHref(
	notice: Pick<Notice, "spaceId" | "sessionId">,
) {
	if (notice.spaceId && notice.sessionId)
		return buildSpaceSessionRoute(notice.spaceId, notice.sessionId);
	return notice.spaceId ? buildSpaceRootRoute(notice.spaceId) : "/spaces/inbox";
}
