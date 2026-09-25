function scrollParent(node: Element): Element | null {
	for (let el = node.parentElement; el; el = el.parentElement) {
		const { overflowY } = getComputedStyle(el);
		if (overflowY === "auto" || overflowY === "scroll") return el;
	}
	return null;
}

/**
 * Report whether `node` is within one viewport of its scroll container's
 * visible area. Observing the container itself (not the page viewport) keeps
 * the overscan margin working inside nested scroll panels.
 */
export function inScrollView(
	node: Element,
	onChange: (visible: boolean) => void,
) {
	let callback = onChange;
	if (typeof IntersectionObserver === "undefined") {
		callback(true);
		return {};
	}
	const observer = new IntersectionObserver(
		(entries) => {
			const entry = entries.at(-1);
			if (entry) callback(entry.isIntersecting);
		},
		{ root: scrollParent(node), rootMargin: "100% 0px" },
	);
	observer.observe(node);
	return {
		update(next: (visible: boolean) => void) {
			callback = next;
		},
		destroy() {
			observer.disconnect();
		},
	};
}
