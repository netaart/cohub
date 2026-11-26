import geist from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url";
import geistMono from "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?url";
import type { BoardScriptFont } from "@neta-art/cohub/board/render";

const FONTS = [
	["Geist", geist],
	["Geist Mono", geistMono],
] as const;

let loading: Promise<readonly BoardScriptFont[]> | null = null;

export function boardScriptFonts(): Promise<readonly BoardScriptFont[]> {
	loading ??= Promise.all(
		FONTS.map(async ([family, url]) => {
			const response = await fetch(url);
			if (!response.ok) throw new Error(`${family} could not be loaded.`);
			return { family, data: await response.arrayBuffer() };
		}),
	);
	loading.catch(() => {
		loading = null;
	});
	return loading;
}
