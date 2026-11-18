// Without a viewer, a sync refreshes only cards whose run or chat is in the Board's Space, or that already name it.
export function systemMayShow(home: string, spaceId: string, previous: { spaceId?: string } | undefined): boolean {
	return spaceId === home || previous?.spaceId === spaceId;
}

export function unclaimed(snapshot: Record<string, unknown>): Record<string, unknown> {
	const { spaceId: _, ...rest } = snapshot;
	return rest;
}
