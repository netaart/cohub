import type { AppArea } from "$lib/mobile-nav";

export type CommandPaletteIntent = "navigate" | "new-chat";

export type OpenCommandPaletteDetail = {
	query?: string;
	placeholder?: string;
	title?: string;
	intent?: CommandPaletteIntent;
};

export const OPEN_COMMAND_PALETTE_EVENT = "cohub:open-command-palette";

export function openCommandPalette(detail?: OpenCommandPaletteDetail) {
	window.dispatchEvent(
		new CustomEvent<OpenCommandPaletteDetail | undefined>(
			OPEN_COMMAND_PALETTE_EVENT,
			{ detail },
		),
	);
}

const AREA_QUERY: Record<AppArea, string> = {
	chats: "s: ",
	spaces: "a: ",
	account: "c: ",
};

export function openAreaSearch(area: AppArea) {
	openCommandPalette({ query: AREA_QUERY[area] });
}
