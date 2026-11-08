import type {
	DisplayLoggedStep,
	DisplayPlanLog,
	DisplayRecordingMeta,
} from "@neta-art/cohub";
import { displayReplaysRepo } from "$lib/cache/repositories/display-replays-repo";
import { sdk } from "$lib/sdk";

export type DisplayChapter = {
	at: number;
	plan: DisplayPlanLog;
	step: DisplayLoggedStep;
	index: number;
};

export function chaptersOf(plans: readonly DisplayPlanLog[]): DisplayChapter[] {
	return plans
		.flatMap((plan) =>
			plan.steps.map((step, index) => ({ at: step.at, plan, step, index })),
		)
		.sort((a, b) => a.at - b.at);
}

export function chapterAt(chapters: readonly DisplayChapter[], at: number) {
	let found = -1;
	for (const [index, chapter] of chapters.entries()) {
		if (chapter.at > at) break;
		found = index;
	}
	return found;
}

async function cachedThenFresh<T>(
	spaceId: string,
	scope: string,
	fetch: () => Promise<T>,
	apply: (value: T, fresh: boolean) => void,
) {
	const cached = await displayReplaysRepo.get<T>(spaceId, scope);
	if (cached) apply(cached, false);
	try {
		const fresh = await fetch();
		apply(fresh, true);
		void displayReplaysRepo.set(spaceId, scope, fresh);
	} catch (error) {
		if (!cached) throw error;
	}
}

export function loadRecordings(
	spaceId: string,
	apply: (recordings: DisplayRecordingMeta[], fresh: boolean) => void,
) {
	return cachedThenFresh(
		spaceId,
		"recordings",
		() => sdk.space(spaceId).displays.recordings(),
		apply,
	);
}

export function loadTurnSteps(
	spaceId: string,
	turnId: string,
	apply: (plans: DisplayPlanLog[], fresh: boolean) => void,
) {
	return cachedThenFresh(
		spaceId,
		`steps:${turnId}`,
		() => sdk.space(spaceId).displays.steps(turnId),
		apply,
	);
}

export function formatClock(ms: number) {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const rest = String(seconds % 60).padStart(2, "0");
	return hours
		? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
		: `${minutes}:${rest}`;
}
