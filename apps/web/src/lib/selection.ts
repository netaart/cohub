export function toggleSelection(
	selected: ReadonlySet<string>,
	id: string,
): Set<string> {
	const next = new Set(selected);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	return next;
}

export function selectRange(
	selected: ReadonlySet<string>,
	orderedIds: readonly string[],
	anchorId: string | null,
	targetId: string,
): Set<string> {
	const next = new Set(selected);
	const from = anchorId ? orderedIds.indexOf(anchorId) : -1;
	const to = orderedIds.indexOf(targetId);
	if (from < 0 || to < 0) {
		next.add(targetId);
		return next;
	}
	const [start, end] = from <= to ? [from, to] : [to, from];
	for (let index = start; index <= end; index += 1) {
		const id = orderedIds[index];
		if (id) next.add(id);
	}
	return next;
}

export function pruneSelection(
	selected: ReadonlySet<string>,
	orderedIds: readonly string[],
): Set<string> {
	if (selected.size === 0) return selected as Set<string>;
	const listed = new Set(orderedIds);
	const next = new Set([...selected].filter((id) => listed.has(id)));
	return next.size === selected.size ? (selected as Set<string>) : next;
}
