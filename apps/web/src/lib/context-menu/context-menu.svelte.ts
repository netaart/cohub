import { type MenuEntries, type MenuEntry, normalizeMenu } from "./menu.ts";

export type ContextMenuContent = { title?: string; items: MenuEntries };

export type ContextMenuSource = (
	target: HTMLElement,
) => ContextMenuContent | null;

export type ContextMenuRequest = {
	target: HTMLElement;
	source: ContextMenuSource;
	point?: { x: number; y: number } | null;
	sheet?: boolean;
};

export function readContextMenu(
	source: ContextMenuSource,
	target: HTMLElement,
): { title?: string; items: MenuEntry[] } | null {
	const content = source(target);
	if (!content) return null;
	const items = normalizeMenu(content.items);
	return items.length > 0 ? { title: content.title, items } : null;
}

const OPEN_ATTR = "data-context-open";

class ContextMenuController {
	current = $state.raw<ContextMenuRequest | null>(null);

	open(request: ContextMenuRequest) {
		this.close();
		request.target.setAttribute(OPEN_ATTR, "");
		if (request.target.hasAttribute("aria-haspopup"))
			request.target.setAttribute("aria-expanded", "true");
		this.current = request;
	}

	toggle(request: ContextMenuRequest) {
		if (this.current?.target === request.target) this.close();
		else this.open(request);
	}

	close(target?: HTMLElement) {
		const current = this.current;
		if (!current || (target && current.target !== target)) return;
		current.target.removeAttribute(OPEN_ATTR);
		if (current.target.hasAttribute("aria-haspopup"))
			current.target.setAttribute("aria-expanded", "false");
		this.current = null;
	}
}

export const contextMenu = new ContextMenuController();
