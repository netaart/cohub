const EVENT = "cohub:list-scroll-top";

export function requestListScrollTop() {
	window.dispatchEvent(new CustomEvent(EVENT));
}

export function onListScrollTop(handler: () => void) {
	window.addEventListener(EVENT, handler);
	return () => window.removeEventListener(EVENT, handler);
}

export function scrollListToTop(element: HTMLElement | null) {
	if (!element || element.scrollTop === 0) return;
	const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	element.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
}
