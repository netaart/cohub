export function createSectionState<Id extends string>(
	storageKey: string,
	ids: readonly Id[],
) {
	let collapsed = $state(read());

	function read() {
		const state = Object.fromEntries(ids.map((id) => [id, false])) as Record<
			Id,
			boolean
		>;
		try {
			const value = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
			for (const id of ids) state[id] = value?.[id] === true;
		} catch {}
		return state;
	}

	return {
		get collapsed() {
			return collapsed;
		},
		toggle(id: Id) {
			collapsed = { ...collapsed, [id]: !collapsed[id] };
			try {
				localStorage.setItem(storageKey, JSON.stringify(collapsed));
			} catch {}
		},
	};
}
