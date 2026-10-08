import type { SkillCatalogEntry } from "@neta-art/cohub";
import {
	createRefreshCoordinator,
	type RefreshOptions,
} from "$lib/refresh-coordinator";
import { sdk } from "$lib/sdk";
import { readCachedSkills, writeCachedSkills } from "$lib/skill-cache";

export function createSkillController(options: { getSpaceId: () => string }) {
	let items = $state<SkillCatalogEntry[]>([]);
	let loaded = $state(false);
	let loadedFor = $state<string | null>(null);
	const refreshCoordinator = createRefreshCoordinator<string>({
		isCurrent: (targetSpaceId) => options.getSpaceId() === targetSpaceId,
		refresh: async (targetSpaceId) => {
			try {
				const response = await sdk.skills.list({ spaceId: targetSpaceId });
				writeCachedSkills(targetSpaceId, response.skills);
				if (options.getSpaceId() !== targetSpaceId) return;
				items = response.skills;
				loaded = true;
				loadedFor = targetSpaceId;
			} catch (error) {
				console.error("Failed to load skills:", error);
				if (options.getSpaceId() !== targetSpaceId) return;
				// Keep any restored cache; mark loaded so slash menu is not stuck.
				loaded = true;
				loadedFor = targetSpaceId;
			}
		},
	});

	function restore(targetSpaceId: string) {
		const cached = readCachedSkills(targetSpaceId);
		if (!cached) {
			items = [];
			loaded = false;
			loadedFor = null;
			return;
		}
		items = cached;
		loaded = true;
		loadedFor = targetSpaceId;
	}

	async function load(loadOptions: RefreshOptions = {}) {
		const targetSpaceId = options.getSpaceId();
		if (loadedFor !== targetSpaceId) restore(targetSpaceId);
		await refreshCoordinator.refresh(targetSpaceId, loadOptions);
	}

	return {
		get items() {
			return items;
		},
		get loaded() {
			return loaded;
		},
		get loadedFor() {
			return loadedFor;
		},
		load,
		restore,
		refresh: refreshCoordinator.refresh,
	};
}
