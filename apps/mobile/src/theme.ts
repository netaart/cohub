import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform, useColorScheme } from "react-native";
import { useEffect, useState } from "react";

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
let themePreference: ThemePreference = "system";
let themePreferenceLoaded = false;
let themePreferenceLoad: Promise<void> | null = null;
const themePreferenceListeners = new Set<() => void>();

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

export function useAppTheme(): AppTheme {
  const colorScheme = useColorScheme();
  const preference = useThemePreference();
  if (Platform.OS === "web") return lightTheme;
  const mode = preference === "system"
    ? colorScheme === "light" ? "light" : "dark"
    : preference;
  return mode === "light" ? lightTheme : darkTheme;
}

export const typography = {
  display: { fontSize: 30, lineHeight: 36, fontWeight: "700" as const },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700" as const },
  heading: { fontSize: 17, lineHeight: 22, fontWeight: "700" as const },
  body: { fontSize: 15, lineHeight: 22, fontWeight: "400" as const },
  bodyMedium: { fontSize: 15, lineHeight: 22, fontWeight: "600" as const },
  caption: { fontSize: 12, lineHeight: 17, fontWeight: "500" as const },
  micro: { fontSize: 10, lineHeight: 14, fontWeight: "600" as const },
};
