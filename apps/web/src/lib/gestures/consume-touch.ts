export function consumeTouchMoves() {
	const block = (event: TouchEvent) => {
		event.stopPropagation();
		if (event.cancelable) event.preventDefault();
	};
	const release = () => {
		window.removeEventListener("touchmove", block, true);
		window.removeEventListener("touchend", release, true);
		window.removeEventListener("touchcancel", release, true);
	};
	window.addEventListener("touchmove", block, {
		capture: true,
		passive: false,
	});
	window.addEventListener("touchend", release, true);
	window.addEventListener("touchcancel", release, true);
	return release;
}
