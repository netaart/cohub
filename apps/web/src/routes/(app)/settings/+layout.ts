import { loadSettingsPage } from "#lib/features/settings/pages.ts";
import { resolveSettingsSectionRoot } from "#lib/settings-nav.ts";

export const ssr = false;

export const load = async ({ url }) => {
	const section = resolveSettingsSectionRoot(url.pathname);
	if (section) await loadSettingsPage(section);
};
