// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	const __COHUB_BUILD__: { release: string | null; commit: string | null };

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
			commandPalette?: import("#lib/command-palette/open.ts").CommandPaletteHistoryEntry;
		}
		// interface Platform {}
	}
}

export {};
