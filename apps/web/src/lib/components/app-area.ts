import type { EntityIconName } from "$lib/components/EntityIcon.svelte";
import type { Locale } from "$lib/i18n/locale";
import type { AppArea } from "$lib/mobile-nav";
import { m } from "$lib/paraglide/messages.js";

export const APP_AREA_ICONS = {
	chats: "chat",
	spaces: "spaces",
	account: "account",
} as const satisfies Record<AppArea, EntityIconName>;

export function appAreaLabel(area: AppArea, locale: Locale) {
	switch (area) {
		case "chats":
			return m.nav_tab_chats({}, { locale });
		case "spaces":
			return m.nav_tab_library({}, { locale });
		case "account":
			return m.nav_tab_account({}, { locale });
	}
}
