import type { AppArea } from "$lib/mobile-nav";
import type { CommandPaletteLens } from "./lens";

export type CommandPaletteIntent = "navigate" | "new-chat";

export type OpenCommandPaletteDetail = {
	lens?: CommandPaletteLens;
	query?: string;
	intent?: CommandPaletteIntent;
};

export type CommandPaletteHistoryEntry = Required<OpenCommandPaletteDetail>;

export const OPEN_COMMAND_PALETTE_EVENT = "cohub:open-command-palette";

export function openCommandPalette(detail?: OpenCommandPaletteDetail) {
	window.dispatchEvent(
		new CustomEvent<OpenCommandPaletteDetail | undefined>(
			OPEN_COMMAND_PALETTE_EVENT,
			{ detail },
		),
	);
}

const AREA_LENS: Record<AppArea, CommandPaletteLens> = {
	chats: "session",
	spaces: "space",
	account: "command",
};

export function openAreaSearch(area: AppArea) {
	openCommandPalette({ lens: AREA_LENS[area] });
}
