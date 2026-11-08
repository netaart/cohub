import type { CronJobRecord } from "@neta-art/cohub";
import { sdk } from "$lib/sdk";
import { SpaceListFeed } from "./space-list-feed.svelte";

export const CRONJOBS_UPDATED_EVENT = "cohub:cronjobs-updated";

export class SpaceCronjobsFeed extends SpaceListFeed<CronJobRecord> {
	constructor(spaceId: string) {
		super(spaceId, "cronjobs");
	}

	protected async fetchItems() {
		const { jobs } = await sdk.cronJobs.list(this.spaceId);
		return jobs ?? [];
	}
}

export function dispatchCronjobsUpdated(spaceId: string) {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent(CRONJOBS_UPDATED_EVENT, { detail: { spaceId } }),
	);
}
