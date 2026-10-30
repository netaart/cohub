const panels = new Set<HTMLElement>();
let owner: HTMLElement | null = null;

function follow(event: Event) {
	const target = event.target as Node;
	owner = [...panels].find((panel) => panel.contains(target)) ?? null;
}

export function registerBoardPanel(panel: HTMLElement) {
	if (panels.size === 0) {
		document.addEventListener("pointerdown", follow, true);
		document.addEventListener("focusin", follow, true);
	}
	panels.add(panel);
	return () => {
		panels.delete(panel);
		if (owner === panel) owner = null;
		if (panels.size > 0) return;
		document.removeEventListener("pointerdown", follow, true);
		document.removeEventListener("focusin", follow, true);
	};
}

export function boardReceivesKeys(panel: HTMLElement | null, waits: boolean) {
	return owner === null ? !waits : owner === panel;
}
