import type { RealtimeTaskRecord } from "@cohub/protocol";
import { onMount, untrack } from "svelte";
import {
	APPS_CHANGED_EVENT,
	type AppsChangedDetail,
} from "$lib/features/app/app-realtime";
import { sessionGenerationStore } from "$lib/stores/session-generation.svelte";
import { SpaceAppsFeed } from "../resources/space-apps-feed.svelte";
import {
	CRONJOBS_UPDATED_EVENT,
	SpaceCronjobsFeed,
} from "../resources/space-cronjobs-feed.svelte";
import {
	GenerationFeed,
	ingestGenerationTaskEvent,
} from "./generation-feed.svelte";
import { SessionFilesFeed } from "./session-files.svelte";

type RealtimeEnvelope = {
	type: string;
	spaceId?: string | null;
	sessionId?: string | null;
	payload?: unknown;
};

/** Data behind the side panel; feeds start the first time it is shown. */
export function createWorkspaceSidePanelController(options: {
	getSpaceId: () => string;
	/** Null on the new-chat draft and non-chat routes. */
	getSessionId: () => string | null;
	getCanViewTasks: () => boolean;
	getCanViewFiles: () => boolean;
	getCanViewApps: () => boolean;
	getCanViewCronjobs: () => boolean;
	getVisible: () => boolean;
}) {
	let sessionGenerations = $state.raw<GenerationFeed | null>(null);
	let sessionFiles = $state.raw<SessionFilesFeed | null>(null);
	let spaceGenerations = $state.raw<GenerationFeed | null>(null);
	let apps = $state.raw<SpaceAppsFeed | null>(null);
	let cronjobs = $state.raw<SpaceCronjobsFeed | null>(null);
	let spaceMediaRequested = $state(false);
	let hasBeenVisible = $state(false);
	// Rebuild feeds only when these values change.
	const spaceId = $derived(options.getSpaceId());
	const sessionId = $derived(options.getSessionId());
	const canViewTasks = $derived(options.getCanViewTasks());
	const canViewFiles = $derived(options.getCanViewFiles());
	const canViewApps = $derived(options.getCanViewApps());
	const canViewCronjobs = $derived(options.getCanViewCronjobs());

	$effect(() => {
		if (options.getVisible()) hasBeenVisible = true;
	});

	$effect(() => {
		const feed =
			spaceId && sessionId && canViewTasks
				? new GenerationFeed({ spaceId, sessionId })
				: null;
		sessionGenerations = feed;
		return () => feed?.dispose();
	});

	$effect(() => {
		const feed =
			spaceId && sessionId && canViewFiles
				? new SessionFilesFeed(spaceId, sessionId)
				: null;
		sessionFiles = feed;
		return () => feed?.dispose();
	});

	$effect(() => {
		const feed =
			spaceId && canViewTasks
				? new GenerationFeed({ spaceId, sessionId: null })
				: null;
		spaceGenerations = feed;
		return () => feed?.dispose();
	});

	$effect(() => {
		const feed = spaceId && canViewApps ? new SpaceAppsFeed(spaceId) : null;
		apps = feed;
		untrack(() => feed?.start());
		return () => feed?.dispose();
	});

	$effect(() => {
		const feed =
			spaceId && canViewCronjobs ? new SpaceCronjobsFeed(spaceId) : null;
		cronjobs = feed;
		return () => feed?.dispose();
	});

	onMount(() => {
		const onAppsChanged = (event: Event) => {
			const detail = (event as CustomEvent<AppsChangedDetail>).detail;
			if (apps && detail?.spaceId === apps.spaceId) apps.apply(detail);
		};
		const onCronjobsUpdated = (event: Event) => {
			const detail = (event as CustomEvent<{ spaceId?: string }>).detail;
			if (cronjobs && detail?.spaceId === cronjobs.spaceId)
				void cronjobs.refresh();
		};
		window.addEventListener(APPS_CHANGED_EVENT, onAppsChanged);
		window.addEventListener(CRONJOBS_UPDATED_EVENT, onCronjobsUpdated);
		return () => {
			window.removeEventListener(APPS_CHANGED_EVENT, onAppsChanged);
			window.removeEventListener(CRONJOBS_UPDATED_EVENT, onCronjobsUpdated);
		};
	});

	$effect(() => {
		if (!hasBeenVisible) return;
		const feeds = [sessionGenerations, sessionFiles];
		untrack(() => {
			for (const feed of feeds) feed?.start();
		});
	});

	$effect(() => {
		if (!hasBeenVisible || !spaceMediaRequested) return;
		const feed = spaceGenerations;
		untrack(() => feed?.start());
	});

	$effect(() => {
		const feed = sessionFiles;
		if (!feed || !hasBeenVisible) return;
		const state = sessionGenerationStore.get(feed.sessionId);
		untrack(() => feed.observeStream(state));
	});

	function ingest(envelope: RealtimeEnvelope) {
		const files = sessionFiles;
		if (envelope.type === "task.created" || envelope.type === "task.updated") {
			const payload = envelope.payload as
				| { task?: RealtimeTaskRecord; changed?: string[] }
				| undefined;
			const task = payload?.task;
			if (!task?.id) return;
			ingestGenerationTaskEvent(task, payload?.changed ?? []);
			return;
		}
		if (
			files &&
			envelope.type === "session.turn.finalized" &&
			envelope.sessionId === files.sessionId
		) {
			const turn = (envelope.payload as { turn?: { id?: unknown } } | undefined)
				?.turn;
			files.onTurnFinalized(typeof turn?.id === "string" ? turn.id : null);
		}
	}

	function refresh() {
		if (!hasBeenVisible) return;
		void sessionGenerations?.refresh();
		void sessionFiles?.refresh();
		if (spaceMediaRequested) void spaceGenerations?.refresh();
		void cronjobs?.refresh();
	}

	function showCronjobs() {
		if (!cronjobs) return;
		if (cronjobs.started) void cronjobs.refresh();
		else cronjobs.start();
	}

	return {
		get sessionGenerations() {
			return sessionGenerations;
		},
		get sessionFiles() {
			return sessionFiles;
		},
		get spaceGenerations() {
			return spaceGenerations;
		},
		get apps() {
			return apps;
		},
		get cronjobs() {
			return cronjobs;
		},
		get sessionBusy() {
			return (
				(sessionGenerations?.activeCount ?? 0) > 0 ||
				(sessionFiles?.activeCount ?? 0) > 0
			);
		},
		requestSpaceMedia() {
			spaceMediaRequested = true;
		},
		showCronjobs,
		ingest,
		refresh,
	};
}

export type WorkspaceSidePanelController = ReturnType<
	typeof createWorkspaceSidePanelController
>;
