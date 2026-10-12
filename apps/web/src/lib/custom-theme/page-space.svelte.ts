let lentSpaceId = $state<string | null>(null);

export function useSpaceTheme(getSpaceId: () => string | null) {
	$effect(() => {
		lentSpaceId = getSpaceId();
		return () => {
			lentSpaceId = null;
		};
	});
}

export function getLentThemeSpace(): string | null {
	return lentSpaceId;
}
