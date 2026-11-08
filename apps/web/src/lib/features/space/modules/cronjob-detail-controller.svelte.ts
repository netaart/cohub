import type { CronJobRecord, TaskRunRecord } from "@neta-art/cohub";
import { untrack } from "svelte";
import { goto } from "$app/navigation";
import {
	type AccessState,
	classifyAccessError,
} from "$lib/access/access-state";
import type { ModelThinkingLevel } from "$lib/model-catalog";
import {
	buildSendMessagePayload,
	defaultTimezone,
	promptTextFromPayload,
	validateCronjobForm,
} from "$lib/resource-kit/cronjob";
import { mergeTaskRunList } from "$lib/resource-kit/task-run";
import { sdk } from "$lib/sdk";
import {
	buildSpaceCronjobRoute,
	buildSpaceNewSessionRoute,
} from "$lib/space-routes";
import { modelsCatalogStore } from "$lib/stores/models-catalog.svelte";
import { mergeCachedCronJobTaskRuns } from "$lib/stores/task-runs-cache";
import { dispatchCronjobsUpdated } from "../resources/space-cronjobs-feed.svelte";
import { createKeyedRouteRequestGuard } from "./route-request-guard";
import type { TaskRealtimeEvent } from "./task-run-detail-controller.svelte";

export type CronjobMode = "create" | "detail";
export type SelectedModel = {
	provider: string;
	id: string;
	name?: string;
	thinkingLevel?: ModelThinkingLevel | null;
};

function cronjobErrorMessage(error: unknown): AccessState {
	return classifyAccessError(error);
}

const taskRunSortTime = (run: Pick<TaskRunRecord, "updatedAt" | "createdAt">) =>
	Date.parse(run.updatedAt ?? run.createdAt ?? "") || 0;

export function createCronjobDetailController(options: {
	getMode: () => CronjobMode;
	getSpaceId: () => string;
	getCronjobId: () => string | null;
	onDetailLoaded?: (job: CronJobRecord | null) => void;
}) {
	const modelsCatalog = $derived(modelsCatalogStore.items);
	const visibleModelsCatalog = $derived(modelsCatalogStore.visibleItems);
	const firstCatalogModel = $derived.by(() => {
		const item = visibleModelsCatalog?.[0];
		return item
			? {
					provider: item.provider,
					id: item.id,
					name: item.model.name as string | undefined,
				}
			: null;
	});

	let detail = $state<CronJobRecord | null>(null);
	let detailLoading = $state(false);
	let detailError = $state<AccessState | null>(null);
	let runs = $state<TaskRunRecord[]>([]);
	let runsLoading = $state(false);
	let runsLoadingMore = $state(false);
	let runsLoaded = $state(false);
	let runsHasMore = $state(false);
	let runsNextCursor = $state<string | null>(null);
	let runsError = $state("");
	let actionInProgress = $state(false);
	let deleteInProgress = $state(false);
	let toggleError = $state("");
	let editMode = $state(false);
	let formTitle = $state("");
	let formExpression = $state("");
	let formTimezone = $state("");
	let formPrompt = $state("");
	let formModel = $state<SelectedModel | null>(null);
	let formStructuredPrompt = $state(false);
	let formSubmitting = $state(false);
	let formError = $state("");
	let copiedId = $state(false);
	let copiedTimer: ReturnType<typeof setTimeout> | null = null;
	let routeStateKey = "";
	let modelSelectorOpen = $state(false);
	let modelSelectorTarget = $state<"new" | "edit">("new");
	let newTitle = $state("");
	let newExpression = $state("");
	let newTimezone = $state(defaultTimezone());
	let newPrompt = $state("");
	let newModel = $state<SelectedModel | null>(null);
	let newSubmitting = $state(false);
	let newError = $state("");

	function notify(job: CronJobRecord | null) {
		options.onDetailLoaded?.(job);
	}

	function modelFromPayload(payload: unknown): SelectedModel | null {
		if (!payload || typeof payload !== "object") return null;
		const record = payload as {
			provider?: unknown;
			model?: unknown;
			thinkingLevel?: unknown;
		};
		if (typeof record.provider !== "string" || typeof record.model !== "string")
			return null;
		const catalogItem = modelsCatalog?.find(
			(item) => item.provider === record.provider && item.id === record.model,
		);
		const thinkingLevel =
			typeof record.thinkingLevel === "string"
				? (record.thinkingLevel as SelectedModel["thinkingLevel"])
				: null;
		return {
			provider: record.provider,
			id: record.model,
			name: catalogItem?.model.name as string | undefined,
			...(thinkingLevel ? { thinkingLevel } : {}),
		};
	}

	function resetRuns() {
		runs = [];
		runsLoaded = false;
		runsLoading = false;
		runsLoadingMore = false;
		runsHasMore = false;
		runsNextCursor = null;
		runsError = "";
	}

	function resetDetailState() {
		detail = null;
		notify(null);
		detailError = null;
		toggleError = "";
		editMode = false;
		actionInProgress = false;
		deleteInProgress = false;
		formError = "";
		resetRuns();
	}

	function resetNewForm() {
		newTitle = "";
		newExpression = "";
		newTimezone = defaultTimezone();
		newPrompt = "";
		newModel = firstCatalogModel;
		newError = "";
	}

	function syncFormFromDetail() {
		if (!detail) return;
		const prompt = promptTextFromPayload(detail.payload);
		formTitle = detail.title;
		formExpression = detail.cronExpression;
		formTimezone = detail.timezone || defaultTimezone();
		formPrompt = prompt.text;
		formStructuredPrompt = prompt.structured;
		formModel = modelFromPayload(detail.payload);
		formError = "";
	}

	function notifyCronjobsUpdated() {
		dispatchCronjobsUpdated(options.getSpaceId());
	}

	async function loadModelsCatalog() {
		try {
			await modelsCatalogStore.load();
		} catch (error) {
			console.error("Failed to load models catalog:", error);
		}
	}

	function openModelSelector(target: "new" | "edit") {
		modelSelectorTarget = target;
		modelSelectorOpen = true;
		void loadModelsCatalog();
		if (target === "new" && !newModel && firstCatalogModel)
			newModel = firstCatalogModel;
	}

	function selectModel(model: {
		provider: string;
		id: string;
		thinkingLevel?: SelectedModel["thinkingLevel"];
	}) {
		const catalogItem = modelsCatalog?.find(
			(item) => item.provider === model.provider && item.id === model.id,
		);
		const selected = {
			provider: model.provider,
			id: model.id,
			name: catalogItem?.model.name as string | undefined,
			...(model.thinkingLevel ? { thinkingLevel: model.thinkingLevel } : {}),
		} satisfies SelectedModel;
		if (modelSelectorTarget === "new") newModel = selected;
		else formModel = selected;
		modelSelectorOpen = false;
	}

	async function loadDetail(targetCronjobId: string) {
		const requestSpaceId = options.getSpaceId();
		const isCurrentRequest = () =>
			options.getSpaceId() === requestSpaceId &&
			options.getMode() === "detail" &&
			options.getCronjobId() === targetCronjobId;
		detailLoading = true;
		detailError = null;
		toggleError = "";
		try {
			const { job } = await sdk.cronJobs.get(targetCronjobId);
			if (!isCurrentRequest()) return;
			detail = job;
			notify(job);
			syncFormFromDetail();
		} catch (error) {
			if (!isCurrentRequest()) return;
			detail = null;
			notify(null);
			detailError = cronjobErrorMessage(error);
		} finally {
			if (isCurrentRequest()) detailLoading = false;
		}
	}

	async function loadRuns(input: { reset?: boolean } = {}) {
		const cronjobId = options.getCronjobId();
		if (!detail || !cronjobId) return;
		if (runsLoading || runsLoadingMore) return;
		const requestCronjobId = detail.id;
		if (requestCronjobId !== cronjobId) return;
		const guard = createKeyedRouteRequestGuard({
			captureKey: () =>
				`${options.getSpaceId()}:${options.getMode()}:${options.getCronjobId() ?? ""}`,
		});
		const reset = input.reset ?? !runsLoaded;
		const cursor = reset ? null : runsNextCursor;
		if (!reset && !runsHasMore) return;
		if (reset) runsLoading = true;
		else runsLoadingMore = true;
		runsError = "";
		try {
			const { runs: nextRuns, pageInfo } = await sdk.cronJobs.runs(
				requestCronjobId,
				{ limit: 20, cursor },
			);
			if (!guard.isCurrent()) return;
			runs = reset
				? nextRuns
				: [
						...runs,
						...nextRuns.filter(
							(run) => !runs.some((item) => item.id === run.id),
						),
					];
			runs = [...runs].sort((a, b) => taskRunSortTime(b) - taskRunSortTime(a));
			runsHasMore = pageInfo.hasMore;
			runsNextCursor = pageInfo.nextCursor;
			runsLoaded = true;
			mergeCachedCronJobTaskRuns(
				options.getSpaceId(),
				requestCronjobId,
				nextRuns,
			);
		} catch (error) {
			if (!guard.isCurrent()) return;
			runsError =
				error instanceof Error ? error.message : "Failed to load runs";
		} finally {
			if (guard.isCurrent()) {
				runsLoading = false;
				runsLoadingMore = false;
			}
		}
	}

	async function toggle(enabled: boolean) {
		if (!detail || actionInProgress) return;
		actionInProgress = true;
		try {
			const { job } = await sdk.cronJobs.toggle(detail.id, enabled);
			detail = job;
			notify(job);
			notifyCronjobsUpdated();
			syncFormFromDetail();
		} catch (error) {
			toggleError = error instanceof Error ? error.message : "Failed to toggle";
			void loadDetail(detail.id);
		} finally {
			actionInProgress = false;
		}
	}

	async function deleteCronjob() {
		if (
			!detail ||
			actionInProgress ||
			deleteInProgress ||
			!confirm("Are you sure you want to delete this scheduled prompt?")
		)
			return;
		const deletedCronjobId = detail.id;
		actionInProgress = true;
		deleteInProgress = true;
		detailError = null;
		toggleError = "";
		try {
			await sdk.cronJobs.delete(deletedCronjobId);
			detail = null;
			notify(null);
			runs = [];
			notifyCronjobsUpdated();
			await goto(buildSpaceNewSessionRoute(options.getSpaceId()), {
				replaceState: true,
			});
		} catch (error) {
			detailError = {
				kind: "error",
				message: error instanceof Error ? error.message : "Failed to delete",
			};
			actionInProgress = false;
			deleteInProgress = false;
		}
	}

	async function submitUpdate(event: SubmitEvent) {
		event.preventDefault();
		if (!detail || formSubmitting) return;
		const error = validateCronjobForm({
			title: formTitle,
			cronExpression: formExpression,
			timezone: formTimezone,
			prompt: formPrompt,
		});
		if (error) {
			formError = error;
			return;
		}
		formSubmitting = true;
		formError = "";
		try {
			const { job } = await sdk.cronJobs.update(detail.id, {
				title: formTitle.trim(),
				cronExpression: formExpression.trim(),
				timezone: formTimezone.trim(),
				payload: buildSendMessagePayload(detail.payload, formPrompt, formModel),
			});
			detail = job;
			notify(job);
			editMode = false;
			syncFormFromDetail();
			notifyCronjobsUpdated();
		} catch (error) {
			formError = error instanceof Error ? error.message : "Failed to save";
		} finally {
			formSubmitting = false;
		}
	}

	async function submitCreate(event: SubmitEvent) {
		event.preventDefault();
		if (newSubmitting) return;
		const error = validateCronjobForm({
			title: newTitle,
			cronExpression: newExpression,
			timezone: newTimezone,
			prompt: newPrompt,
		});
		if (error) {
			newError = error;
			return;
		}
		newSubmitting = true;
		newError = "";
		try {
			const response = await sdk.space(options.getSpaceId()).prompt({
				title: newTitle.trim(),
				content: [{ type: "text", text: newPrompt.trim() }],
				provider: newModel?.provider ?? null,
				model: newModel?.id ?? null,
				...(newModel?.thinkingLevel
					? { thinkingLevel: newModel.thinkingLevel }
					: {}),
				schedule: {
					mode: "repeat",
					cronExpression: newExpression.trim(),
					timezone: newTimezone.trim(),
				},
			});
			if (response.mode !== "repeat")
				throw new Error("Failed to create scheduled prompt");
			notifyCronjobsUpdated();
			await goto(
				buildSpaceCronjobRoute(options.getSpaceId(), response.cronJobId),
			);
		} catch (error) {
			newError =
				error instanceof Error
					? error.message
					: "Failed to create scheduled prompt";
		} finally {
			newSubmitting = false;
		}
	}

	async function copyId(id: string) {
		try {
			await navigator.clipboard.writeText(id);
			copiedId = true;
			if (copiedTimer) clearTimeout(copiedTimer);
			copiedTimer = setTimeout(() => {
				copiedId = false;
			}, 1600);
		} catch {
			// Clipboard API can fail in non-secure contexts or due to permissions
		}
	}

	function applyTaskRealtime(payload: TaskRealtimeEvent["payload"]) {
		const eventPayload = payload.payload as {
			task?: Partial<TaskRunRecord> & {
				id?: string;
				type?: string;
				userId?: string | null;
			};
		};
		const task = eventPayload.task;
		if (!task?.id || !task.cronJobId || task.cronJobId !== detail?.id) return;
		runs = mergeTaskRunList(
			runs,
			{
				...(task as Partial<TaskRunRecord>),
				id: task.id,
				type: task.type,
				userId: task.userId,
			},
			options.getSpaceId(),
		);
		runsLoaded = true;
	}

	function syncRoute() {
		const mode = options.getMode();
		const cronjobId = options.getCronjobId();
		const stateKey = `${options.getSpaceId()}:${mode}:${cronjobId ?? ""}`;
		if (routeStateKey === stateKey) return;
		routeStateKey = stateKey;
		if (mode === "detail" && cronjobId) {
			// Clear stale detail immediately so parent callbacks don't see old data
			detail = null;
			notify(null);
			resetRuns();
			editMode = false;
			toggleError = "";
			void loadDetail(cronjobId);
			return;
		}
		resetDetailState();
		if (mode === "create") resetNewForm();
	}

	function applyRealtimeEvent(event: TaskRealtimeEvent | null | undefined) {
		if (!event || event.spaceId !== options.getSpaceId()) return;
		untrack(() => applyTaskRealtime(event.payload));
	}

	function maybeAutoLoadRuns(el: HTMLElement | null) {
		if (options.getMode() !== "detail" || !detail || runsLoaded || !el)
			return undefined;
		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				observer.disconnect();
				void loadRuns({ reset: true });
			},
			{ rootMargin: "240px" },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}

	function dispose() {
		if (copiedTimer) clearTimeout(copiedTimer);
		copiedTimer = null;
	}

	return {
		get modelsCatalog() {
			return modelsCatalog;
		},
		get detail() {
			return detail;
		},
		get detailLoading() {
			return detailLoading;
		},
		get detailError() {
			return detailError;
		},
		get runs() {
			return runs;
		},
		get runsLoading() {
			return runsLoading;
		},
		get runsLoadingMore() {
			return runsLoadingMore;
		},
		get runsLoaded() {
			return runsLoaded;
		},
		get runsHasMore() {
			return runsHasMore;
		},
		get runsError() {
			return runsError;
		},
		get actionInProgress() {
			return actionInProgress;
		},
		get deleteInProgress() {
			return deleteInProgress;
		},
		get toggleError() {
			return toggleError;
		},
		get editMode() {
			return editMode;
		},
		set editMode(value: boolean) {
			editMode = value;
		},
		get formTitle() {
			return formTitle;
		},
		set formTitle(value: string) {
			formTitle = value;
		},
		get formExpression() {
			return formExpression;
		},
		set formExpression(value: string) {
			formExpression = value;
		},
		get formTimezone() {
			return formTimezone;
		},
		set formTimezone(value: string) {
			formTimezone = value;
		},
		get formPrompt() {
			return formPrompt;
		},
		set formPrompt(value: string) {
			formPrompt = value;
		},
		get formModel() {
			return formModel;
		},
		set formModel(value: SelectedModel | null) {
			formModel = value;
		},
		get formStructuredPrompt() {
			return formStructuredPrompt;
		},
		get formSubmitting() {
			return formSubmitting;
		},
		get formError() {
			return formError;
		},
		get copiedId() {
			return copiedId;
		},
		get modelSelectorOpen() {
			return modelSelectorOpen;
		},
		set modelSelectorOpen(value: boolean) {
			modelSelectorOpen = value;
		},
		get newTitle() {
			return newTitle;
		},
		set newTitle(value: string) {
			newTitle = value;
		},
		get newExpression() {
			return newExpression;
		},
		set newExpression(value: string) {
			newExpression = value;
		},
		get newTimezone() {
			return newTimezone;
		},
		set newTimezone(value: string) {
			newTimezone = value;
		},
		get newPrompt() {
			return newPrompt;
		},
		set newPrompt(value: string) {
			newPrompt = value;
		},
		get newModel() {
			return newModel;
		},
		set newModel(value: SelectedModel | null) {
			newModel = value;
		},
		get newSubmitting() {
			return newSubmitting;
		},
		get newError() {
			return newError;
		},
		syncFormFromDetail,
		openModelSelector,
		selectModel,
		loadRuns,
		toggle,
		deleteCronjob,
		submitUpdate,
		submitCreate,
		copyId,
		syncRoute,
		applyRealtimeEvent,
		maybeAutoLoadRuns,
		dispose,
	};
}
