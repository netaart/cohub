import { syncHostLocale } from "#lib/host-bridge.ts";
import { setLocale as setParaglideLocale } from "#lib/paraglide/runtime.js";
import {
	isLocalePreference,
	LOCALE_STORAGE_KEY,
	type Locale,
	type LocalePreference,
	resolvePreferredLocale,
} from "./locale.ts";
import { isPublicLocalePath } from "./public-locale.ts";

function browserLanguages(): readonly string[] {
	return typeof navigator === "undefined" ? [] : navigator.languages;
}

function readPreference(): LocalePreference {
	if (typeof localStorage === "undefined") return "system";
	try {
		const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
		return isLocalePreference(stored) ? stored : "system";
	} catch {
		return "system";
	}
}

const initialPreference = readPreference();
const initialLocale = resolvePreferredLocale(
	initialPreference,
	browserLanguages(),
);
let preference = $state<LocalePreference>(initialPreference);
let locale = $state<Locale>(initialLocale);

function applyLocale(nextLocale: Locale) {
	locale = nextLocale;
	void setParaglideLocale(nextLocale, { reload: false });
	syncHostLocale(preference === "system" ? null : preference);
	if (typeof document !== "undefined") {
		// Public pages derive lang from the URL (set by SSR); don't let the app
		// shell preference override it on those pages (hydration consistency).
		if (!isPublicLocalePath(window.location.pathname)) {
			document.documentElement.lang = nextLocale;
		}
		document.documentElement.dir = "ltr";
	}
}

export function getLocalePreference(): LocalePreference {
	return preference;
}

export function getLocale(): Locale {
	return locale;
}

export function setLocalePreference(nextPreference: LocalePreference) {
	preference = nextPreference;
	try {
		localStorage.setItem(LOCALE_STORAGE_KEY, nextPreference);
	} catch {
		// A storage policy must not prevent an in-memory language change.
	}
	applyLocale(resolvePreferredLocale(nextPreference, browserLanguages()));
}

if (typeof window !== "undefined") {
	applyLocale(initialLocale);
	window.addEventListener("languagechange", () => {
		if (preference === "system") {
			applyLocale(resolvePreferredLocale("system", browserLanguages()));
		}
	});
	window.addEventListener("storage", (event) => {
		if (event.key !== LOCALE_STORAGE_KEY) return;
		const nextPreference = isLocalePreference(event.newValue)
			? event.newValue
			: "system";
		preference = nextPreference;
		applyLocale(resolvePreferredLocale(nextPreference, browserLanguages()));
	});
}
