// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	interface Window {
		cohubDisableVConsole?: () => void;
		cohubEnableVConsole?: () => Promise<void>;
	}

	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		interface PageState {
			workspacePreview?: string | null;
			commandPalette?: import("$lib/command-palette/open").CommandPaletteHistoryEntry;
		}
		// interface Platform {}
	}
}

declare module "$env/static/public" {
	export const PUBLIC_PREVIEW_ORIGIN: string | undefined;
	export const PUBLIC_MARKETPLACE_APP_ID: string | undefined;
}

export {};
