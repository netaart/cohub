const offsets = new Map<string, number>();

export type ScrollMemoryOptions = {
	key: string;
	ready: boolean;
};

export function scrollMemory(node: HTMLElement, initial: ScrollMemoryOptions) {
	let options = initial;
	let restored = false;

	function restore() {
		if (restored || !options.ready) return;
		restored = true;
		node.scrollTop = offsets.get(options.key) ?? 0;
	}

	function save() {
		offsets.set(options.key, node.scrollTop);
	}

	restore();
	node.addEventListener("scroll", save, { passive: true });
	return {
		update(next: ScrollMemoryOptions) {
			if (next.key !== options.key) restored = false;
			options = next;
			restore();
		},
		destroy() {
			node.removeEventListener("scroll", save);
		},
	};
}
