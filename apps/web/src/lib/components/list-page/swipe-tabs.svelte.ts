export type SwipeTabPane = { scrollToTop(): void };

export class SwipeTabs {
	readonly panes: (SwipeTabPane | undefined)[] = [];
	#tracked = $state<number | null>(null);
	readonly #read: () => { index: number; enabled: boolean };

	constructor(read: () => { index: number; enabled: boolean }) {
		this.#read = read;
	}

	get index() {
		return this.#read().index;
	}

	get position() {
		const { index, enabled } = this.#read();
		return enabled ? (this.#tracked ?? index) : index;
	}

	get shown() {
		return Math.round(this.position);
	}

	readonly track = (position: number) => {
		this.#tracked = position;
	};

	scrollToTop() {
		this.panes[this.index]?.scrollToTop();
	}
}
