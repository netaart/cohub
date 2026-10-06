import {
	callHost,
	onHostEvent,
	readyHost,
	supportsHostCapability,
} from "$lib/host-bridge";

/** Layers that the native host's system back closes, topmost first. */
const layers: Array<() => void> = [];
let intercepting = false;
let listening = false;
let awaitingHost = false;

function sync() {
	if (!supportsHostCapability("navigation.back")) {
		if (!awaitingHost) {
			awaitingHost = true;
			void readyHost().then(sync);
		}
		return;
	}
	if (!listening) {
		listening = true;
		onHostEvent((event) => {
			if (event.name === "navigation.back") layers.at(-1)?.();
		});
	}
	const wanted = layers.length > 0;
	if (wanted === intercepting) return;
	intercepting = wanted;
	callHost("navigation.interceptBack", { enabled: wanted }).catch(() => {
		if (intercepting === wanted) intercepting = !wanted;
	});
}

export function pushBackLayer(close: () => void): () => void {
	const layer = () => close();
	layers.push(layer);
	sync();
	return () => {
		const index = layers.lastIndexOf(layer);
		if (index === -1) return;
		layers.splice(index, 1);
		sync();
	};
}

/** While `isOpen()`, system back calls `close`. */
export function dismissOnBack(isOpen: () => boolean, close: () => void) {
	$effect(() => {
		if (!isOpen()) return;
		return pushBackLayer(close);
	});
}
