import { APPROVAL_MODES, type ApprovalMode } from "@cohub/protocol/runtime";

/** Every mode is listed; one the Runtime does not enforce stays disabled, except `inherit`. */
export const approvalMenuOptions = (
	offered: readonly ApprovalMode[],
	selected: ApprovalMode,
) =>
	APPROVAL_MODES.map((mode) => ({
		mode,
		checked: mode === selected,
		disabled: mode !== "inherit" && !offered.includes(mode),
	}));

export type HarnessMenuKeyAction =
	| "move"
	| "open-submenu"
	| "back"
	| "close"
	| "dismiss"
	| null;

/**
 * Keyboard path of the Harness menu and its approval submenu: ArrowRight opens the submenu from its
 * row (Enter clicks it), ArrowLeft or Escape goes back to that row, Escape then closes the menu, and
 * Tab closes both without taking focus back.
 */
export function harnessMenuKey(
	key: string,
	at: "menu" | "submenu-row" | "submenu",
): HarnessMenuKeyAction {
	if (key === "Tab") return "dismiss";
	if (["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return "move";
	if (at === "submenu")
		return key === "ArrowLeft" || key === "Escape" ? "back" : null;
	if (key === "Escape") return "close";
	return at === "submenu-row" && key === "ArrowRight" ? "open-submenu" : null;
}

/** The item a move key lands on, wrapping around. */
export function movedIndex(key: string, index: number, length: number) {
	if (key === "Home") return 0;
	if (key === "End" || (index < 0 && key === "ArrowUp")) return length - 1;
	return (index + (key === "ArrowDown" ? 1 : -1) + length) % length;
}
