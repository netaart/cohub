import {
	Activity,
	CreditCard,
	Gift,
	Network,
	NotebookPen,
	Settings,
} from "lucide-svelte";
import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";
import type { SettingsSection } from "$lib/settings-nav";

export const SETTINGS_SECTION_ICONS = {
	general: Settings,
	activity: Activity,
	referrals: Gift,
	billing: CreditCard,
	rules: NotebookPen,
	channels: Network,
} as const satisfies Record<SettingsSection, typeof Settings>;

export function settingsSectionLabel(section: SettingsSection, locale: Locale) {
	const options = { locale };
	switch (section) {
		case "general":
			return m.nav_general({}, options);
		case "activity":
			return m.nav_activity({}, options);
		case "referrals":
			return m.nav_referrals({}, options);
		case "billing":
			return m.nav_billing({}, options);
		case "rules":
			return m.nav_user_rules({}, options);
		case "channels":
			return m.nav_channels({}, options);
	}
}

export function settingsSectionTitle(section: SettingsSection, locale: Locale) {
	const options = { locale };
	switch (section) {
		case "general":
			return m.nav_general({}, options);
		case "activity":
			return m.page_title_activity({}, options);
		case "referrals":
			return m.page_title_referrals({}, options);
		case "billing":
			return m.page_title_billing({}, options);
		case "rules":
			return m.page_title_rules({}, options);
		case "channels":
			return m.page_title_channels({}, options);
	}
}
