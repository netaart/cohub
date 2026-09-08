import AsyncStorage from "@react-native-async-storage/async-storage";
import { useColorScheme } from "react-native";
import { useEffect, useMemo, useState } from "react";

export type AppTheme = {
  mode: "light" | "dark";
  colors: {
    background: string;
    surface: string;
    surfaceRaised: string;
    surfacePressed: string;
    pressOverlay: string;
    border: string;
    borderStrong: string;
    text: string;
    textSecondary: string;
    textMuted: string;
    textFaint: string;
    accent: string;
    accentPressed: string;
    accentSoft: string;
    accentBorder: string;
    accentText: string;
    userBubble: string;
    userBubbleText: string;
    userBubbleMeta: string;
    assistantBubble: string;
    success: string;
    successSoft: string;
    warning: string;
    warningSoft: string;
    danger: string;
    dangerSoft: string;
    dangerText: string;
    info: string;
    infoSoft: string;
    shadow: string;
  };
  spacing: {
    xs: number;
    sm: number;
    md: number;
    lg: number;
    xl: number;
    xxl: number;
  };
  radius: {
    sm: number;
    md: number;
    lg: number;
    pill: number;
  };
};

const darkTheme: AppTheme = {
  mode: "dark",
  colors: {
    background: "#0f1114",
    surface: "#171a1f",
    surfaceRaised: "#22262e",
    surfacePressed: "#2b3039",
    pressOverlay: "rgba(255, 255, 255, 0.12)",
    border: "#2d333c",
    borderStrong: "#424a56",
    text: "#f7f8fa",
    textSecondary: "#d0d5dd",
    textMuted: "#a2aab6",
    textFaint: "#747e8c",
    accent: "#f08349",
    accentPressed: "#d96835",
    accentSoft: "#36251e",
    accentBorder: "#865038",
    accentText: "#2a150c",
    userBubble: "#c45d32",
    userBubbleText: "#fff6f0",
    userBubbleMeta: "rgba(255, 246, 240, 0.64)",
    assistantBubble: "#22262e",
    success: "#62c994",
    successSoft: "#1d3329",
    warning: "#e6b85c",
    warningSoft: "#382f1d",
    danger: "#e47d7d",
    dangerSoft: "#392123",
    dangerText: "#2a1515",
    info: "#83a9e8",
    infoSoft: "#202d42",
    shadow: "#000000",
  },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  radius: { sm: 8, md: 12, lg: 18, pill: 999 },
};

const pureBlackDarkTheme: AppTheme = {
  ...darkTheme,
  colors: {
    ...darkTheme.colors,
    background: "#000000",
    surface: "#070809",
    surfaceRaised: "#15171a",
    surfacePressed: "#23262b",
    border: "#25292f",
    borderStrong: "#3b424d",
    assistantBubble: "#15171a",
  },
};

const lightTheme: AppTheme = {
  mode: "light",
  colors: {
    background: "#f7f7f5",
    surface: "#ffffff",
    surfaceRaised: "#f0f1ef",
    surfacePressed: "#e6e8e5",
    pressOverlay: "rgba(29, 32, 36, 0.10)",
    border: "#e1e3df",
    borderStrong: "#c9cdc8",
    text: "#1d2024",
    textSecondary: "#4d535c",
    textMuted: "#59616b",
    textFaint: "#666f78",
    accent: "#b85427",
    accentPressed: "#98421c",
    accentSoft: "#fff0e8",
    accentBorder: "#e9b49a",
    accentText: "#ffffff",
    userBubble: "#b85427",
    userBubbleText: "#ffffff",
    userBubbleMeta: "rgba(255, 255, 255, 0.72)",
    assistantBubble: "#eceee9",
    success: "#238552",
    successSoft: "#e7f5ed",
    warning: "#986b12",
    warningSoft: "#fff5d9",
    danger: "#b34242",
    dangerSoft: "#fdeaea",
    dangerText: "#ffffff",
    info: "#416fae",
    infoSoft: "#eaf1fc",
    shadow: "#15202b",
  },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  radius: { sm: 8, md: 12, lg: 18, pill: 999 },
};

export type ThemePreference = "system" | "light" | "dark";

const THEME_PREFERENCE_KEY = "cohub:mobile:theme-preference:v1";
const PURE_BLACK_PREFERENCE_KEY = "cohub:mobile:pure-black:v1";
let themePreference: ThemePreference = "system";
let themePreferenceLoaded = false;
let themePreferenceLoad: Promise<void> | null = null;
const themePreferenceListeners = new Set<() => void>();
let pureBlackPreference = false;
let pureBlackPreferenceLoaded = false;
let pureBlackPreferenceLoad: Promise<void> | null = null;
const pureBlackPreferenceListeners = new Set<() => void>();

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function notifyThemePreferenceListeners() {
  for (const listener of themePreferenceListeners) listener();
}

function loadThemePreference() {
  if (themePreferenceLoad) return themePreferenceLoad;
  themePreferenceLoad = AsyncStorage.getItem(THEME_PREFERENCE_KEY)
    .then((value) => {
      if (!themePreferenceLoaded && isThemePreference(value)) themePreference = value;
      themePreferenceLoaded = true;
      notifyThemePreferenceListeners();
    })
    .catch(() => {
      themePreferenceLoaded = true;
    })
    .finally(() => {
      themePreferenceLoad = null;
    });
  return themePreferenceLoad;
}

export function getThemePreference(): ThemePreference {
  return themePreference;
}

export function useThemePreference(): ThemePreference {
  const [preference, setPreference] = useState(themePreference);
  useEffect(() => {
    const listener = () => setPreference(themePreference);
    themePreferenceListeners.add(listener);
    if (!themePreferenceLoaded) void loadThemePreference();
    listener();
    return () => {
      themePreferenceListeners.delete(listener);
    };
  }, []);
  return preference;
}

export async function setThemePreference(next: ThemePreference) {
  themePreference = next;
  themePreferenceLoaded = true;
  notifyThemePreferenceListeners();
  await AsyncStorage.setItem(THEME_PREFERENCE_KEY, next);
}

function notifyPureBlackPreferenceListeners() {
  for (const listener of pureBlackPreferenceListeners) listener();
}

function loadPureBlackPreference() {
  if (pureBlackPreferenceLoad) return pureBlackPreferenceLoad;
  pureBlackPreferenceLoad = AsyncStorage.getItem(PURE_BLACK_PREFERENCE_KEY)
    .then((value) => {
      if (!pureBlackPreferenceLoaded) pureBlackPreference = value === "true";
      pureBlackPreferenceLoaded = true;
      notifyPureBlackPreferenceListeners();
    })
    .catch(() => {
      pureBlackPreferenceLoaded = true;
    })
    .finally(() => {
      pureBlackPreferenceLoad = null;
    });
  return pureBlackPreferenceLoad;
}

export function getPureBlackPreference() {
  return pureBlackPreference;
}

export function usePureBlackPreference() {
  const [enabled, setEnabled] = useState(pureBlackPreference);
  useEffect(() => {
    const listener = () => setEnabled(pureBlackPreference);
    pureBlackPreferenceListeners.add(listener);
    if (!pureBlackPreferenceLoaded) void loadPureBlackPreference();
    listener();
    return () => {
      pureBlackPreferenceListeners.delete(listener);
    };
  }, []);
  return enabled;
}

export async function setPureBlackPreference(next: boolean) {
  pureBlackPreference = next;
  pureBlackPreferenceLoaded = true;
  notifyPureBlackPreferenceListeners();
  await AsyncStorage.setItem(PURE_BLACK_PREFERENCE_KEY, String(next));
}

export function useAppTheme(): AppTheme {
  const colorScheme = useColorScheme();
  const preference = useThemePreference();
  const pureBlack = usePureBlackPreference();
  const fontScale = useFontScalePreference();
  const mode = preference === "system"
    ? colorScheme === "light" ? "light" : "dark"
    : preference;
  const base = mode === "light" ? lightTheme : pureBlack ? pureBlackDarkTheme : darkTheme;
  // A new theme identity re-renders themed components so they pick up the scaled typography tokens.
  return useMemo(() => (fontScale === "default" ? base : { ...base }), [base, fontScale]);
}

export type FontScalePreference = "small" | "default" | "large" | "xlarge";

export const FONT_SCALE_VALUES: Record<FontScalePreference, number> = {
  small: 0.9,
  default: 1,
  large: 1.12,
  xlarge: 1.25,
};

const FONT_SCALE_PREFERENCE_KEY = "cohub:mobile:font-scale:v1";
let fontScalePreference: FontScalePreference = "default";
let fontScalePreferenceLoaded = false;
let fontScalePreferenceLoad: Promise<void> | null = null;
const fontScalePreferenceListeners = new Set<() => void>();

function isFontScalePreference(value: string | null): value is FontScalePreference {
  return value === "small" || value === "default" || value === "large" || value === "xlarge";
}

function notifyFontScalePreferenceListeners() {
  for (const listener of fontScalePreferenceListeners) listener();
}

function loadFontScalePreference() {
  if (fontScalePreferenceLoad) return fontScalePreferenceLoad;
  fontScalePreferenceLoad = AsyncStorage.getItem(FONT_SCALE_PREFERENCE_KEY)
    .then((value) => {
      if (!fontScalePreferenceLoaded && isFontScalePreference(value)) {
        fontScalePreference = value;
        applyFontScale(FONT_SCALE_VALUES[value]);
      }
      fontScalePreferenceLoaded = true;
      notifyFontScalePreferenceListeners();
    })
    .catch(() => {
      fontScalePreferenceLoaded = true;
    })
    .finally(() => {
      fontScalePreferenceLoad = null;
    });
  return fontScalePreferenceLoad;
}

export function getFontScalePreference(): FontScalePreference {
  return fontScalePreference;
}

export function useFontScalePreference(): FontScalePreference {
  const [preference, setPreference] = useState(fontScalePreference);
  useEffect(() => {
    const listener = () => setPreference(fontScalePreference);
    fontScalePreferenceListeners.add(listener);
    if (!fontScalePreferenceLoaded) void loadFontScalePreference();
    listener();
    return () => {
      fontScalePreferenceListeners.delete(listener);
    };
  }, []);
  return preference;
}

export async function setFontScalePreference(next: FontScalePreference) {
  fontScalePreference = next;
  fontScalePreferenceLoaded = true;
  applyFontScale(FONT_SCALE_VALUES[next]);
  notifyFontScalePreferenceListeners();
  await AsyncStorage.setItem(FONT_SCALE_PREFERENCE_KEY, next);
}

export type TypographyToken =
  | "display"
  | "title"
  | "heading"
  | "body"
  | "bodyMedium"
  | "chatBody"
  | "caption"
  | "eyebrow"
  | "micro"
  | "code";

type TypographyStyle = {
  fontSize: number;
  lineHeight: number;
  fontWeight: "400" | "500" | "600" | "700";
  letterSpacing?: number;
};

const BASE_TYPOGRAPHY: Record<TypographyToken, TypographyStyle> = {
  display: { fontSize: 30, lineHeight: 36, fontWeight: "700" },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700" },
  heading: { fontSize: 17, lineHeight: 22, fontWeight: "700" },
  body: { fontSize: 15, lineHeight: 22, fontWeight: "400" },
  bodyMedium: { fontSize: 15, lineHeight: 22, fontWeight: "600" },
  chatBody: { fontSize: 15, lineHeight: 23, fontWeight: "400" },
  caption: { fontSize: 12, lineHeight: 17, fontWeight: "500" },
  eyebrow: { fontSize: 11, lineHeight: 14, fontWeight: "600", letterSpacing: 0.88 },
  micro: { fontSize: 10, lineHeight: 14, fontWeight: "600" },
  code: { fontSize: 12, lineHeight: 19, fontWeight: "400" },
};

/** Mutable tokens: components read them at render time, so a scale change re-renders with new metrics. */
export const typography: Record<TypographyToken, TypographyStyle> = { ...BASE_TYPOGRAPHY };

function applyFontScale(scale: number) {
  for (const token of Object.keys(BASE_TYPOGRAPHY) as TypographyToken[]) {
    const base = BASE_TYPOGRAPHY[token];
    typography[token] = {
      ...base,
      fontSize: Math.round(base.fontSize * scale * 2) / 2,
      lineHeight: Math.round(base.lineHeight * scale),
      ...(base.letterSpacing === undefined ? null : { letterSpacing: Math.round(base.letterSpacing * scale * 100) / 100 }),
    };
  }
}

export function getFontScale() {
  return FONT_SCALE_VALUES[fontScalePreference];
}

export function scaleFontSize(size: number) {
  return Math.round(size * getFontScale() * 2) / 2;
}

export function scaleLineHeight(size: number) {
  return Math.round(size * getFontScale());
}
