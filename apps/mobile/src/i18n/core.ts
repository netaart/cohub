import { en, type TranslationKey } from "./en";
import { zh } from "./zh";

export type AppLocale = "en" | "zh";
export type LocalePreference = "system" | AppLocale;

export type TranslateParams = Record<string, string | number>;
export type Translate = (key: TranslationKey, params?: TranslateParams) => string;

const dictionaries: Record<AppLocale, Record<TranslationKey, string>> = {
  en,
  zh,
};

export function isAppLocale(value: string | null): value is AppLocale {
  return value === "en" || value === "zh";
}

function detectDeviceLocale(): AppLocale {
  try {
    const tag = Intl.DateTimeFormat().resolvedOptions().locale;
    return tag.toLowerCase().startsWith("zh") ? "zh" : "en";
  } catch {
    return "en";
  }
}

const deviceLocale = detectDeviceLocale();
let currentLocale: AppLocale = deviceLocale;

function interpolate(template: string, params?: TranslateParams) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** Translate using the active locale. Safe outside React and in Node-based checks. */
export function translate(key: TranslationKey, params?: TranslateParams): string {
  return interpolate(dictionaries[currentLocale][key], params);
}

export function getActiveLocale(): AppLocale {
  return currentLocale;
}

export function getDeviceLocale(): AppLocale {
  return deviceLocale;
}

export function setActiveLocale(preference: LocalePreference): AppLocale {
  currentLocale = preference === "system" ? deviceLocale : preference;
  return currentLocale;
}

export type { TranslationKey };
