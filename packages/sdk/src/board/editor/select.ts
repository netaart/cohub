import type { BoardEditor } from "./editor.js";
import type { BoardEditorChannel } from "./state.js";

export type BoardEditorSelection<T> = {
	subscribe(listener: () => void): () => void;
	getSnapshot(): T;
};

export function selectBoardEditor<T>(
	editor: BoardEditor,
	selector: (editor: BoardEditor) => T,
	isEqual: (a: T, b: T) => boolean = Object.is,
): BoardEditorSelection<T> {
	const listeners = new Set<() => void>();
	let cached: { value: T } | null = null;
	let channels: readonly BoardEditorChannel[] = [];
	let stale = true;
	let stop: (() => void) | null = null;

	const changed = () => {
		stale = true;
		for (const listener of [...listeners]) listener();
	};

	function watch() {
		stop?.();
		stop = editor.subscribe(channels, changed);
	}

	return {
		getSnapshot() {
			if (cached && !stale && stop) return cached.value;
			const read = editor.collect(() => selector(editor));
			stale = false;
			if (read.channels.size !== channels.length || channels.some((channel) => !read.channels.has(channel))) {
				channels = [...read.channels];
				if (stop) watch();
			}
			if (!cached || !isEqual(cached.value, read.value)) cached = { value: read.value };
			return cached.value;
		},
		subscribe(listener) {
			listeners.add(listener);
			if (!stop) {
				stale = true;
				watch();
			}
			return () => {
				listeners.delete(listener);
				if (listeners.size > 0 || !stop) return;
				stop();
				stop = null;
			};
		},
	};
}

export function shallowEqual<T>(a: T, b: T): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = Object.keys(left);
	return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && Object.is(left[key], right[key]));
}
