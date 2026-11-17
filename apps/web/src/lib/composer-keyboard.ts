import { getCurrentDeviceType } from "#lib/device-detection.ts";
import { isComposingKeyboardEvent } from "#lib/keyboard.ts";

export type ComposerKeyAction = "none" | "newline" | "submit";

type ComposerKeyboardEvent = Pick<
	KeyboardEvent,
	"ctrlKey" | "isComposing" | "key" | "keyCode" | "metaKey" | "shiftKey"
>;

export function getComposerKeyAction(
	event: ComposerKeyboardEvent,
	options: { mobile: boolean },
): ComposerKeyAction {
	if (event.key !== "Enter" || isComposingKeyboardEvent(event)) return "none";
	if (event.metaKey || event.ctrlKey) return "submit";
	if (event.shiftKey || options.mobile) return "newline";
	return "submit";
}

export function isMobileComposerInput(): boolean {
	// Tablets use the mobile composer layout; touch-enabled desktops remain desktop.
	const deviceType = getCurrentDeviceType();
	return deviceType === "mobile" || deviceType === "tablet";
}
