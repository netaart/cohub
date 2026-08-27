import { Platform, useColorScheme } from "react-native";

export type AppTheme = {
  mode: "light" | "dark";
  colors: {
    background: string;
    surface: string;
    surfaceRaised: string;
    surfacePressed: string;
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
    background: "#111317",
    surface: "#191c22",
    surfaceRaised: "#22262e",
    surfacePressed: "#2b3039",
    border: "#2b3038",
    borderStrong: "#3a414c",
    text: "#f3f4f6",
    textSecondary: "#c3c8d1",
    textMuted: "#9299a6",
    textFaint: "#68707d",
    accent: "#e87942",
    accentPressed: "#cc6030",
    accentSoft: "#33231d",
    accentBorder: "#77432d",
    accentText: "#fff4ed",
    success: "#62c994",
    successSoft: "#1d3329",
    warning: "#e6b85c",
    warningSoft: "#382f1d",
    danger: "#e47d7d",
    dangerSoft: "#392123",
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
    border: "#e1e3df",
    borderStrong: "#c9cdc8",
    text: "#1d2024",
    textSecondary: "#4d535c",
    textMuted: "#757c86",
    textFaint: "#9aa1a8",
    accent: "#c85f2d",
    accentPressed: "#aa4c20",
    accentSoft: "#fff0e8",
    accentBorder: "#e9b49a",
    accentText: "#35170d",
    success: "#238552",
    successSoft: "#e7f5ed",
    warning: "#986b12",
    warningSoft: "#fff5d9",
    danger: "#b34242",
    dangerSoft: "#fdeaea",
    info: "#416fae",
    infoSoft: "#eaf1fc",
    shadow: "#15202b",
  },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  radius: { sm: 8, md: 12, lg: 18, pill: 999 },
};

export function useAppTheme(): AppTheme {
  const colorScheme = useColorScheme();
  if (Platform.OS === "web") return lightTheme;
  return colorScheme === "light" ? lightTheme : darkTheme;
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
