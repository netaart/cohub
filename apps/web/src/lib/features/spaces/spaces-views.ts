import { Archive, Clock, LayoutGrid, Pin, UserRound } from "lucide-svelte";
import type { SpacesFilter } from "$lib/features/spaces/spaces-filter";
import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";

export const SPACES_FILTER_ICONS = {
	recent: Clock,
	all: LayoutGrid,
	mine: UserRound,
	pinned: Pin,
	archived: Archive,
} as const satisfies Record<SpacesFilter, typeof Clock>;

export function spacesFilterLabel(filter: SpacesFilter, locale: Locale) {
	switch (filter) {
		case "recent":
			return m.spaces_section_recent({}, { locale });
		case "all":
			return m.spaces_section_all({}, { locale });
		case "mine":
			return m.command_mine({}, { locale });
		case "pinned":
			return m.spaces_section_pinned({}, { locale });
		case "archived":
			return m.spaces_archived({}, { locale });
	}
}
