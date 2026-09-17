<script lang="ts">
import type {
	AppRecord,
	CronJobRecord,
	SpaceRecord,
	TaskRunRecord,
} from "@neta-art/cohub";
import AppView from "./AppView.svelte";
import CheckpointView from "./CheckpointView.svelte";
import CronjobView from "./CronjobView.svelte";
import TaskRunView from "./TaskRunView.svelte";
import type { TaskRealtimeEvent } from "./task-run-detail-controller.svelte";
import { taskTypeLabel } from "./task-run-utils";

type RouteDetailHeaderMeta = {
	view: "checkpoint" | "cronjob" | "app" | "task";
	id: string;
	title: string;
} | null;

export type RouteDetailView =
	| "checkpoint-new"
	| "checkpoint"
	| "cronjob-new"
	| "cronjob"
	| "app"
	| "task";

type RouteDetailContext = {
	view: RouteDetailView;
	checkpointId: string | null;
	cronjobId: string | null;
	appId: string | null;
	taskId: string | null;
};

type Props = {
	route: RouteDetailContext;
	spaceId: string;
	space: SpaceRecord | null;
	spaceLoadError: string;
	spaceHasMinimalAccess: boolean;
	canEditSpace: boolean;
	canPublishApp: boolean;
	taskRealtimeEvent: TaskRealtimeEvent | null;
	ownerUsername: string | null;
	spaceSlug: string | null;
	onHeaderMeta: (meta: RouteDetailHeaderMeta) => void;
	/** Show an app in the workspace window pane. */
	onPreviewApp?: (app: AppRecord) => void;
};

let {
	route,
	spaceId,
	space,
	spaceLoadError,
	spaceHasMinimalAccess,
	canEditSpace,
	canPublishApp,
	taskRealtimeEvent,
	ownerUsername,
	spaceSlug,
	onHeaderMeta,
	onPreviewApp,
}: Props = $props();

const spaceName = $derived(space?.name ?? space?.title ?? spaceId);

function handleCheckpointLoaded(
	checkpoint: { description?: string | null } | null,
) {
	onHeaderMeta(
		checkpoint && route.checkpointId
			? {
					view: "checkpoint",
					id: route.checkpointId,
					title:
						checkpoint.description?.trim() ||
						`Save ${route.checkpointId.slice(0, 8)}`,
				}
			: null,
	);
}

function handleCronjobLoaded(job: CronJobRecord | null) {
	onHeaderMeta(job ? { view: "cronjob", id: job.id, title: job.title } : null);
}

function handleAppLoaded(app: AppRecord | null) {
	onHeaderMeta(app ? { view: "app", id: app.id, title: app.slug } : null);
}

function handleTaskLoaded(run: TaskRunRecord | null) {
	onHeaderMeta(
		run
			? { view: "task", id: run.id, title: taskTypeLabel(run.taskType) }
			: null,
	);
}
</script>

{#if route.view === "checkpoint-new" || route.view === "checkpoint"}
	<CheckpointView
		mode={route.view === "checkpoint-new" ? "create" : "detail"}
		{spaceId}
		{space}
		{spaceLoadError}
		{spaceHasMinimalAccess}
		checkpointId={route.checkpointId}
		onDetailLoaded={handleCheckpointLoaded}
	/>
{:else if route.view === "cronjob-new" || route.view === "cronjob"}
	<CronjobView
		mode={route.view === "cronjob-new" ? "create" : "detail"}
		{spaceId}
		{spaceName}
		{spaceLoadError}
		{spaceHasMinimalAccess}
		cronjobId={route.cronjobId}
		{taskRealtimeEvent}
		onDetailLoaded={handleCronjobLoaded}
	/>
{:else if route.view === "app"}
	<AppView
		{spaceId}
		routeAppId={route.appId}
		{ownerUsername}
		{spaceSlug}
		{canEditSpace}
		{canPublishApp}
		onDetailLoaded={handleAppLoaded}
		{onPreviewApp}
	/>
{:else if route.view === "task"}
	<TaskRunView
		{spaceId}
		taskId={route.taskId}
		{taskRealtimeEvent}
		onDetailLoaded={handleTaskLoaded}
	/>
{/if}
