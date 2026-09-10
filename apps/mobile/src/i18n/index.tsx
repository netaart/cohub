import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  getDeviceLocale,
  isAppLocale,
  setActiveLocale,
  translate,
  type AppLocale,
  type LocalePreference,
  type Translate,
} from "./core";

export type { AppLocale, LocalePreference, Translate, TranslateParams, TranslationKey } from "./core";
export { getActiveLocale, getDeviceLocale, translate } from "./core";

const LOCALE_PREFERENCE_KEY = "cohub:mobile:locale:v1";

type LocaleContextValue = {
  locale: AppLocale;
  preference: LocalePreference;
  t: Translate;
  setPreference: (next: LocalePreference) => Promise<void>;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<LocalePreference>("system");

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(LOCALE_PREFERENCE_KEY)
      .then((value) => {
        if (!active || !isAppLocale(value)) return;
        setActiveLocale(value);
        setPreferenceState(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const setPreference = useCallback(async (next: LocalePreference) => {
    setActiveLocale(next);
    setPreferenceState(next);
    await AsyncStorage.setItem(LOCALE_PREFERENCE_KEY, next);
  }, []);

  const locale = preference === "system" ? getDeviceLocale() : preference;

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      preference,
      t: (key, params) => translate(key, params),
      setPreference,
    }),
    [locale, preference, setPreference],
  );
  // Keep non-hook `translate` calls synchronized before children render.
  setActiveLocale(preference);

  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  );
}

export function useTranslation(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) {
    throw new Error("useTranslation must be used within a LocaleProvider");
  }
  return value;
}
