/** Call once when the node first nears the viewport. */
export function nearViewport(
	node: Element,
	onEnter: () => void,
	rootMargin = "200px",
) {
	if (typeof IntersectionObserver === "undefined") {
		onEnter();
		return {};
	}
	const observer = new IntersectionObserver(
		(entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) return;
			observer.disconnect();
			onEnter();
		},
		{ rootMargin },
	);
	observer.observe(node);
	return {
		destroy() {
			observer.disconnect();
		},
	};
}
