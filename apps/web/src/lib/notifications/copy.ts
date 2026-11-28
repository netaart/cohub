import type { NotificationRecord } from "@neta-art/cohub";
import type { Locale } from "#lib/i18n/locale.ts";
import { m } from "#lib/paraglide/messages.js";
import {
	buildSpaceRootRoute,
	buildSpaceSessionRoute,
} from "#lib/space-routes.ts";

export function notificationCopy(record: NotificationRecord, locale: Locale) {
	const options = { locale };
	const where = record.payload.sessionTitle || record.payload.spaceTitle;
	switch (record.kind) {
		case "mention.user": {
			const actor =
				record.actors[0]?.displayName ?? m.notif_someone({}, options);
			return {
				title: where
					? m.notif_mentioned_you_in({ actor, where }, options)
					: m.notif_mentioned_you({ actor }, options),
				body: record.payload.preview ?? "",
			};
		}
		case "turn.finished": {
			const subject = where || m.notif_your_task({}, options);
			return {
				title:
					record.payload.status === "failed"
						? m.notif_turn_failed({ subject }, options)
						: m.notif_turn_finished({ subject }, options),
				body: record.payload.preview ?? "",
			};
		}
	}
}

export function notificationHref(record: NotificationRecord) {
	if (record.spaceId && record.sessionId)
		return buildSpaceSessionRoute(record.spaceId, record.sessionId);
	return record.spaceId ? buildSpaceRootRoute(record.spaceId) : "/spaces/inbox";
}
