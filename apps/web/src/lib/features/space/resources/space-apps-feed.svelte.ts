import type { AppRecord } from "@neta-art/cohub";
import { sortAppsByRecentUpdate } from "$lib/app-sort";
import {
	type AppsChangedDetail,
	createAppMutationBuffer,
	upsertAppSnapshot,
} from "$lib/features/app/app-realtime";
import { sdk } from "$lib/sdk";
import { SpaceListFeed } from "./space-list-feed.svelte";

export class SpaceAppsFeed extends SpaceListFeed<AppRecord> {
	readonly #buffer = createAppMutationBuffer();

	constructor(spaceId: string) {
		super(spaceId, "apps");
	}

	protected async fetchItems() {
		const { apps } = await sdk.apps.listBySpace(this.spaceId);
		return apps ?? [];
	}

	protected beginFetch() {
		this.#buffer.reset();
	}

	protected reconcile(items: AppRecord[]) {
		return sortAppsByRecentUpdate(this.#buffer.apply(items));
	}

	apply(detail: AppsChangedDetail) {
		if (!this.started) return;
		if (detail.app) {
			this.#buffer.upsert(detail.app);
			if (this.ready) this.commit(upsertAppSnapshot(this.items, detail.app));
			return;
		}
		if (detail.deletedAppId) {
			const id = detail.deletedAppId;
			this.#buffer.remove(id);
			if (this.ready) this.commit(this.items.filter((app) => app.id !== id));
			return;
		}
		void this.refresh();
	}
}
