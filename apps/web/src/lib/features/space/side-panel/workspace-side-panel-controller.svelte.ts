import type { RealtimeTaskRecord } from "@cohub/protocol";
import { untrack } from "svelte";
import { sessionGenerationStore } from "$lib/stores/session-generation.svelte";
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
	getVisible: () => boolean;
}) {
	let sessionGenerations = $state.raw<GenerationFeed | null>(null);
	let sessionFiles = $state.raw<SessionFilesFeed | null>(null);
	let spaceGenerations = $state.raw<GenerationFeed | null>(null);
	let spaceMediaRequested = $state(false);
	let hasBeenVisible = $state(false);
	// Rebuild feeds only when these values change.
	const spaceId = $derived(options.getSpaceId());
	const sessionId = $derived(options.getSessionId());
	const canViewTasks = $derived(options.getCanViewTasks());
	const canViewFiles = $derived(options.getCanViewFiles());

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
		get sessionBusy() {
			return (
				(sessionGenerations?.activeCount ?? 0) > 0 ||
				(sessionFiles?.activeCount ?? 0) > 0
			);
		},
		requestSpaceMedia() {
			spaceMediaRequested = true;
		},
		ingest,
		refresh,
	};
}

export type WorkspaceSidePanelController = ReturnType<
	typeof createWorkspaceSidePanelController
>;
