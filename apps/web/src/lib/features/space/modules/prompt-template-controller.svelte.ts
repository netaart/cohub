import type { PromptTemplateCatalogEntry } from "@neta-art/cohub";
import {
	readCachedPromptTemplates,
	writeCachedPromptTemplates,
} from "$lib/prompt-template-cache";
import {
	createRefreshCoordinator,
	type RefreshOptions,
} from "$lib/refresh-coordinator";
import { sdk } from "$lib/sdk";

export type PromptQuickAction = {
	name: string;
	label: string;
	description: string;
	/** When set, the prompt expects arguments and the button prefills the composer instead of sending. */
	argumentHint: string | null;
};

export function createPromptTemplateController(options: {
	getSpaceId: () => string;
}) {
	let items = $state<PromptTemplateCatalogEntry[]>([]);
	let loaded = $state(false);
	let loadedFor = $state<string | null>(null);
	const refreshCoordinator = createRefreshCoordinator<string>({
		isCurrent: (targetSpaceId) => options.getSpaceId() === targetSpaceId,
		refresh: async (targetSpaceId) => {
			try {
				const response = await sdk.prompts.list({ spaceId: targetSpaceId });
				writeCachedPromptTemplates(targetSpaceId, response.prompts);
				if (options.getSpaceId() !== targetSpaceId) return;
				items = response.prompts;
				loaded = true;
				loadedFor = targetSpaceId;
			} catch (error) {
				console.error("Failed to load prompt templates:", error);
			}
		},
	});

	function restore(targetSpaceId: string) {
		const cached = readCachedPromptTemplates(targetSpaceId);
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

	const quickActions = $derived<PromptQuickAction[]>(
		items
			.filter((item) => item.quickAction)
			.slice()
			.sort((a, b) => {
				const orderDelta = (a.order ?? 0) - (b.order ?? 0);
				if (orderDelta !== 0) return orderDelta;
				return a.name.localeCompare(b.name);
			})
			.map((item) => ({
				name: item.name,
				label: item.buttonLabel?.trim() || item.description || item.name,
				description: item.description,
				argumentHint: item.argumentHint?.trim() || null,
			})),
	);

	return {
		get items() {
			return items;
		},
		get quickActions() {
			return quickActions;
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
