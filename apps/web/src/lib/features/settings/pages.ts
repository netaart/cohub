import type { Component } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import type { SettingsSection } from "$lib/settings-nav";

type SettingsPage = Component;

const loaders: Record<
	SettingsSection,
	() => Promise<{ default: SettingsPage }>
> = {
	general: () => import("./GeneralSettings.svelte"),
	activity: () => import("./ActivitySettings.svelte"),
	referrals: () => import("./ReferralsSettings.svelte"),
	billing: () => import("./BillingSettings.svelte"),
	rules: () => import("./RulesSettings.svelte"),
	channels: () => import("./ChannelsSettings.svelte"),
};

const pages = new SvelteMap<SettingsSection, SettingsPage>();
const pending = new Map<SettingsSection, Promise<SettingsPage>>();

export function settingsPage(section: SettingsSection): SettingsPage | null {
	return pages.get(section) ?? null;
}

export function loadSettingsPage(
	section: SettingsSection,
): Promise<SettingsPage> {
	const page = pages.get(section);
	if (page) return Promise.resolve(page);
	let request = pending.get(section);
	if (!request) {
		request = loaders[section]()
			.then(({ default: loaded }) => {
				pages.set(section, loaded);
				return loaded;
			})
			.finally(() => pending.delete(section));
		pending.set(section, request);
	}
	return request;
}
