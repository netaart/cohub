import type { UserAppFilter, UserCronJobFilter } from "@neta-art/cohub";
import type { Locale } from "$lib/i18n/locale";
import type { LibraryEntity } from "$lib/library-routes";
import { m } from "$lib/paraglide/messages.js";

export function libraryEntityLabel(entity: LibraryEntity, locale: Locale) {
	switch (entity) {
		case "spaces":
			return m.library_spaces({}, { locale });
		case "apps":
			return m.library_apps({}, { locale });
		case "scheduled":
			return m.library_scheduled({}, { locale });
	}
}

export function appFilterLabel(filter: UserAppFilter, locale: Locale) {
	switch (filter) {
		case "mine":
			return m.library_apps_filter_mine({}, { locale });
		case "all":
			return m.library_apps_filter_all({}, { locale });
		case "disabled":
			return m.library_apps_filter_disabled({}, { locale });
	}
}

export function cronJobFilterLabel(filter: UserCronJobFilter, locale: Locale) {
	switch (filter) {
		case "mine":
			return m.library_cron_filter_mine({}, { locale });
		case "all":
			return m.library_cron_filter_all({}, { locale });
		case "paused":
			return m.library_cron_filter_paused({}, { locale });
		case "attention":
			return m.library_cron_filter_attention({}, { locale });
	}
}
