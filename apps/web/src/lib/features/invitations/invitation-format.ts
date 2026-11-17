import type { SpaceRole } from "@neta-art/cohub";
import type { Locale } from "#lib/i18n/locale.ts";
import { m } from "#lib/paraglide/messages.js";

export function spaceRoleLabel(role: SpaceRole, locale: Locale): string {
	if (role === "host") return m.space_role_host({}, { locale });
	if (role === "builder") return m.space_role_builder({}, { locale });
	return m.space_role_guest({}, { locale });
}

export function formatInviteExpiry(
	seconds: number | null,
	locale: Locale,
): string {
	if (seconds === null) return m.space_no_expiry({}, { locale });
	if (seconds < 60) return m.space_invite_expires_lt1m({}, { locale });
	if (seconds < 3600)
		return m.space_invite_expires_m({ n: Math.ceil(seconds / 60) }, { locale });
	if (seconds < 86400)
		return m.space_invite_expires_h(
			{ n: Math.ceil(seconds / 3600) },
			{ locale },
		);
	return m.space_invite_expires_d(
		{ n: Math.ceil(seconds / 86400) },
		{ locale },
	);
}
