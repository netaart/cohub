import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";
import type { CommandPaletteLens } from "./lens";

export function commandLensLabel(lens: CommandPaletteLens, locale: Locale) {
	const options = { locale };
	switch (lens) {
		case "all":
			return m.command_lens_all({}, options);
		case "space":
			return m.command_lens_space({}, options);
		case "session":
			return m.command_lens_session({}, options);
		case "turn":
			return m.command_lens_turn({}, options);
		case "label":
			return m.command_lens_label({}, options);
		case "command":
			return m.command_lens_command({}, options);
	}
}

export function commandLensPlaceholder(
	lens: CommandPaletteLens,
	locale: Locale,
) {
	const options = { locale };
	switch (lens) {
		case "all":
			return m.command_placeholder({}, options);
		case "space":
			return m.command_placeholder_space({}, options);
		case "session":
			return m.command_placeholder_session({}, options);
		case "turn":
			return m.command_placeholder_turn({}, options);
		case "label":
			return m.command_placeholder_label({}, options);
		case "command":
			return m.command_placeholder_command({}, options);
	}
}
