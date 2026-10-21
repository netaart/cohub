export function sameJson(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
			return false;
		for (let index = 0; index < a.length; index += 1) {
			if (!sameJson(a[index], b[index])) return false;
		}
		return true;
	}
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	let members = 0;
	for (const key of Object.keys(left)) {
		if (left[key] === undefined) continue;
		members += 1;
		if (!sameJson(left[key], right[key])) return false;
	}
	for (const key of Object.keys(right))
		if (right[key] !== undefined) members -= 1;
	return members === 0;
}
