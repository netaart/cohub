export type DisplayTab = { display: string };

type DisplayWindowControllerOptions = {
	onOpenPanel?: () => void;
	onClosePanel?: () => void;
	onDisplayClosed?: (display: string) => void;
};

export function createDisplayWindowController(
	options: DisplayWindowControllerOptions = {},
) {
	let tabs = $state<DisplayTab[]>([]);
	let active = $state<string | null>(null);

	function open(display: string) {
		if (!tabs.some((tab) => tab.display === display))
			tabs = [...tabs, { display }];
		active = display;
		options.onOpenPanel?.();
	}

	function activate(display: string) {
		if (!tabs.some((tab) => tab.display === display)) return;
		active = display;
		options.onOpenPanel?.();
	}

	function close(display = active) {
		if (!display) return;
		const index = tabs.findIndex((tab) => tab.display === display);
		if (index < 0) return;
		const next = tabs.filter((tab) => tab.display !== display);
		tabs = next;
		if (active === display)
			active = next[Math.max(0, index - 1)]?.display ?? null;
		if (next.length === 0) options.onClosePanel?.();
		options.onDisplayClosed?.(display);
	}

	function closeAll() {
		for (const tab of [...tabs]) close(tab.display);
	}

	return {
		get tabs() {
			return tabs;
		},
		get active() {
			return active;
		},
		open,
		activate,
		close,
		closeAll,
	};
}
