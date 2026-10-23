function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function shallowEqual(
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	nested: boolean,
): boolean {
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every((key) => {
		if (!Object.hasOwn(b, key)) return false;
		const left = a[key];
		const right = b[key];
		if (left === right) return true;
		return (
			nested &&
			isPlainObject(left) &&
			isPlainObject(right) &&
			shallowEqual(left, right, false)
		);
	});
}

export function reuseUnchangedItems<T extends object>(
	previous: readonly T[],
	next: T[],
): T[] {
	if (previous === next || previous.length === 0) return next;
	let changed = previous.length !== next.length;
	const result = next.map((item, index) => {
		const prior = previous[index];
		if (
			prior !== undefined &&
			(prior === item ||
				shallowEqual(
					prior as Record<string, unknown>,
					item as Record<string, unknown>,
					true,
				))
		)
			return prior;
		changed = true;
		return item;
	});
	return changed ? result : (previous as T[]);
}
