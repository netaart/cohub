import { ExternalLink, Link2, Link2Off } from "lucide-svelte";
import { copyTextToClipboard } from "#lib/clipboard.ts";
import { haptic } from "#lib/haptics.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { useCompactShell } from "#lib/layout/compact-shell.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

export type MenuIcon = typeof ExternalLink;

export type MenuItem = {
	id: string;
	label: string;
	icon?: MenuIcon;
	danger?: boolean;
	warning?: boolean;
	checked?: boolean;
	disabled?: boolean;
	run: () => void;
};

export const MENU_SEPARATOR: "separator" = "separator";

export type MenuEntry = MenuItem | typeof MENU_SEPARATOR;

export type MenuEntries = ReadonlyArray<MenuEntry | false | null | undefined>;

export function normalizeMenu(entries: MenuEntries): MenuEntry[] {
	const list: MenuEntry[] = [];
	for (const entry of entries) {
		if (!entry) continue;
		if (
			entry === MENU_SEPARATOR &&
			(list.length === 0 || list.at(-1) === entry)
		)
			continue;
		list.push(entry);
	}
	if (list.at(-1) === MENU_SEPARATOR) list.pop();
	return list;
}

function webUrl(href: string) {
	try {
		const url = new URL(href, window.location.href);
		return url.protocol === "https:" || url.protocol === "http:" ? url : null;
	} catch {
		return null;
	}
}

export function linkEntries(href: string): MenuItem[] {
	const url = webUrl(href);
	if (!url) return [];
	const locale = getLocale();
	const copy: MenuItem = {
		id: "copy-link",
		label: m.library_copy_link({}, { locale }),
		icon: Link2,
		run: () => {
			copyTextToClipboard(url.href).then(
				() => haptic("confirm"),
				() => haptic("reject"),
			);
		},
	};
	if (useCompactShell()) return [copy];
	return [
		{
			id: "open-new-tab",
			label: m.window_open_in_new_tab({}, { locale }),
			icon: ExternalLink,
			run: () => window.open(url.href, "_blank", "noopener,noreferrer"),
		},
		copy,
	];
}

export function removeLabelEntry(
	title: string | undefined,
	disabled: boolean,
	run: (() => void) | undefined,
): MenuItem | null {
	if (!run) return null;
	return {
		id: "remove-label",
		label:
			title ?? m.sidebar_remove_from_label_generic({}, { locale: getLocale() }),
		icon: Link2Off,
		danger: true,
		disabled,
		run,
	};
}
