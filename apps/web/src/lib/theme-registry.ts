export const THEME_STORAGE_KEY = "cohub-theme";

export const RESOLVED_THEMES = [
	"dark",
	"light",
	"solarized-dark",
	"solarized-light",
	"neta-studio",
	"neta-pixel",
	"neta-pixel-dark",
] as const;

export type ResolvedTheme = (typeof RESOLVED_THEMES)[number];
export type ThemeMode = ResolvedTheme | "system";

export type ThemeMetadata = {
	value: ResolvedTheme;
	label: string;
	description: string;
	/**
	 * sRGB hex of the theme's `--bg-primary`. Feeds `<meta theme-color>` and
	 * the manifest; must stay in sync with `styles/themes/*.css` and the inline
	 * FOUC script in `app.html` (covered by `tests/theme-chrome-color.test.ts`).
	 */
	themeColor: string;
	isDark: boolean;
	shikiTheme:
		| "github-dark"
		| "github-light"
		| "solarized-dark"
		| "solarized-light";
	mermaidVariables: Record<string, string>;
};

export type ThemeOption = {
	value: ThemeMode;
	label: string;
	description: string;
};

export const THEME_REGISTRY = {
	dark: {
		value: "dark",
		label: "Dark",
		description: "Always use the default dark theme",
		themeColor: "#101213",
		isDark: true,
		shikiTheme: "github-dark",
		mermaidVariables: {
			lineColor: "#5A5B66",
			primaryColor: "#33343B",
			primaryTextColor: "#ECEEF2",
			secondaryColor: "#3F4048",
			tertiaryColor: "#4E4F59",
		},
	},
	light: {
		value: "light",
		label: "Light",
		description: "Always use the default light theme",
		themeColor: "#FFFFFF",
		isDark: false,
		shikiTheme: "github-light",
		mermaidVariables: {
			lineColor: "#D0D1D7",
			primaryColor: "#F2F2F5",
			primaryTextColor: "#22232A",
			secondaryColor: "#E8E8EC",
			tertiaryColor: "#FFFFFF",
		},
	},
	"solarized-dark": {
		value: "solarized-dark",
		label: "Solarized Dark",
		description: "A calm low-contrast dark theme for long sessions",
		themeColor: "#011415",
		isDark: true,
		shikiTheme: "solarized-dark",
		mermaidVariables: {
			lineColor: "#4E6770",
			primaryColor: "#12343D",
			primaryTextColor: "#F3E9C5",
			secondaryColor: "#173F49",
			tertiaryColor: "#214A53",
		},
	},
	"solarized-light": {
		value: "solarized-light",
		label: "Solarized Light",
		description: "A warm light theme tuned for reading and code",
		themeColor: "#FFFADE",
		isDark: false,
		shikiTheme: "solarized-light",
		mermaidVariables: {
			lineColor: "#D9CC9E",
			primaryColor: "#F6EFCF",
			primaryTextColor: "#3A3524",
			secondaryColor: "#EFE4BC",
			tertiaryColor: "#FDF6E3",
		},
	},
	"neta-studio": {
		value: "neta-studio",
		label: "Neta Studio",
		description: "A graphite studio theme with cream ink and teal accents",
		themeColor: "#050605",
		isDark: true,
		shikiTheme: "github-dark",
		mermaidVariables: {
			lineColor: "#3A3836",
			primaryColor: "#1A191A",
			primaryTextColor: "#F8F1E5",
			secondaryColor: "#252325",
			tertiaryColor: "#131216",
		},
	},
	"neta-pixel": {
		value: "neta-pixel",
		label: "Neta Pixel",
		description: "Ink pixel keys, soft grays and cyan sparks",
		themeColor: "#FFFFFF",
		isDark: false,
		shikiTheme: "github-light",
		mermaidVariables: {
			lineColor: "#B9B9BA",
			primaryColor: "#F6F6F6",
			primaryTextColor: "#161718",
			secondaryColor: "#ECECED",
			tertiaryColor: "#FFFFFF",
		},
	},
	"neta-pixel-dark": {
		value: "neta-pixel-dark",
		label: "Neta Pixel Dark",
		description: "Neta Pixel on Ink, with white pixel keys",
		themeColor: "#0B0C0D",
		isDark: true,
		shikiTheme: "github-dark",
		mermaidVariables: {
			lineColor: "#3A3C40",
			primaryColor: "#242527",
			primaryTextColor: "#F6F6F6",
			secondaryColor: "#1C1D1F",
			tertiaryColor: "#161718",
		},
	},
} satisfies Record<ResolvedTheme, ThemeMetadata>;

export const THEME_OPTIONS: ThemeOption[] = [
	...RESOLVED_THEMES.map((theme) => ({
		value: theme,
		label: THEME_REGISTRY[theme].label,
		description: THEME_REGISTRY[theme].description,
	})),
	{
		value: "system",
		label: "System",
		description: "Follow your system preference",
	},
];

export const THEME_COLOR: Record<ResolvedTheme, string> = Object.fromEntries(
	RESOLVED_THEMES.map((theme) => [theme, THEME_REGISTRY[theme].themeColor]),
) as Record<ResolvedTheme, string>;

export function isResolvedTheme(value: string | null): value is ResolvedTheme {
	return RESOLVED_THEMES.includes(value as ResolvedTheme);
}

export function isThemeMode(value: string | null): value is ThemeMode {
	return value === "system" || isResolvedTheme(value);
}

export function isDarkTheme(theme: ResolvedTheme): boolean {
	return THEME_REGISTRY[theme].isDark;
}

export function getSystemTheme(): ResolvedTheme {
	if (typeof window === "undefined") return "dark";
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

export function resolveThemeMode(mode: ThemeMode): ResolvedTheme {
	return mode === "system" ? getSystemTheme() : mode;
}
