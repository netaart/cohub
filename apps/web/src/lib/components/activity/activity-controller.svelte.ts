import { handleUnauthorizedError } from "$lib/auth-redirect";
import { activityRepo } from "$lib/cache/repositories/activity-repo";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

export const ACTIVITY_RANGES = [7, 30, 365] as const;
export type ActivityRange = (typeof ACTIVITY_RANGES)[number];

export type ActivityController<T> = ReturnType<
	typeof createActivityController<T>
>;

export function createActivityController<T>(options: {
	scope: string;
	initialDays: ActivityRange;
	fetch: (days: ActivityRange) => Promise<T>;
}) {
	let selectedDays = $state<ActivityRange>(options.initialDays);
	let activity = $state.raw<T | null>(null);
	let loading = $state(true);
	let refreshing = $state(false);
	let loadError = $state("");
	let requestId = 0;

	async function load({ force = false } = {}) {
		const id = ++requestId;
		const { scope } = options;
		const days = selectedDays;
		loadError = "";

		// Cache failures must never block the network path — degrade to a miss.
		const cached = await activityRepo
			.getCached<T>(scope, days)
			.catch(() => null);
		if (id !== requestId) return;
		if (cached) activity = cached.activity;
		if (!force && cached && activityRepo.isFresh(cached)) {
			loading = false;
			refreshing = false;
			return;
		}
		loading = !activity;
		refreshing = !loading;

		try {
			const data = await options.fetch(days);
			if (id !== requestId) return;
			activity = data;
			void activityRepo.set(scope, days, data);
		} catch (error) {
			if (id !== requestId) return;
			if (await handleUnauthorizedError(error)) return;
			// Keep showing cached data on refresh failures.
			loadError =
				error instanceof Error
					? error.message
					: m.activity_load_failed({}, { locale: getLocale() });
		} finally {
			if (id === requestId) {
				loading = false;
				refreshing = false;
			}
		}
	}

	function selectRange(days: ActivityRange) {
		if (selectedDays === days) return;
		selectedDays = days;
		activity = null;
		void load();
	}

	return {
		get selectedDays() {
			return selectedDays;
		},
		get activity() {
			return activity;
		},
		get loading() {
			return loading;
		},
		get refreshing() {
			return refreshing;
		},
		get loadError() {
			return loadError;
		},
		load,
		selectRange,
	};
}
