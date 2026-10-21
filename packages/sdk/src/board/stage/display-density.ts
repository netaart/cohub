export function observeDisplayDensity(window: Window, onChange: () => void): () => void {
	let query: MediaQueryList;
	let density = window.devicePixelRatio || 1;
	function watch() {
		query = window.matchMedia(`(resolution: ${density}dppx)`);
		query.addEventListener("change", changed);
	}
	function changed() {
		const next = window.devicePixelRatio || 1;
		if (density === next) return;
		density = next;
		query.removeEventListener("change", changed);
		watch();
		onChange();
	}
	watch();
	window.addEventListener("resize", changed);
	return () => {
		query.removeEventListener("change", changed);
		window.removeEventListener("resize", changed);
	};
}
