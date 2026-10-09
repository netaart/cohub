export const SIDE_PANEL_TABS = ["session", "files", "media", "apps"] as const;
export type SidePanelTab = (typeof SIDE_PANEL_TABS)[number];

const STORAGE_KEY = "cohub:right-sidebar-panel:v2";
const LEGACY_STORAGE_KEY = "cohub:right-sidebar-panel:v1";
const DEFAULT_TAB: SidePanelTab = "session";

function isSidePanelTab(value: unknown): value is SidePanelTab {
	return SIDE_PANEL_TABS.includes(value as SidePanelTab);
}

export function readSidePanelTab(): SidePanelTab {
	if (typeof localStorage === "undefined") return DEFAULT_TAB;
	try {
		const value = localStorage.getItem(STORAGE_KEY);
		if (isSidePanelTab(value)) return value;
		const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
		return legacy === "files" || legacy === "apps" ? legacy : DEFAULT_TAB;
	} catch {
		return DEFAULT_TAB;
	}
}

export function writeSidePanelTab(tab: SidePanelTab) {
	try {
		localStorage.setItem(STORAGE_KEY, tab);
		localStorage.removeItem(LEGACY_STORAGE_KEY);
	} catch {
		// A storage policy must not prevent switching tabs.
	}
}
