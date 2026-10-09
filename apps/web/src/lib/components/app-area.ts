import { CircleUserRound, LayoutGrid, MessageSquare } from "lucide-svelte";
import type { Locale } from "$lib/i18n/locale";
import type { AppArea } from "$lib/mobile-nav";
import { m } from "$lib/paraglide/messages.js";

export const APP_AREA_ICONS = {
	chats: MessageSquare,
	spaces: LayoutGrid,
	account: CircleUserRound,
} as const satisfies Record<AppArea, typeof MessageSquare>;

export function appAreaLabel(area: AppArea, locale: Locale) {
	switch (area) {
		case "chats":
			return m.nav_tab_chats({}, { locale });
		case "spaces":
			return m.nav_tab_spaces({}, { locale });
		case "account":
			return m.nav_tab_account({}, { locale });
	}
}
