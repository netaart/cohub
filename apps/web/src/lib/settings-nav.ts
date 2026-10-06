export type SettingsSection =
	| "general"
	| "activity"
	| "referrals"
	| "billing"
	| "rules"
	| "channels";

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
	"general",
	"activity",
	"referrals",
	"billing",
	"rules",
	"channels",
];

export function settingsSectionHref(section: SettingsSection): string {
	return `/settings/${section}`;
}

export function resolveSettingsSection(
	pathname: string,
): SettingsSection | null {
	const segment = pathname.split("/").filter(Boolean)[1];
	if (!segment) return null;
	if (segment === "balance") return "billing";
	return (SETTINGS_SECTIONS as readonly string[]).includes(segment)
		? (segment as SettingsSection)
		: null;
}

export function resolveSettingsSectionRoot(
	pathname: string,
): SettingsSection | null {
	const segments = pathname.split("/").filter(Boolean);
	if (segments.length !== 2 || segments[0] !== "settings") return null;
	return (SETTINGS_SECTIONS as readonly string[]).includes(segments[1])
		? (segments[1] as SettingsSection)
		: null;
}
