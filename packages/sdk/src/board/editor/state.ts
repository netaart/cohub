export type BoardEditorChannel =
	| "document"
	| "scene"
	| "selection"
	| "camera"
	| "tool"
	| "interaction"
	| "hover"
	| "editing"
	| "playback"
	| "history"
	| "status";

export type BoardEditorListener = () => void;

export type BoardEditorChannels = {
	emit(channel: BoardEditorChannel): void;
	subscribe(
		channels: BoardEditorChannel | readonly BoardEditorChannel[],
		listener: BoardEditorListener,
	): () => void;
};

export function createChannels(): BoardEditorChannels {
	const listeners = new Map<BoardEditorChannel, Set<BoardEditorListener>>();
	return {
		emit(channel) {
			const subscribed = listeners.get(channel);
			if (subscribed) for (const listener of [...subscribed]) listener();
		},
		subscribe(channels, listener) {
			const list = typeof channels === "string" ? [channels] : channels;
			for (const channel of list) {
				const set = listeners.get(channel) ?? new Set();
				set.add(listener);
				listeners.set(channel, set);
			}
			return () => {
				for (const channel of list) listeners.get(channel)?.delete(listener);
			};
		},
	};
}

export function observable<T extends Record<string, unknown>>(
	initial: T,
	channelOf: { readonly [K in keyof T]: BoardEditorChannel },
	channels: BoardEditorChannels,
): T {
	const values = { ...initial };
	const state = {} as T;
	for (const key of Object.keys(initial) as Array<keyof T>) {
		Object.defineProperty(state, key, {
			enumerable: true,
			get: () => values[key],
			set: (value: T[typeof key]) => {
				if (Object.is(values[key], value)) return;
				values[key] = value;
				channels.emit(channelOf[key]);
			},
		});
	}
	return state;
}

export function memo<const D extends readonly unknown[], R>(
	inputs: () => D,
	compute: (...inputs: D) => R,
): () => R {
	let previous: D | null = null;
	let value: R;
	return () => {
		const next = inputs();
		if (
			previous === null ||
			next.length !== previous.length ||
			next.some((input, index) => !Object.is(input, previous?.[index]))
		) {
			previous = next;
			value = compute(...next);
		}
		return value;
	};
}
