import { getContext, setContext, untrack } from "svelte";

const KEY = Symbol("settings-page");

export function provideSettingsPageActive(active: () => boolean) {
	setContext(KEY, active);
}

export function settingsPageActive(): () => boolean {
	return getContext<(() => boolean) | undefined>(KEY) ?? (() => true);
}

export function onSettingsPageActive(refresh: () => void) {
	const active = settingsPageActive();
	$effect(() => {
		if (active()) untrack(refresh);
	});
}
