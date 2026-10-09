const TEXT_EDITING =
	"input, textarea, select, [contenteditable]:not([contenteditable='false'])";

export function isTextEditingTarget(target: EventTarget | null): boolean {
	return target instanceof Element && Boolean(target.closest(TEXT_EDITING));
}

export function canScrollHorizontally(
	target: EventTarget | null,
	root: Element,
	dx: number,
): boolean {
	let element = target instanceof Element ? target : null;
	for (; element && element !== root; element = element.parentElement) {
		const max = element.scrollWidth - element.clientWidth;
		if (max <= 1) continue;
		const { overflowX } = getComputedStyle(element);
		if (overflowX !== "auto" && overflowX !== "scroll") continue;
		const left = element.scrollLeft;
		if (dx < 0 ? left < max - 1 : left > 1) return true;
	}
	return false;
}
